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
//   node scripts/sidecar-build.mjs --dev    # dsh-runtime + web dist only
//
// Phases:
//   0. Stage upstream CLI source + workspace node_modules under
//      desktop/dsh-runtime/. (See buildUpstreamLibs for why we don't compile.)
//   1. Build apps/web/dist (vite build).
//   2. (skipped in --dev) Download a portable Node.js runtime into desktop/node/.
//   3. (skipped in --dev) Download a portable Python runtime into desktop/python/.
//
// The Tauri shell expects:
//   desktop/dsh-runtime/bin.js              ← built CLI entry
//   desktop/dsh-runtime/lib                 ← built CLI types
//   desktop/dsh-runtime/node_modules        ← bundled workspace deps
//   desktop/dsh-runtime/config              ← CLI config defaults
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

/** Pretty-print a step header. */
function step(msg) {
  console.log(`\n\x1b[1m→\x1b[0m ${msg}`)
}

/** Run a command, inheriting stdio. Returns a promise that resolves on exit-0.
 *
 * Pass `viaShell: true` (or any option that includes shell:true) for Windows
 * `.cmd` / `.bat` files — Node 18+ blocks them under `shell:false` for the
 * CVE-2024-27980 batch-injection class. Only use `viaShell:true` with
 * hardcoded argument strings; never with values that came from argv, env, or
 * a config file, since shell:false is the only thing that prevents the host
 * shell from interpreting metacharacters in those values.
 */
function run(cmd, args, opts = {}) {
  const { viaShell = false, ...rest } = opts
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
 * Phase 0 — stage the upstream CLI source under `desktop/dsh-runtime/`.
 *
 * Dev mode runs the upstream CLI directly from the user's workspace
 * (resolved via CARGO_MANIFEST_DIR → repo root), with NODE_PATH pointing at
 * the workspace `node_modules`. The staging here is only for the production
 * bundle path; we copy source, NOT node_modules, because pnpm's content-
 * addressable symlinks create cyclic workspace deps that any recursive copy
 * trips over (cordis ↔ cordis-plugin-include, etc.). The bundled production
 * shape will need a separate materialization step (e.g. `pnpm deploy --prod
 * --legacy --ignore-scripts` from apps/cli into a flat node_modules).
 *
 * Until that materialization step lands, the bundled resource path is
 * unfinished; running this build in `--dev` mode is a no-op (host.rs falls
 * back to the dev spawn context), and `tauri build` would ship an empty
 * dsh-runtime/ that fails to start. Phase 2 (Node download) is the only
 * piece of the production path that's been wired up; Phase 3 (Python) is a
 * stub; the materialization step belongs between Phase 0 and Phase 1.
 */
async function buildUpstreamLibs(_pnpm) {
  step('0. Staging upstream CLI source under dsh-runtime/ (production bundle prep)…')
  const cliDir = path.join(repoRoot, 'apps', 'cli')
  const target = path.join(desktopDir, 'dsh-runtime')
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })

  // Mirror Tauri's resource map. The CLI's entry is `apps/cli/src/bin.ts`;
  // hoist it to `dsh-runtime/bin.ts` so host.rs can spawn by a stable path.
  await cp(path.join(cliDir, 'src', 'bin.ts'), path.join(target, 'bin.ts'))
  await cp(path.join(cliDir, 'src'), path.join(target, 'src'), { recursive: true })
  await cp(path.join(cliDir, 'config'), path.join(target, 'config'), { recursive: true })
  await cp(path.join(cliDir, 'package.json'), path.join(target, 'package.json'))

  // Tauri requires these directories to exist even when empty so the bundle
  // resource mapping doesn't choke on missing entries.
  await mkdir(path.join(target, 'lib'), { recursive: true })
  await mkdir(path.join(target, 'node_modules'), { recursive: true })

  if (!existsSync(path.join(target, 'bin.ts'))) {
    throw new Error(`bin.ts missing after staging — does ${cliDir}/src/bin.ts exist?`)
  }
  console.log(`   staged at ${path.relative(repoRoot, target)}`)
}

async function buildWeb(pnpm) {
  step('3. Building web frontend (apps/web/dist)…')
  await run(pnpm, [
    '--silent',
    '--filter', '@deepseek-ai/dsh-web-frontend',
    'build',
  ], { cwd: repoRoot, viaShell: true })
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
  await buildUpstreamLibs()
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