# `@deepseek-ai/dsh-desktop`

Tauri 2 shell for DeepSeek Harness. **Thin OS layer only** — bundles Node.js + Python + the upstream `dsh web` runtime so end users don't need to install them.

## What this is NOT

This shell **does not reimplement any business logic**. Settings / MCP / skills / plugins / sessions / LLM / tools are all served by the upstream Node host (started by `apps/cli`'s `dsh web`). The Rust side here only does OS primitives:

| Tauri command | OS capability | Backend |
|---|---|---|
| `credentials.{get,set,delete}` | OS keyring | `keyring` crate |
| `dialog.{open,save,message}` | Native file/message dialog | `tauri-plugin-dialog` |
| `fs.{read,write,list,exists}` | Sandboxed filesystem (3 allowlisted roots) | `tokio::fs` |
| `shell.spawn` | Whitelisted subprocess spawn | `tokio::process` |
| `deeplink.{parse,import}` | `dsh://` URL scheme | `tauri-plugin-deep-link` |
| `http_request`, `http_request_stream` | Outbound HTTP (proxy-aware, streaming) | `reqwest` |
| `app_version`, `app_config_dir` | App metadata | — |
| `crash_log_path`, `crash_report` | Panic log + report | `tokio::fs` |
| `updater_check` | Auto-update | `tauri-plugin-updater` |

That's 9 OS capabilities. Anything else goes through the Node host on `127.0.0.1:3080`.

## Architecture

```
[DeepSeek Harness.exe]
    ↓
[Tauri Rust shell starts]                   (this crate, ~2k LOC)
    ↓
[setup() hook]
    1. Locate bundled resources (node.exe, dsh-runtime/, python/)
    2. Spawn: node dsh-runtime/bin.js web
    3. Poll 127.0.0.1:3080 until ready (max 30s)
    4. Window.show() → WebView2 loads http://127.0.0.1:3080
    ↓
[Browser-side]:
    - Business calls: fetch http://127.0.0.1:3080/api/* (Node host / apiproxy)
    - OS calls: window.__TAURI_INTERNALS__.invoke(cmd) (this crate, when frontend wants native dialogs, etc.)
```

### Frontend ↔ Tauri IPC: intentionally empty

The upstream web frontend (`apps/web/`) calls the Node host over HTTP for *everything* — including `host.pickDirectory`, `host.openPath`, etc. that we'd want to be native. For the first cut we **do not** ship a `tauri-bridge` frontend shim: that would mean forking the upstream connection package and re-inviting merge conflicts on every sync.

The 9 Tauri commands are wired and callable via `window.__TAURI_INTERNALS__.invoke(...)`, so future work (replace `host.pickDirectory` with a native Tauri dialog, wire deep-link events into the frontend, etc.) only needs to add a thin client-side wrapper — the Rust surface is already stable.

## Develop

```bash
# 1. Install (uses the parent workspace's pnpm-store)
pnpm install

# 2. Build the sidecar bundles (Node + Python + dsh-runtime)
node scripts/sidecar-build.mjs          # full bundle (CLI + web + Node + Python)
node scripts/sidecar-build.mjs --dev    # CLI + web only (use system node in dev)

# 3. Run in dev mode (runs sidecar-build --dev then tauri dev)
pnpm --dir desktop run dev
```

`sidecar-build.mjs` does:
1. `pnpm deploy apps/cli --prod` → produces `desktop/dsh-runtime/` (CLI entry + bundled workspace deps + config)
2. `pnpm --filter @deepseek-ai/dsh-web-frontend build` → `apps/web/dist/`
3. (Production only, currently stubbed) Downloads Node.js portable + Python embeddable into `desktop/{node,python}/`

All three land under `desktop/` for Tauri to bundle, matched by `src-tauri/tauri.conf.json` `bundle.resources`.

## Sync with upstream

```bash
# Pull upstream changes
git fetch upstream
git merge upstream/master

# Rebuild dsh-runtime (if upstream changed CLI deps)
pnpm --dir desktop run build
```

The Rust side rarely needs changes unless the **OS command surface** shifts. Upstream changes to `packages/host/apiproxy`, business plugins, etc. flow through automatically — no Rust merge work needed.

## Known limitations (workarounds applied)

### Production `pnpm deploy` strips peer dependencies

`pnpm deploy --prod --legacy` does **not** include peerDependencies, but apps/cli's runtime reaches several workspace packages only via peer declarations on transitive deps (Cordis plugin architecture: peers are provided by the host, deploy has no host). Result: the upstream CLI fails at module load with `ERR_MODULE_NOT_FOUND` for each missing package.

**Workarounds already applied** (in `c9c7ac8e9e`):

- `packages/boot/app-boot/package.json`: moved `@deepseek-ai/cordis-plugin-group` from `peerDependencies` to `dependencies`
- `packages/context/session-reference/package.json`: moved `@deepseek-ai/dsh-compaction` from `peerDependencies` to `dependencies`
- `apps/cli/package.json`: directly lists `@deepseek-ai/dsh-compaction`, `@deepseek-ai/cordis-plugin-group`, `@deepseek-ai/dsh-output-retention` so pnpm deploy includes them at the top of the resolved graph

**Insufficient alone**: pnpm deploy's depth-of-resolve doesn't follow peer→dep promotion for every transitive peer. The runtime still surfaces `ERR_MODULE_NOT_FOUND` for other peer-only packages (e.g. `@deepseek-ai/dsh-invariants`, `@deepseek-ai/dsh-llm`).

**Real fixes** (not yet applied):

1. Promote every needed peer to `dependencies` in `apps/cli/package.json` (whack-a-mole, see commit message)
2. Use `pnpm install --config.node-linker=hoisted` to flatten `node_modules/` and deploy that directly (drops strict-mode isolation, but no peer-dep gap)
3. Skip `pnpm deploy` entirely; have `sidecar-build.mjs` `cp` the upstream `node_modules/` into `desktop/dsh-runtime/node_modules/` and rely on Tauri's resource copy for `bin.js` + `lib/` only (loses strict isolation but is dead-simple and complete)

**Current status**: the dev fallback path (host.rs spawns upstream source via `tsx` + `NODE_PATH`) is fully working end-to-end. The production path works through bin.js + the limited peer-dep promotion but is not yet robust against every possible missing peer. A future commit will pick one of the three real fixes above.

### Production `pnpm deploy` strips peer dependencies

`pnpm deploy --prod --legacy` does **not** include peerDependencies, but apps/cli's runtime reaches many workspace packages only via peer declarations (Cordis plugin architecture: peers are provided by the host, deploy has no host). Result: the upstream CLI fails at module load with `ERR_MODULE_NOT_FOUND` for each missing package.

**Workarounds already applied** (in `c9c7ac8e9e` and `9cbd4fe792`):

- `packages/boot/app-boot/package.json`: moved `@deepseek-ai/cordis-plugin-group` from `peerDependencies` to `dependencies`
- `packages/context/session-reference/package.json`: moved `@deepseek-ai/dsh-compaction` from `peerDependencies` to `dependencies`
- `apps/cli/package.json`: directly lists `@deepseek-ai/dsh-compaction`, `@deepseek-ai/cordis-plugin-group`, `@deepseek-ai/dsh-output-retention`, `@deepseek-ai/dsh-timeout`, `@deepseek-ai/dsh-scope`, `@deepseek-ai/dsh-sandbox` so pnpm deploy includes them at the top of the resolved graph

**Whack-a-mole does not converge.** A scan of `desktop/.deploy/cli/lib/**` + the `.pnpm` tree finds **~96 unique `@deepseek-ai/*` imports**. apps/cli previously declared ~30 directly; the rest are reached through transitive runtime references in plugins (Cordis loader walks the entry tree at startup). Every promoted peer surfaces the next missing one — this branch has fixed 6, the production deploy still fails on 70+ more.

**Production deploy is therefore INCOMPLETE on this branch.** The supported path is **dev fallback** (host.rs spawns the upstream source via `tsx` with `NODE_PATH=upstream/node_modules`).

**Real fixes** (not yet applied — pick one when production matters):

1. **Bulk-promote all 70+ transitively-imported workspace packages to `apps/cli/package.json` dependencies** (whack-a-mole complete — works, but creates merge noise in selective upstream sync)
2. **Custom deploy script** that scans the `.pnpm` tree and creates the missing top-level symlinks at install time (`mklink /J` works on Windows without admin, but `cp` + `verbatimSymlinks` requires admin/dev-mode)
3. **Switch from pnpm deploy to a flat `nodeLinker=hoisted` install** (drops strict-mode isolation, but eliminates the peer-dep gap entirely)

### `pnpm install` over the upstream workspace

```bash
cd "C:\Users\smallMark\Desktop\deepseek-harness-clean"
pnpm install                          # one-time, links all workspace deps
CI=true pnpm install --no-frozen-lockfile --ignore-scripts   # after editing any package.json (avoid lefthook postinstall)
```

`--ignore-scripts` skips the root `install-lefthook.mjs` postinstall (which crashes because `lefthook` is filtered out as a root devDep under `--filter` context). `CI=true` does the same on the other side of the CI/non-CI guard inside that script.

## Bundle size budget

| Component | Size (target) | Source |
|---|---|---|
| Rust shell | ~10 MB | `cargo build --release` |
| Node.js portable | ~30 MB | `nodejs.org/dist` |
| Python embeddable | ~50 MB | `python.org/ftp/python` |
| `dsh-runtime/` (CLI + deps) | ~80 MB | `pnpm deploy apps/cli` |
| `apps/web/dist/` | ~10 MB | bundled by Tauri via `frontendDist` |
| **Total installer** | **~180 MB** | |

The ~180 MB is dominated by Node + Python + dsh-runtime closure, which we cannot shrink without breaking the "zero user setup" promise.

## Releasing a signed Windows MSI

The updater protocol needs three artifacts in lockstep:

| File | Role | Source |
|---|---|---|
| `DeepSeek Harness_<version>_x64_en-US.msi` | The installer | `cargo tauri build --bundles msi` |
| ed25519 signature over the MSI's SHA-256 digest | Wire field `platforms.windows-x86_64.signature` in `latest.json` | `desktop/scripts/sign-msi.mjs` |
| `latest.json` | Pointer file the updater polls | generated by `.github/workflows/release-desktop.yml` |

### One-time keypair setup

```bash
# Local — generate the keypair and write the public key into tauri.conf.json.
# The private seed lands at desktop/src-tauri/signer.key (mode 0600, gitignored).
node desktop/scripts/generate-signer.mjs

# Print the seed for the CI secret. Do NOT commit this value.
cat desktop/src-tauri/signer.key
# → e.g.  KECPcYT89HHxO7yCiYdc/deDbkFLA6iwdOguYzuQxeg=
```

Then in GitHub:

1. **Repository → Settings → Secrets and variables → Actions → New repository secret**
2. Name: `TAURI_SIGNER_PRIVATE_KEY`, Value: the base64 string from `signer.key`
3. (Optional) `TAURI_SIGNER_PRIVATE_KEY_PASSWORD` if you wrap the key with a passphrase

Rotating the keypair means a fresh `desktop/scripts/generate-signer.mjs` run, updating the secret, and committing the new `pubkey` field in `tauri.conf.json`. Existing installed clients still trust the OLD public key for one release cycle; bake the rotation across two consecutive releases if you cannot reach every installed instance.

### Cutting a release

1. Bump `version` in both `desktop/src-tauri/Cargo.toml` and `desktop/src-tauri/tauri.conf.json` (keep them in lockstep — MSI ProductVersion is encoded from Cargo.toml, the updater's `version` field reads from tauri.conf.json).
2. Commit + push to `master`.
3. GitHub → Actions → "Release desktop (Windows MSI)" → Run workflow → set `tag` (e.g. `desktop-v0.5.0`) and leave `dry_run=false`.

The workflow will:

- Restore pnpm-store from cache + `pnpm install --ignore-scripts`
- Run `node desktop/scripts/check-peer-deps.cjs` so a missing `@deepseek-ai/*` direct dep fails loud before the 10-minute Rust build
- Run `tauri build --bundles msi` with `TAURI_SIGNER_PRIVATE_KEY` set (Tauri signs the executable's PE header automatically)
- Verify the produced MSI's version matches the input tag
- Generate `latest.json` whose `signature` field is the hex ed25519 over the MSI's SHA-256 digest
- Upload the MSI and `latest.json` to a GitHub Release named `desktop-<tag>`

### Wiring the updater endpoint

`desktop/src-tauri/tauri.conf.json` ships with:

```json
"updater": {
  "endpoints": ["https://releases.deepseek-harness.dev/latest.json"],
  "pubkey": "<the public key generate-signer.mjs wrote here>"
}
```

The `releases.deepseek-harness.dev` host has to serve the GitHub Release's `latest.json` at that path (CloudFront + S3 static, Fastly, GitHub Pages pointing at the latest release asset — any of these). Until that host is wired, the updater endpoint URL needs to point directly at `https://github.com/<org>/<repo>/releases/latest/download/latest.json` for tests; the production host is the deploy-time replacement.
