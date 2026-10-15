mod client;
mod memory;

use client::LunaClient;
use memory::Memory;
use parking_lot::Mutex;
use rand::Rng;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{convert::Infallible, sync::Arc, time::Instant};
use tokio::sync::Semaphore;
use warp::{http::StatusCode, Filter, Reply};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatRequest {
    pad_id: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    code: String,
    #[serde(default)]
    language: String,
}

struct Assistant {
    client: LunaClient,
    memory: Mutex<Memory>,
    gate: Semaphore,
    enabled: bool,
}

pub(super) fn routes() -> warp::filters::BoxedFilter<(impl Reply,)> {
    let assistant = Arc::new(Assistant {
        client: LunaClient::new(std::env::var("OPENAI_API_KEY").ok()),
        memory: Mutex::new(Memory::default()),
        gate: Semaphore::new(1),
        enabled: std::env::var("LUNA_ENABLED").as_deref() == Ok("1"),
    });
    // Idle eviction runs even if no subsequent request arrives.
    let cleaner = Arc::downgrade(&assistant);
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            match cleaner.upgrade() {
                Some(state) => {
                    state.memory.lock().evict(Instant::now());
                }
                None => break,
            }
        }
    });
    warp::path!("assistant" / String)
        .and(warp::post())
        .and(warp::header::optional::<String>("origin"))
        .and(warp::header::optional::<String>("host"))
        .and(warp::cookie::optional::<String>("pad_luna"))
        .and(warp::body::content_length_limit(140_000))
        .and(warp::body::json())
        .and(warp::any().map(move || assistant.clone()))
        .and_then(handle)
        .boxed()
}

fn local(origin: &Option<String>, host: &Option<String>) -> bool {
    origin.as_deref() == Some("http://127.0.0.1:3030") && host.as_deref() == Some("127.0.0.1:3030")
}

fn response(status: StatusCode, data: Value, session: Option<&str>) -> warp::reply::Response {
    let mut reply = warp::reply::with_status(warp::reply::json(&data), status).into_response();
    reply
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    if let Some(session) = session {
        reply.headers_mut().insert(
            "set-cookie",
            format!(
                "pad_luna={session}; HttpOnly; SameSite=Strict; Path=/api/assistant; Max-Age=1800"
            )
            .parse()
            .unwrap(),
        );
    }
    reply
}

async fn handle(
    operation: String,
    origin: Option<String>,
    host: Option<String>,
    cookie: Option<String>,
    request: ChatRequest,
    state: Arc<Assistant>,
) -> Result<warp::reply::Response, Infallible> {
    if !local(&origin, &host) {
        return Ok(response(
            StatusCode::FORBIDDEN,
            json!({"error":"Local pad origin required"}),
            None,
        ));
    }
    if !state.enabled {
        return Ok(response(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"error":"Luna is disabled on this server"}),
            None,
        ));
    }
    if !matches!(operation.as_str(), "chat" | "reset") {
        return Ok(response(
            StatusCode::NOT_FOUND,
            json!({"error":"Not found"}),
            None,
        ));
    }
    let _permit = match state.gate.try_acquire() {
        Ok(permit) => permit,
        Err(_) => {
            return Ok(response(
                StatusCode::TOO_MANY_REQUESTS,
                json!({"error":"Luna is busy. Wait for the current reply."}),
                None,
            ))
        }
    };
    if request.pad_id.is_empty()
        || request.pad_id.len() > 128
        || !request
            .pad_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Ok(response(
            StatusCode::BAD_REQUEST,
            json!({"error":"Invalid pad ID"}),
            None,
        ));
    }
    let session = cookie
        .filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
        .unwrap_or_else(|| {
            let mut rng = rand::thread_rng();
            format!("{:032x}{:032x}", rng.gen::<u128>(), rng.gen::<u128>())
        });
    let key = format!("{session}:{}", request.pad_id);
    if operation == "reset" {
        state.memory.lock().clear(&key);
        return Ok(response(StatusCode::OK, json!({"ok":true}), Some(&session)));
    }
    if request.message.trim().is_empty()
        || request.message.len() > 2000
        || request.code.len() > 24_000
        || request.language.len() > 32
    {
        return Ok(response(
            StatusCode::BAD_REQUEST,
            json!({"error":"Question limit: 2,000 bytes; code limit: 24,000 bytes"}),
            Some(&session),
        ));
    }
    let history = state.memory.lock().read(&key, Instant::now());
    let reply = match state.client.reply(history, &request).await {
        Ok(answer) => {
            state.memory.lock().remember(
                key,
                request.message,
                answer.message.clone(),
                Instant::now(),
            );
            response(
                StatusCode::OK,
                serde_json::to_value(answer).unwrap(),
                Some(&session),
            )
        }
        Err(error) => response(
            StatusCode::BAD_GATEWAY,
            json!({"error":error}),
            Some(&session),
        ),
    };
    Ok(reply)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_foreign_and_missing_origins() {
        assert!(local(
            &Some("http://127.0.0.1:3030".into()),
            &Some("127.0.0.1:3030".into())
        ));
        assert!(!local(
            &Some("https://evil.example".into()),
            &Some("127.0.0.1:3030".into())
        ));
        assert!(!local(&None, &None));
    }
    #[tokio::test]
    async fn foreign_request_never_reaches_model() {
        let reply = warp::test::request()
            .method("POST")
            .path("/assistant/chat")
            .header("origin", "https://evil.example")
            .header("host", "127.0.0.1:3030")
            .json(&json!({"padId":"p", "message":"hi", "code":"", "language":"python"}))
            .reply(&routes())
            .await;
        assert_eq!(reply.status(), StatusCode::FORBIDDEN);
    }

    fn fixture() -> Arc<Assistant> {
        Arc::new(Assistant {
            client: LunaClient::new(None),
            memory: Mutex::new(Memory::default()),
            gate: Semaphore::new(1),
            enabled: true,
        })
    }

    fn request() -> ChatRequest {
        ChatRequest {
            pad_id: "p".into(),
            message: "hi".into(),
            code: String::new(),
            language: "python".into(),
        }
    }

    #[tokio::test]
    async fn reset_is_scoped_and_sets_private_cookie() {
        let state = fixture();
        let session = "a".repeat(64);
        let key = format!("{session}:p");
        state
            .memory
            .lock()
            .remember(key.clone(), "q".into(), "a".into(), Instant::now());
        state
            .memory
            .lock()
            .remember("other:p".into(), "q".into(), "a".into(), Instant::now());
        let reply = handle(
            "reset".into(),
            Some("http://127.0.0.1:3030".into()),
            Some("127.0.0.1:3030".into()),
            Some(session),
            request(),
            state.clone(),
        )
        .await
        .unwrap();
        assert_eq!(reply.status(), StatusCode::OK);
        assert!(reply.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .contains("HttpOnly; SameSite=Strict"));
        assert!(state.memory.lock().read(&key, Instant::now()).is_empty());
        assert_eq!(state.memory.lock().read("other:p", Instant::now()).len(), 2);
    }

    #[tokio::test]
    async fn busy_and_invalid_requests_never_reach_model() {
        let state = fixture();
        let permit = state.gate.try_acquire().unwrap();
        let reply = handle(
            "chat".into(),
            Some("http://127.0.0.1:3030".into()),
            Some("127.0.0.1:3030".into()),
            None,
            request(),
            state.clone(),
        )
        .await
        .unwrap();
        assert_eq!(reply.status(), StatusCode::TOO_MANY_REQUESTS);
        drop(permit);
        let mut oversized = request();
        oversized.code = "x".repeat(24_001);
        let reply = handle(
            "chat".into(),
            Some("http://127.0.0.1:3030".into()),
            Some("127.0.0.1:3030".into()),
            None,
            oversized,
            state,
        )
        .await
        .unwrap();
        assert_eq!(reply.status(), StatusCode::BAD_REQUEST);
    }
}
