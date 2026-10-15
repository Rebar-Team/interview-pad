mod client;
mod memory;

use client::LunaClient;
use memory::Memory;
use parking_lot::Mutex;
use rand::Rng;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    convert::Infallible,
    future::Future,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio::sync::{Notify, Semaphore};
use warp::{http::StatusCode, Filter, Reply};

use crate::{auth::AuthConfig, rooms::Rooms};

/// Upstream calls in flight across all rooms.
const GLOBAL_CONCURRENCY: usize = 8;
/// Chat messages a single room may send per hour.
const ROOM_MESSAGES_PER_HOUR: usize = 60;

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

/// The newest request for one browser session in one room.
struct Inflight {
    generation: u64,
    cancel: Arc<Notify>,
}

struct Assistant {
    client: LunaClient,
    memory: Mutex<Memory>,
    inflight: Mutex<HashMap<String, Inflight>>,
    generation: AtomicU64,
    global: Semaphore,
    usage: Mutex<HashMap<String, VecDeque<Instant>>>,
    enabled: bool,
    rooms: Rooms,
    auth: AuthConfig,
}

/// Holds a session's in-flight slot; releases it on drop, however the request ends.
struct Turn {
    state: Arc<Assistant>,
    key: String,
    generation: u64,
    cancel: Arc<Notify>,
}

impl Drop for Turn {
    fn drop(&mut self) {
        let mut inflight = self.state.inflight.lock();
        if inflight.get(&self.key).map(|f| f.generation) == Some(self.generation) {
            inflight.remove(&self.key);
        }
    }
}

impl Assistant {
    fn new(rooms: Rooms, auth: AuthConfig) -> Self {
        Self {
            client: LunaClient::new(std::env::var("OPENAI_API_KEY").ok()),
            memory: Mutex::new(Memory::default()),
            inflight: Mutex::new(HashMap::new()),
            generation: AtomicU64::new(0),
            global: Semaphore::new(GLOBAL_CONCURRENCY),
            usage: Mutex::new(HashMap::new()),
            enabled: enabled(),
            rooms,
            auth,
        }
    }

    /// Start a request for `key`, superseding any request still in flight for
    /// it. A reload or closed tab can never leave the session stuck as busy.
    fn begin(self: &Arc<Self>, key: String) -> Turn {
        let generation = self.generation.fetch_add(1, Ordering::Relaxed);
        let cancel = Arc::new(Notify::new());
        let previous = self.inflight.lock().insert(
            key.clone(),
            Inflight {
                generation,
                cancel: cancel.clone(),
            },
        );
        if let Some(previous) = previous {
            previous.cancel.notify_one();
        }
        Turn {
            state: self.clone(),
            key,
            generation,
            cancel,
        }
    }

    /// Cancel whatever is in flight for `key`.
    fn cancel(&self, key: &str) {
        if let Some(previous) = self.inflight.lock().remove(key) {
            previous.cancel.notify_one();
        }
    }

    /// Count a message against the room's hourly budget.
    fn within_budget(&self, room: &str, now: Instant) -> bool {
        let mut usage = self.usage.lock();
        usage.retain(|_, times| {
            while times.front().map_or(false, |t| {
                now.duration_since(*t) >= Duration::from_secs(3600)
            }) {
                times.pop_front();
            }
            !times.is_empty()
        });
        let times = usage.entry(room.to_owned()).or_default();
        if times.len() >= ROOM_MESSAGES_PER_HOUR {
            return false;
        }
        times.push_back(now);
        true
    }
}

/// Whether the assistant is switched on and has a key. Without a key every
/// request would fail, so the feature is hidden instead.
pub(crate) fn enabled() -> bool {
    std::env::var("LUNA_ENABLED").as_deref() == Ok("1")
        && std::env::var("OPENAI_API_KEY").map_or(false, |k| !k.is_empty())
}

/// Run `work` unless `cancel` fires first.
async fn cancellable<T>(work: impl Future<Output = T>, cancel: &Notify) -> Option<T> {
    tokio::select! {
        result = work => Some(result),
        _ = cancel.notified() => None,
    }
}

pub(super) fn routes(rooms: Rooms, auth: AuthConfig) -> warp::filters::BoxedFilter<(impl Reply,)> {
    let assistant = Arc::new(Assistant::new(rooms, auth));
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
        .and(warp::cookie::optional::<String>("pad_luna"))
        .and(warp::body::content_length_limit(140_000))
        .and(warp::body::json())
        .and(warp::any().map(move || assistant.clone()))
        .and_then(handle)
        .boxed()
}

fn response(
    status: StatusCode,
    data: Value,
    session: Option<&str>,
    secure: bool,
) -> warp::reply::Response {
    let mut reply = warp::reply::with_status(warp::reply::json(&data), status).into_response();
    reply
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    if let Some(session) = session {
        reply.headers_mut().insert(
            "set-cookie",
            format!(
                "pad_luna={session}; HttpOnly; SameSite=Strict; Path=/api/assistant; Max-Age=1800{}",
                if secure { "; Secure" } else { "" }
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
    cookie: Option<String>,
    request: ChatRequest,
    state: Arc<Assistant>,
) -> Result<warp::reply::Response, Infallible> {
    let secure = state.auth.public_origin.starts_with("https://");
    let respond = |status, data, session: Option<&str>| response(status, data, session, secure);
    if !state.auth.same_origin(origin.as_deref()) {
        return Ok(respond(
            StatusCode::FORBIDDEN,
            json!({"error":"Pad origin required"}),
            None,
        ));
    }
    if !state.enabled {
        return Ok(respond(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"error":"Luna is disabled on this server"}),
            None,
        ));
    }
    if !matches!(operation.as_str(), "chat" | "reset") {
        return Ok(respond(
            StatusCode::NOT_FOUND,
            json!({"error":"Not found"}),
            None,
        ));
    }
    if request.pad_id.is_empty()
        || request.pad_id.len() > 128
        || !request
            .pad_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Ok(respond(
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
        state.cancel(&key);
        state.memory.lock().clear(&key);
        return Ok(respond(StatusCode::OK, json!({"ok":true}), Some(&session)));
    }
    match state.rooms.get(&request.pad_id).await {
        Ok(Some(room)) if room.writable() => {}
        Ok(Some(_)) => {
            return Ok(respond(
                StatusCode::FORBIDDEN,
                json!({"error":"This room is read-only."}),
                Some(&session),
            ))
        }
        Ok(None) => {
            return Ok(respond(
                StatusCode::NOT_FOUND,
                json!({"error":"Room not found"}),
                Some(&session),
            ))
        }
        Err(_) => {
            return Ok(respond(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({"error":"Internal error"}),
                Some(&session),
            ))
        }
    }
    if request.message.trim().is_empty()
        || request.message.len() > 2000
        || request.code.len() > 24_000
        || request.language.len() > 32
    {
        return Ok(respond(
            StatusCode::BAD_REQUEST,
            json!({"error":"Question limit: 2,000 bytes; code limit: 24,000 bytes"}),
            Some(&session),
        ));
    }
    let turn = state.begin(key.clone());
    let superseded = || {
        respond(
            StatusCode::CONFLICT,
            json!({"error":"Superseded by a newer request"}),
            Some(&session),
        )
    };
    // A superseded request releases its permit as soon as it sees the cancel.
    let permit = tokio::select! {
        permit = tokio::time::timeout(Duration::from_secs(2), state.global.acquire()) => match permit {
            Ok(Ok(permit)) => permit,
            _ => {
                return Ok(respond(
                    StatusCode::TOO_MANY_REQUESTS,
                    json!({"error":"Luna is busy. Try again in a moment."}),
                    Some(&session),
                ))
            }
        },
        _ = turn.cancel.notified() => return Ok(superseded()),
    };
    // Charged only when a call is actually about to go upstream.
    if !state.within_budget(&request.pad_id, Instant::now()) {
        return Ok(respond(
            StatusCode::TOO_MANY_REQUESTS,
            json!({"error":"This room has used its assistant budget for the hour."}),
            Some(&session),
        ));
    }
    let history = state.memory.lock().read(&key, Instant::now());
    let Some(result) = cancellable(state.client.reply(history, &request), &turn.cancel).await
    else {
        return Ok(superseded());
    };
    drop(permit);
    let reply = match result {
        Ok(answer) => {
            state.memory.lock().remember(
                key,
                request.message,
                answer.message.clone(),
                Instant::now(),
            );
            respond(
                StatusCode::OK,
                serde_json::to_value(answer).unwrap(),
                Some(&session),
            )
        }
        Err(error) => respond(
            StatusCode::BAD_GATEWAY,
            json!({"error":error}),
            Some(&session),
        ),
    };
    drop(turn);
    Ok(reply)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORIGIN: &str = "http://127.0.0.1:3030";

    async fn fixture() -> (Arc<Assistant>, String) {
        let rooms = Rooms::new(None, Duration::from_secs(3600));
        let room = rooms.create("Loop", "ada@withrebar.ai").await.unwrap();
        let mut state = Assistant::new(rooms, AuthConfig::default());
        state.client = LunaClient::new(None);
        state.enabled = true;
        (Arc::new(state), room.id)
    }

    fn request(pad_id: &str) -> ChatRequest {
        ChatRequest {
            pad_id: pad_id.into(),
            message: "hi".into(),
            code: String::new(),
            language: "python".into(),
        }
    }

    async fn call(state: &Arc<Assistant>, op: &str, req: ChatRequest) -> warp::reply::Response {
        handle(op.into(), Some(ORIGIN.into()), None, req, state.clone())
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn foreign_request_never_reaches_model() {
        let (state, room) = fixture().await;
        for origin in [Some("https://evil.example".to_owned()), None] {
            let reply = handle("chat".into(), origin, None, request(&room), state.clone())
                .await
                .unwrap();
            assert_eq!(reply.status(), StatusCode::FORBIDDEN);
        }
    }

    #[tokio::test]
    async fn unknown_and_read_only_rooms_never_reach_model() {
        let (state, _) = fixture().await;
        assert_eq!(
            call(&state, "chat", request("nope")).await.status(),
            StatusCode::NOT_FOUND
        );

        let rooms = Rooms::new(None, Duration::ZERO);
        let room = rooms.create("Done", "ada@withrebar.ai").await.unwrap();
        let mut expired = Assistant::new(rooms, AuthConfig::default());
        expired.enabled = true;
        let expired = Arc::new(expired);
        assert_eq!(
            call(&expired, "chat", request(&room.id)).await.status(),
            StatusCode::FORBIDDEN
        );
    }

    #[tokio::test]
    async fn reset_is_scoped_and_sets_private_cookie() {
        let (state, room) = fixture().await;
        let session = "a".repeat(64);
        let key = format!("{session}:{room}");
        state
            .memory
            .lock()
            .remember(key.clone(), "q".into(), "a".into(), Instant::now());
        state.memory.lock().remember(
            format!("other:{room}"),
            "q".into(),
            "a".into(),
            Instant::now(),
        );
        let reply = handle(
            "reset".into(),
            Some(ORIGIN.into()),
            Some(session),
            request(&room),
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
        assert_eq!(
            state
                .memory
                .lock()
                .read(&format!("other:{room}"), Instant::now())
                .len(),
            2
        );
    }

    #[tokio::test]
    async fn invalid_requests_never_reach_model() {
        let (state, room) = fixture().await;
        let mut oversized = request(&room);
        oversized.code = "x".repeat(24_001);
        assert_eq!(
            call(&state, "chat", oversized).await.status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            call(&state, "chat", request("../x")).await.status(),
            StatusCode::BAD_REQUEST
        );
    }

    #[tokio::test]
    async fn newer_request_supersedes_abandoned_one() {
        let (state, _) = fixture().await;
        let first = state.begin("s:p".into());
        let abandoned = {
            let cancel = first.cancel.clone();
            tokio::spawn(
                async move { cancellable(futures::future::pending::<()>(), &cancel).await },
            )
        };
        let second = state.begin("s:p".into());
        assert_eq!(abandoned.await.unwrap(), None, "first request is cancelled");

        // The stale turn finishing must not release the newer one's slot.
        drop(first);
        assert_eq!(state.inflight.lock()["s:p"].generation, second.generation);
        drop(second);
        assert!(state.inflight.lock().is_empty());
    }

    #[tokio::test]
    async fn reset_cancels_in_flight_request() {
        let (state, _) = fixture().await;
        let turn = state.begin("s:p".into());
        state.cancel("s:p");
        assert_eq!(
            cancellable(futures::future::pending::<()>(), &turn.cancel).await,
            None
        );
    }

    #[test]
    fn room_budget_is_hourly() {
        let rooms = Rooms::new(None, Duration::from_secs(3600));
        let state = Assistant::new(rooms, AuthConfig::default());
        let now = Instant::now();
        for _ in 0..ROOM_MESSAGES_PER_HOUR {
            assert!(state.within_budget("r", now));
        }
        assert!(!state.within_budget("r", now));
        assert!(state.within_budget("other", now));
        assert!(state.within_budget("r", now + Duration::from_secs(3600)));
    }
}
