//! Native dialog wrappers. Delegates to `tauri-plugin-dialog`.

use serde::Deserialize;
use tauri_plugin_dialog::{DialogExt, FilePath};

use crate::error::AppResult;

#[derive(Debug, Deserialize)]
pub struct DialogOpenArgs {
    pub title: Option<String>,
    pub default_path: Option<String>,
    pub filters: Option<Vec<DialogFilter>>,
    pub multiple: Option<bool>,
    pub directory: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct DialogSaveArgs {
    pub title: Option<String>,
    pub default_path: Option<String>,
    pub filters: Option<Vec<DialogFilter>>,
}

#[derive(Debug, Deserialize)]
pub struct DialogMessageArgs {
    pub message: String,
    pub kind: Option<String>, // "info" | "warning" | "error"
}

#[derive(Debug, Deserialize, serde::Serialize)]
pub struct DialogFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

#[tauri::command]
pub async fn dialog_open(
app: tauri::AppHandle,
args: DialogOpenArgs,
) -> AppResult<Vec<String>> {
    let mut d = app.dialog().file();
    if let Some(t) = args.title {
        d = d.set_title(t);
    }
    if let Some(p) = args.default_path {
        d = d.set_directory(p);
    }
    if let Some(filters) = args.filters {
        for f in filters {
            let exts: Vec<&str> = f.extensions.iter().map(String::as_str).collect();
            d = d.add_filter(f.name, &exts);
        }
    }
    if args.multiple.unwrap_or(false) {
        let paths = d.blocking_pick_files();
        return Ok(paths_to_strings(paths));
    }
    if args.directory.unwrap_or(false) {
        let p = d.blocking_pick_folder();
        return Ok(path_opt_to_strings(p));
    }
    let p = d.blocking_pick_file();
    Ok(path_opt_to_strings(p))
}

#[tauri::command]
pub async fn dialog_save(
app: tauri::AppHandle,
args: DialogSaveArgs,
) -> AppResult<Option<String>> {
    let mut d = app.dialog().file();
    if let Some(t) = args.title {
        d = d.set_title(t);
    }
    if let Some(p) = args.default_path {
        d = d.set_directory(p);
    }
    if let Some(filters) = args.filters {
        for f in filters {
            let exts: Vec<&str> = f.extensions.iter().map(String::as_str).collect();
            d = d.add_filter(f.name, &exts);
        }
    }
    let p = d.blocking_save_file();
    Ok(p.and_then(|fp| match fp {
        FilePath::Path(buf) => Some(buf.display().to_string()),
        FilePath::Url(u) => Some(u.to_string()),
    }))
}

#[tauri::command]
pub async fn dialog_message(
app: tauri::AppHandle,
args: DialogMessageArgs,
) -> AppResult<()> {
    use tauri_plugin_dialog::MessageDialogButtons;
    let kind = args.kind.as_deref().unwrap_or("info");
    let dlg = match kind {
        "warning" => app.dialog().message(&args.message).kind(tauri_plugin_dialog::MessageDialogKind::Warning),
        "error" => app.dialog().message(&args.message).kind(tauri_plugin_dialog::MessageDialogKind::Error),
        _ => app.dialog().message(&args.message).kind(tauri_plugin_dialog::MessageDialogKind::Info),
    };
    dlg.buttons(MessageDialogButtons::Ok)
        .show(|_| {});
    Ok(())
}

fn path_opt_to_strings(p: Option<FilePath>) -> Vec<String> {
    p.and_then(|fp| match fp {
        FilePath::Path(buf) => Some(buf.display().to_string()),
        FilePath::Url(u) => Some(u.to_string()),
    })
    .into_iter()
    .collect()
}

fn paths_to_strings(paths: Option<Vec<FilePath>>) -> Vec<String> {
    paths
        .unwrap_or_default()
        .into_iter()
        .filter_map(|fp| match fp {
            FilePath::Path(buf) => Some(buf.display().to_string()),
            FilePath::Url(u) => Some(u.to_string()),
        })
        .collect()
}