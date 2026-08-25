//! Outbound HTTP from the desktop shell. Used for skills.sh / Smithery /
//! release-update checks. Proxy-aware via reqwest builder (proxy URL comes
//! from Node host via settings).

use serde::Deserialize;
use std::str::FromStr;
use tauri::State;
use tauri::AppHandle;
use tauri::Emitter;

use reqwest::Method;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

fn parse_method(s: &str) -> AppResult<Method> {
    Method::from_str(s)
        .map_err(|e| AppError::Other(format!("invalid http method `{s}`: {e}")))
}

#[derive(Debug, Deserialize)]
pub struct HttpRequestArgs {
    pub method: String,
    pub url: String,
    pub headers: Option<Vec<HttpHeader>>,
    pub body: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct HttpHeader {
    pub name: String,
    pub value: String,
}

#[derive(serde::Serialize)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

#[derive(Debug, Deserialize)]
pub struct HttpStreamArgs {
    pub method: String,
    pub url: String,
    pub headers: Option<Vec<HttpHeader>>,
}

#[tauri::command]
pub async fn http_request(
args: HttpRequestArgs,
state: State<'_, AppState>,
) -> AppResult<HttpResponse> {
    let mut req = state.http.request(parse_method(&args.method)?, &args.url);
    if let Some(headers) = args.headers {
        for h in headers {
            req = req.header(&h.name, &h.value);
        }
    }
    if let Some(body) = args.body {
        req = req.body(body);
    }
    let resp = req.send().await?;
    let status = resp.status().as_u16();
    let headers: Vec<(String, String)> = resp
        .headers()
        .iter()
        .map(|(k, v)| {
            (
                k.to_string(),
                v.to_str().unwrap_or("").to_string(),
            )
        })
        .collect();
    let body = resp.text().await?;
    Ok(HttpResponse { status, headers, body })
}

#[tauri::command]
pub async fn http_request_stream(
app: AppHandle,
args: HttpStreamArgs,
state: State<'_, AppState>,
) -> AppResult<u32> {
    use std::sync::atomic::{AtomicU32, Ordering};
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let id = COUNTER.fetch_add(1, Ordering::Relaxed);

    let mut req = state.http.request(parse_method(&args.method)?, &args.url);
    if let Some(headers) = args.headers {
        for h in headers {
            req = req.header(&h.name, &h.value);
        }
    }

    let resp = req.send().await?;
    let status = resp.status().as_u16();
    let _ = app.emit(
        &format!("dsh-http-stream:{id}:start"),
        serde_json::json!({ "status": status }),
    );

    let app2 = app.clone();
    let mut stream = resp.bytes_stream();
    tokio::spawn(async move {
        use futures_util::StreamExt;
        loop {
            match stream.next().await {
                None => {
                    let _ = app2.emit(&format!("dsh-http-stream:{id}:end"), serde_json::json!({}));
                    break;
                }
                Some(Ok(bytes)) => {
                    let chunk = String::from_utf8_lossy(&bytes).to_string();
                    let _ = app2.emit(
                        &format!("dsh-http-stream:{id}:chunk"),
                        serde_json::json!({ "data": chunk }),
                    );
                }
                Some(Err(e)) => {
                    let _ = app2.emit(
                        &format!("dsh-http-stream:{id}:error"),
                        serde_json::json!({ "error": e.to_string() }),
                    );
                    break;
                }
            }
        }
    });

    Ok(id)
}