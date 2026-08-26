//! Spawn the bundled Node host and wait for port 3080 to be reachable.
//!
//! This is the only place the Rust shell touches the Node runtime. The host
//! then serves the entire upstream dsh web profile (apiproxy + business
//! plugins + the bundled apps/web/dist frontend).

use std::time::Duration;

use tauri::{AppHandle, Manager};
use tokio::net::TcpStream;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Default host port the upstream `dsh web` profile listens on.
pub const HOST_PORT: u16 = 3080;
const HOST_BIND: &str = "127.0.0.1";
/// Maximum time we'll wait for the host to come up before giving up.
const READY_TIMEOUT: Duration = Duration::from_secs(30);
/// Polling interval for the port check.
const READY_POLL: Duration = Duration::from_millis(200);
/// tsx loader spec — `node --import tsx/esm <file.ts>` runs TypeScript source
/// at the loader layer (ESM hook) without a build step. sidecar-build copies
/// the upstream's source tree + workspace node_modules under
/// `dsh-runtime/`, so `tsx` is resolvable through `dsh-runtime/node_modules`.
const TSX_LOADER: &str = "tsx/esm";

/// Resolved spawn parameters for the Node child. Two modes:
///
///   - **Production**: `bin_ts` + `node_bin` come from `tauri.conf.json`'s
///     `bundle.resources` via Tauri's resource_dir; `cwd` is the upstream
///     CLI dir if it landed in the bundle, or just resource_dir otherwise.
///
///   - **Dev** (`cargo run` / `tauri dev`): resource_dir points at
///     `desktop/src-tauri/target/<profile>/` which has no upstream copy —
///     we fall back to the user's actual workspace, located two directories
///     above `CARGO_MANIFEST_DIR`. NODE_PATH points at the workspace
///     `node_modules` so ESM resolution finds pnpm-installed deps without
///     any copying.
struct SpawnContext {
    node_bin: std::path::PathBuf,
    /// The CLI entrypoint path. Production: a compiled `bin.js` from the
    /// pnpm-deploy bundle (run with plain node). Dev: the upstream TS source
    /// `bin.ts`, run via `node --import tsx/esm` so we don't have to build.
    entry: std::path::PathBuf,
    cwd: std::path::PathBuf,
    node_path: std::path::PathBuf,
    /// When true, prepend `--import tsx/esm` so the runtime loader handles
    /// `entry`'s TypeScript syntax. False when entry is already JS.
    use_tsx: bool,
}

fn resolve_spawn_context(app: &AppHandle) -> AppResult<SpawnContext> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| AppError::Other(format!("resource_dir: {e}")))?;

    // Try the bundled-resource path first.
    let bundled_node = if cfg!(windows) {
        resource_dir.join("node").join("node.exe")
    } else {
        resource_dir.join("node").join("bin").join("node")
    };
    // Production: compiled entry is at dsh-runtime/lib/bin.js (the
    // package.json "bin" mapping). dev stub or staged CI builds may still
    // expose bin.ts; prefer the compiled form when both exist.
    let bundled_bin_js = resource_dir.join("dsh-runtime").join("lib").join("bin.js");
    let bundled_bin_ts = resource_dir.join("dsh-runtime").join("bin.ts");
    if bundled_node.exists() && (bundled_bin_js.exists() || bundled_bin_ts.exists()) {
        // dsh-runtime/ in production is a Windows directory junction onto
        // the .deploy/cli staging dir (see sidecar-build.mjs --finalize), so
        // reading lib/bin.js from here resolves through to the deployed
        // bundle's compiled entry.
        let cwd = resource_dir.join("dsh-runtime");
        let node_path = cwd.join("node_modules");
        if bundled_bin_js.exists() {
            return Ok(SpawnContext {
                node_bin: bundled_node,
                entry: bundled_bin_js,
                cwd,
                node_path,
                use_tsx: false,
            });
        }
        return Ok(SpawnContext {
            node_bin: bundled_node,
            entry: bundled_bin_ts,
            cwd,
            node_path,
            use_tsx: true,
        });
    }

    // Dev fallback: use the user's workspace. CARGO_MANIFEST_DIR is set by
    // cargo at compile time to <repo>/desktop/src-tauri; two levels up is the
    // repo root, where `apps/cli/src/bin.ts` and `node_modules` live.
    let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir
        .parent()
        .and_then(|p| p.parent())
        .ok_or_else(|| AppError::Other("could not resolve repo root from CARGO_MANIFEST_DIR".into()))?
        .to_path_buf();

    let dev_node = which_node();
    let dev_bin = repo_root.join("apps").join("cli").join("src").join("bin.ts");
    if !dev_bin.exists() {
        return Err(AppError::Other(format!(
            "dev bin.ts not found at {}; set DSH_UPSTREAM_ROOT or run from the repo root",
            dev_bin.display()
        )));
    }
    let dev_cwd = repo_root.join("apps").join("cli");
    let dev_node_path = repo_root.join("node_modules");
    log::info!(
        "dev mode: spawning upstream CLI from {} with NODE_PATH={}",
        dev_cwd.display(),
        dev_node_path.display()
    );
    Ok(SpawnContext {
        node_bin: dev_node,
        entry: dev_bin,
        cwd: dev_cwd,
        node_path: dev_node_path,
        use_tsx: true,
    })
}

/// Find a `node` binary on PATH. In dev we use the user's installed Node
/// (Tauri's devUrl flow needs the same Node anyway); in production we ship
/// our own under `desktop/node/`. Returns the first match.
fn which_node() -> std::path::PathBuf {
    let cmd = if cfg!(windows) { "where" } else { "which" };
    if let Ok(out) = std::process::Command::new(cmd).arg("node").output() {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout);
            if let Some(line) = s.lines().next() {
                let p = std::path::PathBuf::from(line.trim());
                if p.exists() {
                    return p;
                }
            }
        }
    }
    std::path::PathBuf::from(if cfg!(windows) { "node.exe" } else { "node" })
}

/// Strip the Windows extended-length path prefix (`\\?\`) when handing a
/// path to Node's CLI. Tauri's `resource_dir()` returns paths with this
/// prefix, but Node's argv parsing truncates at the colon after the prefix
/// and tries to resolve just the drive letter, surfacing as EISDIR instead
/// of finding the entry. No-op on POSIX.
fn strip_unc_prefix(p: &std::path::Path) -> std::path::PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        std::path::PathBuf::from(rest)
    } else {
        p.to_path_buf()
    }
}

/// 1. Resolve Node + dsh-runtime/bin.ts (bundled, or dev-fallback to upstream).
/// 2. Spawn `node --import tsx/esm <bin.ts> web` (the upstream web profile).
/// 3. Wait for `127.0.0.1:HOST_PORT` to accept TCP connections.
/// 4. Show the main window.
pub async fn spawn_and_wait(app: &AppHandle) -> AppResult<()> {
    log::info!("spawn_and_wait: entered");
    let ctx = resolve_spawn_context(app)?;
    log::info!(
        "spawn_and_wait: node={:?} entry={:?} cwd={:?} tsx={}",
        ctx.node_bin, ctx.entry, ctx.cwd, ctx.use_tsx
    );

    let mut cmd = tokio::process::Command::new(&ctx.node_bin);
    if ctx.use_tsx {
        // Dev path: tsx hooks the ESM loader so the upstream TypeScript
        // source runs as-is, no `tsc -b + tsdown` step.
        cmd.arg(format!("--import={TSX_LOADER}"));
    }
    // Strip the Windows extended-length path prefix (\\?\) when passing
    // paths to Node — its CLI parser truncates at the colon after the prefix
    // and tries to resolve just `C:`, producing EISDIR instead of finding
    // our entry.
    cmd.arg(strip_unc_prefix(&ctx.entry))
        .arg("web")
        .arg("--port")
        .arg(HOST_PORT.to_string())
        .current_dir(strip_unc_prefix(&ctx.cwd))
        .env("DSH_HOME", resolve_dsh_home(app))
        .env("DSH_LAUNCH_ENVIRONMENT", "desktop")
        .env("NODE_PATH", strip_unc_prefix(&ctx.node_path))
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| {
        AppError::Other(format!(
            "spawn `{ctx_node:?} {entry:?}` failed: {e}",
            ctx_node = ctx.node_bin,
            entry = ctx.entry,
        ))
    })?;

    // Forward stdout/stderr to tracing so the user can see host output in the log.
    if let Some(stdout) = child.stdout.take() {
        let app_for_log = app.clone();
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                log::info!(target: "dsh.host", "{line}");
                let _ = app_for_log.try_state::<AppState>();
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                log::warn!(target: "dsh.host", "{line}");
            }
        });
    }

    wait_for_port(HOST_BIND, HOST_PORT, READY_TIMEOUT).await?;

    if let Some(state) = app.try_state::<AppState>() {
        state.install_host_child(child);
    } else {
        let _ = child.start_kill();
        return Err(AppError::Other("AppState missing".into()));
    }

    if let Some(window) = app.get_webview_window("main") {
        // Production MSI ships the embedded apps/web/dist as a placeholder
        // redirect HTML — but Tauri 2's WebView2 backend doesn't honor
        // `<meta http-equiv="refresh">` across protocols (tauri://localhost
        // → http://127.0.0.1:3080 is a cross-protocol navigation the
        // webview drops). The shell itself does the navigation now:
        // once the Node host is listening, point the webview at the
        // upstream URL and let the host's index-injection run normally.
        // In dev mode the webview is already at this URL via devUrl; the
        // navigate() is a no-op there.
        let url = format!("http://{HOST_BIND}:{HOST_PORT}/");
        if let Err(err) = window.navigate(url.parse().expect("hardcoded URL is valid")) {
            log::warn!("webview navigate to {url} failed: {err}");
        }
        let _ = window.show();
        let _ = window.set_focus();
    }

    log::info!("node host ready on {HOST_BIND}:{HOST_PORT}");
    Ok(())
}

/// Resolve the bundled node binary and the dsh-runtime/bin.ts entrypoint
/// inside the Tauri resource directory. (Kept for the production path —
/// `resolve_spawn_context` is the dev-aware version that calls this when
/// the bundle is present.)
#[allow(dead_code)]
fn resolve_paths(app: &AppHandle) -> AppResult<(std::path::PathBuf, std::path::PathBuf)> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| AppError::Other(format!("resource_dir: {e}")))?;

    let node_bin = if cfg!(windows) {
        resource_dir.join("node").join("node.exe")
    } else {
        resource_dir.join("node").join("bin").join("node")
    };
    if !node_bin.exists() {
        return Err(AppError::Other(format!(
            "bundled node binary not found at {}",
            node_bin.display()
        )));
    }

    let bin_ts = resource_dir.join("dsh-runtime").join("bin.ts");
    if !bin_ts.exists() {
        return Err(AppError::Other(format!(
            "dsh-runtime/bin.ts not found at {}",
            bin_ts.display()
        )));
    }

    Ok((node_bin, bin_ts))
}

fn resolve_dsh_home(app: &AppHandle) -> String {
    if let Ok(v) = std::env::var("DSH_HOME") {
        return v;
    }
    if let Some(state) = app.try_state::<AppState>() {
        return state.dsh_home.display().to_string();
    }
    "~/.dsh".to_string()
}

/// Poll the TCP port until it accepts a connection or the timeout elapses.
async fn wait_for_port(host: &str, port: u16, timeout: Duration) -> AppResult<()> {
    let deadline = tokio::time::Instant::now() + timeout;
    let addr = format!("{host}:{port}");
    loop {
        match TcpStream::connect(&addr).await {
            Ok(_) => return Ok(()),
            Err(_) => {
                if tokio::time::Instant::now() >= deadline {
                    return Err(AppError::HostNotReady(format!(
                        "port {addr} not reachable after {timeout:?}"
                    )));
                }
                tokio::time::sleep(READY_POLL).await;
            }
        }
    }
}
