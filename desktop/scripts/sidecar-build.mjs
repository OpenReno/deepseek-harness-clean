#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// sidecar-build.mjs — assemble the dsh-runtime bundle that the Tauri shell
// spawns as its Node child. The Tauri shell itself is OS-only; this script
// produces the upstream-side payload (built CLI + web dist + bundled Node and
// Python).
//
// Outputs land under desktop/{dsh-runtime,apps/web/dist,node,python} and are
// matched by src-tauri/tauri.conf.json bundle.resources. .gitignore keeps
// them out of git — they're regenerable.
//
// Usage:
//   node scripts/sidecar-build.mjs          # full bundle (production)
//   node scripts/sidecar-build.mjs --dev    # dsh-runtime (source copy) + web dist
//   node scripts/sidecar-build.mjs --stage  # only build upstream + pnpm deploy
//                                          # → leaves desktop/.deploy/ on disk
//                                          # (saves ~4 GB transient: peak disk
//                                          # usage is at this step)
//   node scripts/sidecar-build.mjs --finalize
//                                          # skip build; assume .deploy/ exists,
//                                          # copy → dsh-runtime + Node + Python
//                                          # + vite. Combine with --stage to
//                                          # split the run across disk cycles.
//
// Phases:
//   0. (production only) Build upstream CLI for bundling — `pnpm install
//      --ignore-scripts` to link deps without lefthook postinstall, then
//      `pnpm exec tsc -b tsconfig.host.json` + `pnpm exec tsdown --env
//      .DSH_BUILD_FACE host` to compile + emit Typert codegen, then
//      `pnpm deploy --prod --legacy` to drop the self-contained CLI into a
//      staging dir. dev mode skips this and relies on host.rs's dev-fallback
//      (which spawns the upstream source directly with tsx + NODE_PATH).
//   1. Stage the deploy dir under desktop/dsh-runtime/ via cp -rL (cyclic-
//      symlink safe).
//   2. Build apps/web/dist (vite build).
//   3. (skipped in --dev) Download a portable Node.js runtime into desktop/node/.
//   4. (skipped in --dev) Download a portable Python runtime into desktop/python/.
//
// Disk note: the `pnpm deploy` staging dir is ~4 GB (it materializes the
// entire workspace dep tree as real files). On a tight disk, run
// `--stage` to land it in `desktop/.deploy/`, free space, then run
// `--finalize` to copy + run Phases 2/3/4. The two flags are independent
// so the user controls when peak disk usage happens.
//
// The Tauri shell expects:
//   desktop/dsh-runtime/bin.ts              ← built CLI entry (hoisted from
//                                            apps/cli/src/bin.ts)
//   desktop/dsh-runtime/src                ← other CLI sources (transitively
//                                            imported by bin.ts)
//   desktop/dsh-runtime/node_modules        ← bundled workspace deps
//   desktop/dsh-runtime/config              ← CLI config defaults
//   desktop/dsh-runtime/package.json        ← CLI manifest
//   desktop/apps/web/dist                   ← frontend assets served by CLI
//   desktop/node/node.exe                   ← Node runtime (Windows)
//   desktop/node/node                       ← Node runtime (POSIX, in bin/)
//   desktop/python/python.exe               ← Python runtime (Windows)
//   desktop/python/bin/python3              ← Python runtime (POSIX)

import { existsSync } from 'node:fs'
import { cp, mkdir, rm } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const desktopDir = path.resolve(__dirname, '..')
const repoRoot = path.resolve(desktopDir, '..')

const isDev = process.argv.includes('--dev')
const isStage = process.argv.includes('--stage')
const isFinalize = process.argv.includes('--finalize')
// Default: run both stages. --stage: only upstream build + pnpm deploy.
// --finalize: only copy + vite + Node + Python. Combine to split disk peaks.

/** Pretty-print a step header. */
function step(msg) {
  console.log(`\n\x1b[1m→\x1b[0m ${msg}`)
}

/** Run a command, inheriting stdio. Returns a promise that resolves on exit-0.
 *
 * On Windows, `.cmd` / `.bat` shims (e.g. `pnpm.cmd`) can't be invoked
 * directly: Node 18+ blocks them with EINVAL for security (CVE-2024-27980),
 * and a `shell:true` workaround breaks when the binary path contains
 * spaces (e.g. `C:\Program Files\Git\...`). The reliable fix is to wrap
 * the spawn in `cmd.exe /d /s /c <cmd> <args...>`, which is what `shell:true`
 * does internally — but explicit, with `windowsVerbatimArguments:true` so
 * Node hands the command line to cmd.exe unmodified. The `windowsHide:true`
 * flag suppresses the flash of a console window on Windows GUI apps.
 */
function run(cmd, args, opts = {}) {
  const { viaShell = false, ...rest } = opts
  const isWin = process.platform === 'win32'
  const lower = cmd.toLowerCase()
  const needsCmdWrapper = isWin && (lower.endsWith('.cmd') || lower.endsWith('.bat'))
  if (needsCmdWrapper) {
    return new Promise((resolve, reject) => {
      const child = spawn('cmd.exe', ['/d', '/s', '/c', cmd, ...args], {
        stdio: 'inherit',
        windowsHide: true,
        ...rest,
      })
      child.on('error', reject)
      child.on('exit', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`cmd.exe /c ${cmd} ${args.join(' ')} exited with ${code}`))
      })
    })
  }
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', shell: viaShell, ...rest })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} ${args.join(' ')} exited with ${code}`))
    })
  })
}

/** Resolve pnpm to its real executable path. On Windows pnpm is normally
 * installed as `pnpm.cmd` (npm-style shim); Node's `spawn(..., {shell:false})`
 * would not find it through PATH because it looks for `pnpm.exe`. `where`
 * (Windows) / `which` (POSIX) returns the shim's real path so we can hand a
 * concrete file to spawn — this also keeps shell metacharacters in args from
 * being interpreted, so we can keep `shell:false` everywhere.
 *
 * Throws if pnpm isn't on PATH so the failure mode is loud rather than the
 * silent ENOENT spawn returned without this lookup.
 */
function resolvePnpm() {
  const cmd = process.platform === 'win32' ? 'where' : 'which'
  try {
    const out = spawnSync(cmd, ['pnpm'], { encoding: 'utf8' })
    if (out.status !== 0) {
      throw new Error(`${cmd} pnpm exited ${out.status}: ${out.stderr}`)
    }
    // `where` may return multiple matches (shim + bundled); first is the
    // user's PATH winner.
    const first = out.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean)
    if (!first) throw new Error('empty resolution')
    // On Windows `where` strips PATHEXT — it prints `C:\...\pnpm` even when
    // the file is `pnpm.cmd`. Worse, with a `nvm-windows`/Git Bash layout,
    // the no-extension `pnpm` is a POSIX shell script that Node can't exec
    // (no shebang handler). We MUST probe in order: Windows-native `.cmd` /
    // `.bat` first (executable by Node), then `.exe`, then the no-extension
    // path only as a last resort (which on Windows means it's a missing
    // installation).
    if (process.platform === 'win32') {
      for (const ext of ['.cmd', '.bat', '.exe']) {
        const candidate = first + ext
        if (existsSync(candidate)) return candidate
      }
      if (existsSync(first)) {
        // The no-extension file exists; only safe to return it on POSIX.
        if (process.platform !== 'win32') return first
      }
      throw new Error(
        `${first} resolves to a non-executable file (likely a POSIX shell script on Windows). `
        + `Install pnpm via the npm CLI so a real pnpm.cmd exists.`,
      )
    }
    return first
  } catch (err) {
    throw new Error(
      `pnpm not found on PATH (${err.message}). Install with: npm i -g pnpm`,
    )
  }
}

/**
 * Download a URL to a local file with a progress bar. Returns the file path.
 * Streams the body so the peak memory is small even for 80 MB runtimes.
 */
async function downloadTo(url, dest, label) {
  console.log(`   fetching ${label}: ${url}`)
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`${label} download failed: HTTP ${res.status} ${res.statusText} for ${url}`)
  }
  const total = Number(res.headers.get('content-length') ?? 0)
  let received = 0
  let lastTick = 0
  const stream = res.body
  const sink = createWriteStream(dest)
  // Wrap the readable with a counter so we can print progress every ~250 ms.
  const tracked = new ReadableStream({
    async pull(controller) {
      const reader = stream.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          controller.close()
          return
        }
        received += value.byteLength
        const now = Date.now()
        if (total > 0 && now - lastTick > 250) {
          const pct = Math.floor((received / total) * 100)
          process.stdout.write(`\r   ${label}: ${pct}% (${(received / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MiB)`)
          lastTick = now
        }
        controller.enqueue(value)
      }
    },
  })
  await pipeline(Readable.fromWeb(tracked), sink)
  if (total > 0) process.stdout.write('\n')
  return dest
}

/**
 * Phase 0a — install upstream workspace deps without postinstall scripts.
 *
 * Upstream's `install-lefthook.mjs` (root postinstall) imports the
 * `lefthook` package as a JSON-import side-effect — the import runs before
 * its `if (CI === 'true') return` guard, so even CI-mode pnpm exits 1 with
 * `ERR_MODULE_NOT_FOUND` when `lefthook` is dev-skipped. `--ignore-scripts`
 * sidesteps that entirely; we then rely on the user's `pnpm install`
 * having already run on this workspace, or run it ourselves here if the
 * workspace hasn't been initialized.
 */
async function ensureWorkspaceInstalled(pnpm) {
  const nodeModules = path.join(repoRoot, 'node_modules')
  if (existsSync(nodeModules)) {
    console.log('   workspace already installed; skipping pnpm install')
    return
  }
  console.log('   workspace missing node_modules; running pnpm install --ignore-scripts')
  await run(pnpm, ['install', '--frozen-lockfile', '--ignore-scripts'], {
    cwd: repoRoot,
    env: { ...process.env, CI: 'true' },
  })
}

/**
 * Phase 0b — compile the upstream TypeScript that the deploy step bundles.
 * Replaces the previous (broken) `pnpm run --filter ... build:lib:host`
 * invocation, which triggered an internal install check that ran the
 * root postinstall (lefthook) and failed. `pnpm exec` does NOT trigger
 * that check, so we run the same two commands upstream's package.json
 * declares — `tsc -b` + `tsdown --env.DSH_BUILD_FACE host` — without the
 * install-lifecycle side trip.
 *
 * The order matters: `tsdown` is what emits Typert's `lib/typert
 * .remote-client.{js,d.ts}` (via the typertPlugin registered in the
 * root tsdown.config.ts). Until that runs, downstream packages' `./remote`
 * subpath imports fail with TS2307 and cascade into 39 TS errors. See
 * `.agents/notes/implemented/architecture/2026-08-02-typert-remote-method-calls.md`.
 */
async function buildUpstreamTs(pnpm) {
  step('0. Compiling upstream TypeScript (tsc -b + tsdown host)…')
  await ensureWorkspaceInstalled(pnpm)

  await run(pnpm, ['exec', 'tsc', '-b', 'tsconfig.host.json'], {
    cwd: repoRoot,
    env: { ...process.env, CI: 'true' },
  })
  await run(pnpm, ['exec', 'tsdown', '--env.DSH_BUILD_FACE', 'host'], {
    cwd: repoRoot,
    env: { ...process.env, CI: 'true' },
  })
}

/**
 * Phase 0c — `pnpm deploy` to drop the CLI + workspace deps into a flat,
 * self-contained staging dir. Uses `--legacy` (pnpm 10+ otherwise requires
 * the deployed package to declare `inject-workspace-packages=true`, which
 * upstream's apps/cli doesn't) and `--prod` to strip devDependencies.
 * CI=true keeps pnpm's interactive "remove modules dir?" prompt from
 * aborting under non-TTY spawn.
 */
async function deployUpstreamCli(pnpm) {
  step('0. Deploying apps/cli into a self-contained bundle (pnpm deploy)…')
  const deployDir = path.join(desktopDir, '.deploy', 'cli')
  await rm(deployDir, { recursive: true, force: true })

  // pnpm 11 syntax: `pnpm --filter=<pkg> deploy <target-dir> [--prod]`.
  // The target dir is a positional arg, NOT `--target`.
  await run(pnpm, [
    '--filter', '@deepseek-ai/dsh',
    'deploy', deployDir,
    '--prod',
    '--legacy',
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CI: 'true',
      LEFTHOOK: '0',
      pnpm_config_confirm_modules_purge: 'false',
      npm_config_confirm_modules_purge: 'false',
    },
  })
  return deployDir
}

/**
 * Resolve a platform+arch tuple to Node.js archive names. Node ships its
 * release archives named `node-v{ver}-{platform}-{arch}.{ext}`:
 *   win-x64.zip, win-arm64.zip
 *   darwin-x64.tar.gz, darwin-arm64.tar.gz
 *   linux-x64.tar.xz, linux-arm64.tar.xz
 */
function nodeArchiveTarget() {
  const platform = process.platform // 'win32' | 'darwin' | 'linux'
  const arch = process.arch // 'x64' | 'arm64' | 'ia32'
  if (!['win32', 'darwin', 'linux'].includes(platform)) {
    throw new Error(`unsupported Node platform: ${platform}`)
  }
  if (!['x64', 'arm64'].includes(arch)) {
    throw new Error(`unsupported Node arch: ${arch}`)
  }
  const nodePlatform = platform === 'win32' ? 'win' : platform
  const ext = platform === 'win32' ? 'zip' : (arch === 'x64' && platform === 'linux' ? 'tar.xz' : 'tar.gz')
  return { nodePlatform, arch, ext }
}

/**
 * Discover the latest 22.x.x release from nodejs.org/dist/index.json. We pin
 * to the 22 LTS line because the upstream `engines.node` requires
 * `^22.19.0 || >=24.0.0`; 22 is the longer-supported line as of 2026-08.
 */
async function latestNode22() {
  const res = await fetch('https://nodejs.org/dist/index.json')
  if (!res.ok) throw new Error(`nodejs.org/dist/index.json returned ${res.status}`)
  const rows = await res.json()
  // rows look like { version: 'v22.19.0', date: '...', lts: 'Jod', ... }
  const v22 = rows
    .filter((r) => r.lts === 'Jod' || /^v22\./.test(r.version))
    .sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }))
  if (v22.length === 0) throw new Error('no Node 22.x release found in index.json')
  return v22[v22.length - 1].version // e.g. 'v22.19.0'
}

/**
 * Extract a Node archive into `intoDir`. The archive root is `node-v…/` with
 * everything inside, so we strip that top directory.
 */
async function extractNodeArchive(archivePath, intoDir) {
  const { ext } = nodeArchiveTarget()
  await mkdir(intoDir, { recursive: true })
  if (ext === 'zip') {
    await extractZip(archivePath, intoDir)
    // Expand-Archive and unzip both keep the `node-vX.Y.Z-<platform>-<arch>`
    // top directory; move its contents up one level so the binary lands at
    // `target/node.exe` (Windows) or `target/bin/node` (POSIX).
    await flattenSingleSubdir(intoDir)
  } else {
    // POSIX tar handles both .tar.gz and .tar.xz out of the box.
    await run('tar', ['-xf', archivePath, '-C', intoDir, '--strip-components=1'])
  }
}

/**
 * Extract a .zip file. Strategy mirrors VSCode's terminal fallback chain —
 * try the friendliest tool first, fall back to whatever the platform ships:
 *
 *   1. `unzip` on PATH       — POSIX + Git Bash for Windows (Info-ZIP). The
 *                              friendliest CLI: short flags, sensible defaults.
 *   2. PowerShell Expand-Archive — universal on Windows 7+ as a last resort.
 *      PowerShell is slow, garbles non-ASCII paths, and inherits the user's
 *      profile, so we keep it as a fallback rather than the default.
 *
 * GNU tar 1.35 (the one Git Bash ships) silently fails on zip — confirmed
 * empirically: `tar -xaf file.zip` returns "This does not look like a tar
 * archive" with exit 2. So we don't list tar in the chain.
 */
async function extractZip(archivePath, intoDir) {
  const quotePsPath = (p) => p.replace(/'/g, "''")
  try {
    await run('unzip', ['-q', '-o', archivePath, '-d', intoDir])
    return
  } catch (err) {
    if (process.platform !== 'win32') {
      throw new Error(
        `unzip is not on PATH and no zip extractor is bundled for ${process.platform}. `
        + `Install unzip (apt install unzip / brew install unzip) or set PATH to include it.`,
      )
    }
    // PowerShell fallback for plain Windows shells (no Git Bash, no MSYS).
    console.log(`   unzip unavailable (${err.message.split('\n')[0]}); falling back to PowerShell`)
    await run('powershell', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath '${quotePsPath(archivePath)}' `
        + `-DestinationPath '${quotePsPath(intoDir)}' -Force`,
    ])
  }
}

/**
 * Stage — `pnpm deploy` + (optional) build, leaves desktop/.deploy/ on disk.
 * Split from finalizeDshRuntime so the user can free disk space between
 * the ~4 GB staging write and the ~4 GB cp -rL copy. On a tight disk:
 *   node scripts/sidecar-build.mjs --stage        # builds .deploy/, exit
 *   # clean up other stuff, then:
 *   node scripts/sidecar-build.mjs --finalize     # cp .deploy → dsh-runtime
 */
async function stageUpstreamLibs(pnpm) {
  if (isDev) {
    // Dev: copy upstream source straight into dsh-runtime/ (host.rs's dev
    // context uses it). No .deploy/ intermediate needed.
    const target = path.join(desktopDir, 'dsh-runtime')
    await rm(target, { recursive: true, force: true })
    await mkdir(target, { recursive: true })
    step('0. Staging upstream CLI source under dsh-runtime/ (dev)…')
    const cliDir = path.join(repoRoot, 'apps', 'cli')
    await cp(path.join(cliDir, 'src', 'bin.ts'), path.join(target, 'bin.ts'))
    await cp(path.join(cliDir, 'src'), path.join(target, 'src'), { recursive: true })
    await cp(path.join(cliDir, 'config'), path.join(target, 'config'), { recursive: true })
    await cp(path.join(cliDir, 'package.json'), path.join(target, 'package.json'))
    await mkdir(path.join(target, 'lib'), { recursive: true })
    await mkdir(path.join(target, 'node_modules'), { recursive: true })
    console.log(`   staged at ${path.relative(repoRoot, target)}`)
    return
  }

  await buildUpstreamTs(pnpm)
  await deployUpstreamCli(pnpm)
  // NB: we deliberately do NOT cp -rL here — that belongs to --finalize.
  console.log(`   staged at ${path.relative(repoRoot, path.join(desktopDir, '.deploy', 'cli'))}`)
}

/**
 * Finalize — copy .deploy/cli → dsh-runtime/. Pairs with stageUpstreamLibs.
 * On a one-shot run (no --stage / --finalize flags), buildUpstreamLibs runs
 * the whole pipeline and skips this step (it stages straight to
 * dsh-runtime/).
 */
async function finalizeDshRuntime(_pnpm) {
  const deployDir = path.join(desktopDir, '.deploy', 'cli')
  // pnpm deploy stages apps/cli with its `files` manifest:
  //   "files": ["lib/*.js", "config"]
  // so the entry lives at deployDir/lib/bin.js, not deployDir/bin.js.
  if (!existsSync(path.join(deployDir, 'lib', 'bin.js'))) {
    throw new Error(
      `${deployDir}/lib/bin.js missing — run \`node scripts/sidecar-build.mjs --stage\` first`,
    )
  }
  const target = path.join(desktopDir, 'dsh-runtime')
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })

  step('1. Staging CLI deploy under desktop/dsh-runtime/ (cp -rL)…')
  // cp -rL handles cyclic workspace deps (cordis ↔ cordis-plugin-include)
  // by following each symlink once and refusing to recurse into a directory
  // already copied. fs.cp({dereference:true}) would ELOOP here.
  const cpBin = (() => {
    try {
      const found = spawnSync('where', ['cp'], { encoding: 'utf8' })
      const first = found.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean)
      return first || 'cp'
    } catch { return 'cp' }
  })()
  await run(cpBin, ['-rL', deployDir, target])
  console.log(`   staged at ${path.relative(repoRoot, target)}`)
}

/**
 * One-shot wrapper: runs stage (--dev path stages directly to dsh-runtime)
 * then materialize. Skipped when --stage / --finalize gates are explicit.
 */
async function buildUpstreamLibs(pnpm) {
  await stageUpstreamLibs(pnpm)
  if (!isDev) {
    await finalizeDshRuntime(pnpm)
  }
}

async function buildWeb(pnpm) {
  step('3. Building web frontend (apps/web/dist)…')
  await run(pnpm, [
    '--silent',
    '--filter', '@deepseek-ai/dsh-web-frontend',
    'build',
  ], { cwd: repoRoot })
  const dist = path.join(repoRoot, 'apps', 'web', 'dist')
  if (!existsSync(path.join(dist, 'index.html'))) {
    throw new Error('vite build did not produce dist/index.html')
  }
  console.log(`   built at ${path.relative(repoRoot, dist)}`)
}

/**
 * Stage a bundled Node runtime into desktop/node/.
 *   Windows: desktop/node/node.exe          (archive root contains node.exe)
 *   POSIX:   desktop/node/bin/node          (archive root contains bin/node)
 * host.rs reads `desktop/node/node.exe` or `desktop/node/node` accordingly.
 *
 * Cached by version: re-runs skip the download if the binary already exists
 * and prints its version.
 */
async function stageNode() {
  step('2. Staging bundled Node runtime…')
  const target = path.join(desktopDir, 'node')
  const binaryRel = process.platform === 'win32' ? 'node.exe' : 'bin/node'
  const binaryAbs = path.join(target, binaryRel)

  if (isDev) {
    console.log('   --dev mode: skipping Node download (Tauri uses system node via devUrl)')
    return
  }

  if (existsSync(binaryAbs)) {
    const version = await probeVersion(binaryAbs)
    console.log(`   already present at ${binaryAbs} (${version})`)
    return
  }

  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })

  const { nodePlatform, arch, ext } = nodeArchiveTarget()
  const version = await latestNode22()
  const filename = `node-${version}-${nodePlatform}-${arch}.${ext}`
  const url = `https://nodejs.org/dist/${version}/${filename}`
  const archivePath = path.join(target, filename)
  await downloadTo(url, archivePath, 'Node')

  if (ext === 'zip') {
    // PowerShell Expand-Archive is the universal Windows zip extractor; bsdtar
    // shipped with recent Windows is also fine but varies by build.
    await run('powershell', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' `
        + `-DestinationPath '${target.replace(/'/g, "''")}' -Force`,
    ])
    // Expand-Archive keeps the `node-vX.Y.Z-<platform>-<arch>` top dir;
    // move its contents up one level so the binary lands at `target/node.exe`.
    await flattenSingleSubdir(target)
  } else {
    await run('tar', ['-xf', archivePath, '-C', target, '--strip-components=1'])
  }
  await rm(archivePath, { force: true })

  if (!existsSync(binaryAbs)) {
    throw new Error(
      `node binary missing after extraction — expected ${binaryAbs}. `
      + `Check that the archive for ${nodePlatform}-${arch} ships it at that path.`,
    )
  }
  const probed = await probeVersion(binaryAbs)
  console.log(`   installed ${probed} at ${path.relative(repoRoot, binaryAbs)}`)
}

/**
 * Stage a bundled Python runtime into desktop/python/.
 *   Windows: uses the python.org embeddable zip (zip-only layout, drops
 *     python.exe + python3XX.dll + python3XX.zip into the target root).
 *   POSIX:   no official embeddable; pull `python-build-standalone` from
 *     astral-sh, which ships a relocatable install tree under `python/`.
 *
 * The Python subagent (`@deepseek-ai/dsh-code-runtime-python`) just spawns
 * `python3` — any CPython 3.10+ works.
 */
async function stagePython() {
  step('3. Staging bundled Python runtime…')
  const target = path.join(desktopDir, 'python')
  const pythonBinRel = process.platform === 'win32' ? 'python.exe' : 'bin/python3'
  const pythonBinAbs = path.join(target, pythonBinRel)

  if (isDev) {
    console.log('   --dev mode: skipping Python download')
    return
  }

  if (existsSync(pythonBinAbs)) {
    const version = await probeVersion(pythonBinAbs)
    console.log(`   already present at ${pythonBinAbs} (${version})`)
    return
  }

  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })

  if (process.platform === 'win32') {
    // python.org embeddable zip ships only amd64 / arm64; ia32 is unsupported.
    if (process.arch !== 'x64' && process.arch !== 'arm64') {
      throw new Error(`python.org embeddable does not publish ${process.arch}`)
    }
    const version = '3.12.7'
    const platTag = process.arch === 'arm64' ? 'arm64' : 'amd64'
    const filename = `python-${version}-embed-${platTag}.zip`
    const url = `https://www.python.org/ftp/python/${version}/${filename}`
    const archivePath = path.join(target, filename)
    await downloadTo(url, archivePath, 'Python (embeddable)')

    // python.org embeddable zips extract flat — no top-level dir to strip.
    await extractZip(archivePath, target)
    await rm(archivePath, { force: true })
  } else {
    // python-build-standalone release: pick the latest cpython 3.12 line.
    const pyVersion = '3.12'
    const pbsVersion = '20240819'
    const arch = process.arch // 'x64' | 'arm64'
    const plat =
          process.platform === 'darwin' ? (arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin')
        : process.platform === 'linux' ? `${arch}-unknown-linux-gnu`
        : null
    if (!plat) throw new Error(`unsupported POSIX platform for python-build-standalone: ${process.platform}`)
    const filename = `cpython-${pyVersion}.${pbsVersion}-${plat}-install_only.tar.gz`
    const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${pbsVersion}/${filename}`
    const archivePath = path.join(target, filename)
    await downloadTo(url, archivePath, 'Python (python-build-standalone)')
    await run('tar', ['-xf', archivePath, '-C', target, '--strip-components=1'])
    await rm(archivePath, { force: true })
  }

  if (!existsSync(pythonBinAbs)) {
    throw new Error(
      `python binary missing after extraction — expected ${pythonBinAbs}. `
      + `The runtime may not publish binaries for ${process.platform}-${process.arch}.`,
    )
  }
  const probed = await probeVersion(pythonBinAbs)
  console.log(`   installed ${probed} at ${path.relative(repoRoot, pythonBinAbs)}`)
}

/** Run `<binary> --version` and return the first line trimmed. */
async function probeVersion(binary) {
  try {
    const out = await new Promise((resolve, reject) => {
      const child = spawn(binary, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
      const chunks = []
      child.stdout.on('data', (c) => chunks.push(c))
      child.stderr.on('data', (c) => chunks.push(c))
      child.on('error', reject)
      child.on('exit', (code) => {
        if (code === 0) resolve(Buffer.concat(chunks).toString('utf8'))
        else reject(new Error(`${binary} --version exited with ${code}`))
      })
    })
    return out.split(/\r?\n/)[0].trim()
  } catch (err) {
    return `<probe failed: ${err.message}>`
  }
}

/**
 * Expand-Archive on Windows keeps the zip's top directory. If `dir` has
 * exactly one child that is itself a directory, move its contents up one
 * level and remove the now-empty wrapper.
 */
async function flattenSingleSubdir(dir) {
  const { readdir } = await import('node:fs/promises')
  const entries = await readdir(dir, { withFileTypes: true })
  const dirs = entries.filter((e) => e.isDirectory())
  if (dirs.length !== 1) return
  const sub = path.join(dir, dirs[0].name)
  const subEntries = await readdir(sub, { withFileTypes: true })
  for (const entry of subEntries) {
    await cp(path.join(sub, entry.name), path.join(dir, entry.name), { recursive: true })
  }
  await rm(sub, { recursive: true, force: true })
}

async function main() {
  const pnpm = resolvePnpm()
  // --stage: build upstream + pnpm deploy → desktop/.deploy/. Stop here so
  // the user can free disk space before the next stage.
  if (isStage) {
    await stageUpstreamLibs(pnpm)
    if (isDev) {
      console.log('\n\x1b[32m✓\x1b[0m stage complete — dsh-runtime/ (source copy) ready')
    } else {
      console.log('\n\x1b[32m✓\x1b[0m stage complete — desktop/.deploy/cli/ ready')
      console.log('   next: free disk space, then run --finalize (or full build)')
    }
    return
  }
  // --finalize: assume desktop/.deploy/ exists (from --stage or previous
  // full build), copy to dsh-runtime/ + run vite + Node + Python.
  if (isFinalize) {
    await finalizeDshRuntime(pnpm)
  } else {
    await buildUpstreamLibs(pnpm)
  }
  await buildWeb(pnpm)
  await stageNode()
  await stagePython()

  console.log('\n\x1b[32m✓\x1b[0m sidecar bundle ready')
  console.log(`   dsh-runtime: ${path.relative(repoRoot, path.join(desktopDir, 'dsh-runtime'))}`)
  console.log(`   web dist:    ${path.relative(repoRoot, path.join(repoRoot, 'apps', 'web', 'dist'))}`)
  if (isDev) {
    console.log('   node/python: dev mode skipped (use system runtimes)')
  } else {
    console.log(`   node:        ${path.relative(repoRoot, path.join(desktopDir, 'node'))}`)
    console.log(`   python:      ${path.relative(repoRoot, path.join(desktopDir, 'python'))}`)
  }
  console.log('\nNext: pnpm --dir desktop exec tauri dev   (or: pnpm --dir desktop run build)')
}

main().catch((err) => {
  console.error('\n\x1b[31m✗\x1b[0m sidecar-build:', err.message)
  process.exit(1)
})