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
