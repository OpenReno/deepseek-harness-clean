//! `dsh://` URL scheme parsing and import. Used for plugin/skill install
//! links clicked from external sites.

use serde::Deserialize;
use serde::Serialize;
use url::Url;

use crate::error::{AppError, AppResult};

#[derive(Debug, Deserialize)]
pub struct DeeplinkArgs {
    pub url: String,
}

#[derive(Serialize)]
pub struct ParsedDeeplink {
    pub scheme: String,
    pub host: Option<String>,
    pub path: String,
    pub query: Option<String>,
}

#[tauri::command]
pub async fn deeplink_parse(args: DeeplinkArgs) -> AppResult<ParsedDeeplink> {
    let url = Url::parse(&args.url).map_err(|e| AppError::Other(format!("deeplink parse: {e}")))?;
    if url.scheme() != "dsh" {
        return Err(AppError::Other(format!(
            "expected dsh:// scheme, got {}",
            url.scheme()
        )));
    }
    Ok(ParsedDeeplink {
        scheme: url.scheme().to_string(),
        host: url.host_str().map(|s| s.to_string()),
        path: url.path().to_string(),
        query: url.query().map(|s| s.to_string()),
    })
}

#[tauri::command]
pub async fn deeplink_import(args: DeeplinkArgs) -> AppResult<()> {
    // Reserved for real implementation: forward to Node host's plugin_install
    // over HTTP. For now we just acknowledge so the UI doesn't error.
    deeplink_parse(args).await?;
    Ok(())
}