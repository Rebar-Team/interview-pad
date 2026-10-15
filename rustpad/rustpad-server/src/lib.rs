//! Server backend for the Rustpad collaborative text editor.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

use std::sync::Arc;
use std::time::{Duration, SystemTime};

use dashmap::DashMap;
use log::{error, info};
use rand::Rng;
use serde::Serialize;
use tokio::time::{self, Instant};
use warp::{
    filters::BoxedFilter, http::StatusCode, hyper::Body, reply::Response, ws::Ws, Filter,
    Rejection, Reply,
};

use crate::{
    auth::{json_error, optional_user, AuthConfig, User},
    database::Database,
    rooms::{gamertag, CreateRoom, Room, Rooms, MAX_NAME_CHARS},
    rustpad::Rustpad,
};

mod assistant;
pub mod auth;
pub mod database;
mod ot;
pub mod rooms;
mod rustpad;

/// An entry stored in the global server map.
///
/// Each entry corresponds to a single document. This is garbage collected by a
/// background task after one day of inactivity, to avoid server memory usage
/// growing without bound.
struct Document {
    last_accessed: Instant,
    rustpad: Arc<Rustpad>,
}

impl Document {
    fn new(rustpad: Arc<Rustpad>) -> Self {
        Self {
            last_accessed: Instant::now(),
            rustpad,
        }
    }
}

impl Drop for Document {
    fn drop(&mut self) {
        self.rustpad.kill();
    }
}

#[allow(dead_code)]
#[derive(Debug)]
struct CustomReject(anyhow::Error);

impl warp::reject::Reject for CustomReject {}

/// The shared state of the server, accessible from within request handlers.
#[derive(Clone)]
struct ServerState {
    /// Concurrent map storing in-memory documents.
    documents: Arc<DashMap<String, Document>>,
    /// Connection to the database pool, if persistence is enabled.
    database: Option<Database>,
    /// Interview rooms.
    rooms: Rooms,
}

/// Statistics about the server, returned from an API endpoint.
#[derive(Serialize)]
struct Stats {
    /// System time when the server started, in seconds since Unix epoch.
    start_time: u64,
    /// Number of documents currently tracked by the server.
    num_documents: usize,
    /// Number of documents persisted in the database.
    database_size: usize,
}

/// Server configuration.
#[derive(Clone, Debug)]
pub struct ServerConfig {
    /// Number of days to clean up documents after inactivity.
    pub expiry_days: u32,
    /// Database object, for persistence if desired.
    pub database: Option<Database>,
    /// Interviewer sign-in settings.
    pub auth: AuthConfig,
    /// How long a room accepts edits, assistant requests and code runs.
    pub room_ttl: Duration,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            expiry_days: 1,
            database: None,
            auth: AuthConfig::default(),
            room_ttl: 6 * HOUR,
        }
    }
}

/// A combined filter handling all server routes.
pub fn server(config: ServerConfig) -> BoxedFilter<(impl Reply,)> {
    auth::routes(config.auth.clone())
        .or(warp::path("api").and(backend(config)))
        .or(frontend())
        .boxed()
}

/// Construct routes for static files from React. Room URLs are client-side
/// routes, so they serve the app shell.
fn frontend() -> BoxedFilter<(impl Reply,)> {
    let shell = warp::get()
        .and(warp::path("r"))
        .and(warp::fs::file("dist/index.html"));
    warp::fs::dir("dist").or(shell).boxed()
}

/// Construct backend routes, including WebSocket handlers.
fn backend(config: ServerConfig) -> BoxedFilter<(impl Reply,)> {
    let room_ttl = config.room_ttl;
    let rooms = Rooms::new(config.database.clone(), room_ttl);
    let state = ServerState {
        documents: Default::default(),
        database: config.database,
        rooms: rooms.clone(),
    };
    tokio::spawn(cleaner(state.clone(), config.expiry_days));

    let state_filter = warp::any().map(move || state.clone());

    let socket = warp::path!("socket" / String)
        .and(warp::ws())
        .and(state_filter.clone())
        .and_then(socket_handler);

    let text = warp::path!("text" / String)
        .and(state_filter.clone())
        .and_then(text_handler);

    let start_time = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .expect("SystemTime returned before UNIX_EPOCH")
        .as_secs();
    let stats = warp::path!("stats")
        .and(warp::any().map(move || start_time))
        .and(state_filter.clone())
        .and_then(stats_handler);

    let auth = config.auth;
    let user = optional_user(auth.clone());
    let with_auth = {
        let auth = auth.clone();
        warp::any().map(move || auth.clone())
    };

    let me = warp::path!("me")
        .and(warp::get())
        .and(user.clone())
        .map(move |user: Option<User>| match user {
            Some(user) => warp::reply::json(&serde_json::json!({
                "email": user.email,
                "name": user.name,
                "picture": user.picture,
                "roomTtlMs": room_ttl.as_millis() as u64,
            }))
            .into_response(),
            None => json_error(StatusCode::UNAUTHORIZED, "Sign in required"),
        });

    let tag = warp::path!("gamertag")
        .and(warp::get())
        .and(user.clone())
        .map(|user: Option<User>| match user {
            Some(_) => {
                warp::reply::json(&serde_json::json!({ "name": gamertag() })).into_response()
            }
            None => json_error(StatusCode::UNAUTHORIZED, "Sign in required"),
        });

    let list_rooms = warp::path!("rooms")
        .and(warp::get())
        .and(user.clone())
        .and(state_filter.clone())
        .then(list_rooms_handler);

    let create_room = warp::path!("rooms")
        .and(warp::post())
        .and(user)
        .and(warp::header::optional::<String>("origin"))
        .and(with_auth.clone())
        .and(warp::body::content_length_limit(4096))
        .and(warp::body::json())
        .and(state_filter.clone())
        .then(create_room_handler);

    let get_room = warp::path!("rooms" / String)
        .and(warp::get())
        .and(state_filter.clone())
        .then(get_room_handler);

    let pty_auth = warp::path!("pty-auth")
        .and(warp::header::optional::<String>("x-forwarded-uri"))
        .and(warp::header::optional::<String>("origin"))
        .and(with_auth)
        .and(state_filter)
        .then(pty_auth_handler);

    socket
        .or(text)
        .or(stats)
        .or(me)
        .or(tag)
        .or(list_rooms)
        .or(create_room)
        .or(get_room)
        .or(pty_auth)
        .or(assistant::routes(rooms, auth))
        .boxed()
}

/// Room fields visible to anyone holding the link.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicRoom<'a> {
    id: &'a str,
    name: &'a str,
    created_at: i64,
    expires_at: i64,
    writable: bool,
    server_now: i64,
    /// Whether the interview assistant is available on this server.
    assistant: bool,
}

impl<'a> From<&'a Room> for PublicRoom<'a> {
    fn from(room: &'a Room) -> Self {
        Self {
            id: &room.id,
            name: &room.name,
            created_at: room.created_at,
            expires_at: room.expires_at,
            writable: room.writable(),
            server_now: rooms::now_ms(),
            assistant: assistant::enabled(),
        }
    }
}

/// Room fields visible to signed-in interviewers.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RoomView<'a> {
    #[serde(flatten)]
    room: &'a Room,
    writable: bool,
}

impl<'a> From<&'a Room> for RoomView<'a> {
    fn from(room: &'a Room) -> Self {
        Self {
            room,
            writable: room.writable(),
        }
    }
}

fn internal(e: anyhow::Error) -> Response {
    error!("internal error: {:#}", e);
    json_error(StatusCode::INTERNAL_SERVER_ERROR, "Internal error")
}

/// Handler for `GET /api/rooms`.
async fn list_rooms_handler(user: Option<User>, state: ServerState) -> Response {
    if user.is_none() {
        return json_error(StatusCode::UNAUTHORIZED, "Sign in required");
    }
    match state.rooms.list().await {
        Ok(rooms) => {
            let views: Vec<RoomView> = rooms.iter().map(RoomView::from).collect();
            warp::reply::json(&views).into_response()
        }
        Err(e) => internal(e),
    }
}

/// Handler for `POST /api/rooms`.
async fn create_room_handler(
    user: Option<User>,
    origin: Option<String>,
    auth: AuthConfig,
    body: CreateRoom,
    state: ServerState,
) -> Response {
    let Some(user) = user else {
        return json_error(StatusCode::UNAUTHORIZED, "Sign in required");
    };
    if !auth.same_origin(origin.as_deref()) {
        return json_error(StatusCode::FORBIDDEN, "Cross-origin request refused");
    }
    let name = body.name.trim();
    if name.chars().count() > MAX_NAME_CHARS {
        return json_error(
            StatusCode::BAD_REQUEST,
            &format!("Room names are at most {MAX_NAME_CHARS} characters"),
        );
    }
    // Control characters, plus bidi overrides and zero-width characters that
    // could make one room's name masquerade as another's.
    let hidden = |c: char| {
        c.is_control()
            || matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}')
    };
    if name.chars().any(hidden) {
        return json_error(
            StatusCode::BAD_REQUEST,
            "Room names can't contain hidden characters",
        );
    }
    let name = if name.is_empty() {
        gamertag()
    } else {
        name.to_owned()
    };
    match state.rooms.create(&name, &user.email).await {
        Ok(room) => {
            info!("{} created room {} ({})", user.email, room.id, room.name);
            warp::reply::with_status(
                warp::reply::json(&RoomView::from(&room)),
                StatusCode::CREATED,
            )
            .into_response()
        }
        Err(e) => internal(e),
    }
}

/// Handler for `GET /api/rooms/{id}`.
async fn get_room_handler(id: String, state: ServerState) -> Response {
    match state.rooms.get(&id).await {
        Ok(Some(room)) => warp::reply::json(&PublicRoom::from(&room)).into_response(),
        Ok(None) => json_error(StatusCode::NOT_FOUND, "Room not found"),
        Err(e) => internal(e),
    }
}

/// Handler for `/api/pty-auth`, the reverse proxy's gate in front of the code
/// runner. Allows a terminal connection only while its room is writable.
async fn pty_auth_handler(
    uri: Option<String>,
    origin: Option<String>,
    auth: AuthConfig,
    state: ServerState,
) -> Response {
    if !auth.same_origin(origin.as_deref()) {
        return json_error(StatusCode::FORBIDDEN, "Cross-origin request refused");
    }
    // Exactly one plain ID segment, matching how ptyd names its session, so a
    // writable link can't be stretched into extra runner sessions.
    let id = uri
        .as_deref()
        .map(|uri| uri.split('?').next().unwrap_or_default())
        .map(|path| path.strip_prefix("/pty").unwrap_or(path))
        .and_then(|path| path.strip_prefix('/'))
        .filter(|id| !id.is_empty() && id.len() <= 64)
        .filter(|id| {
            id.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        })
        .unwrap_or_default();
    if id.is_empty() {
        return json_error(StatusCode::NOT_FOUND, "Room not found");
    }
    match state.rooms.get(id).await {
        Ok(Some(room)) if room.writable() => warp::http::Response::builder()
            .status(StatusCode::NO_CONTENT)
            .header("x-room-expires-at", room.expires_at.to_string())
            .body(Body::empty())
            .expect("valid response"),
        Ok(Some(_)) => json_error(StatusCode::FORBIDDEN, "This room is read-only."),
        Ok(None) => json_error(StatusCode::NOT_FOUND, "Room not found"),
        Err(e) => internal(e),
    }
}

/// Handler for the `/api/socket/{id}` endpoint.
async fn socket_handler(id: String, ws: Ws, state: ServerState) -> Result<Response, Rejection> {
    use dashmap::mapref::entry::Entry;

    let room = match state.rooms.get(&id).await {
        Ok(Some(room)) => room,
        Ok(None) => return Ok(json_error(StatusCode::NOT_FOUND, "Room not found")),
        Err(e) => return Ok(internal(e)),
    };

    let mut entry = match state.documents.entry(id.clone()) {
        Entry::Occupied(e) => e.into_ref(),
        Entry::Vacant(e) => {
            let rustpad = Arc::new(match &state.database {
                Some(db) => db.load(&id).await.map(Rustpad::from).unwrap_or_default(),
                None => Rustpad::default(),
            });
            rustpad.set_expiry(room.expires_at);
            if room.writable() {
                tokio::spawn(expiry_announcer(Arc::clone(&rustpad), room.clone()));
            }
            if let Some(db) = &state.database {
                tokio::spawn(persister(id, Arc::clone(&rustpad), db.clone()));
            }
            e.insert(Document::new(rustpad))
        }
    };

    let value = entry.value_mut();
    value.last_accessed = Instant::now();
    let rustpad = Arc::clone(&value.rustpad);
    Ok(ws
        .on_upgrade(|socket| async move { rustpad.on_connection(socket).await })
        .into_response())
}

/// Tells connected clients when their room turns read-only.
async fn expiry_announcer(rustpad: Arc<Rustpad>, room: Room) {
    // The timer and the wall clock can disagree (clock corrections, paused
    // test time), so keep waiting until the wall clock has passed the deadline.
    loop {
        let remaining = room.remaining();
        if remaining.is_zero() {
            break;
        }
        time::sleep(remaining + Duration::from_millis(50)).await;
        if rustpad.killed() {
            return;
        }
    }
    if !rustpad.killed() {
        rustpad.announce_room();
    }
}

/// Handler for the `/api/text/{id}` endpoint.
async fn text_handler(id: String, state: ServerState) -> Result<Response, Rejection> {
    match state.rooms.get(&id).await {
        Ok(Some(_)) => {}
        Ok(None) => return Ok(json_error(StatusCode::NOT_FOUND, "Room not found")),
        Err(e) => return Ok(internal(e)),
    }
    Ok(match state.documents.get(&id) {
        Some(value) => value.rustpad.text(),
        None => {
            if let Some(db) = &state.database {
                db.load(&id)
                    .await
                    .map(|document| document.text)
                    .unwrap_or_default()
            } else {
                String::new()
            }
        }
    }
    .into_response())
}

/// Handler for the `/api/stats` endpoint.
async fn stats_handler(start_time: u64, state: ServerState) -> Result<impl Reply, Rejection> {
    let num_documents = state.documents.len();
    let database_size = match state.database {
        None => 0,
        Some(db) => match db.count().await {
            Ok(size) => size,
            Err(e) => return Err(warp::reject::custom(CustomReject(e))),
        },
    };
    Ok(warp::reply::json(&Stats {
        start_time,
        num_documents,
        database_size,
    }))
}

const HOUR: Duration = Duration::from_secs(3600);

/// Reclaims memory for documents.
async fn cleaner(state: ServerState, expiry_days: u32) {
    loop {
        time::sleep(HOUR).await;
        let mut keys = Vec::new();
        for entry in &*state.documents {
            if entry.last_accessed.elapsed() > HOUR * 24 * expiry_days {
                keys.push(entry.key().clone());
            }
        }
        info!("cleaner removing keys: {:?}", keys);
        for key in keys {
            state.documents.remove(&key);
        }
    }
}

const PERSIST_INTERVAL: Duration = Duration::from_secs(3);
const PERSIST_INTERVAL_JITTER: Duration = Duration::from_secs(1);

/// Persists changed documents after a fixed time interval.
async fn persister(id: String, rustpad: Arc<Rustpad>, db: Database) {
    let mut last_revision = 0;
    while !rustpad.killed() {
        let interval = PERSIST_INTERVAL
            + rand::thread_rng().gen_range(Duration::ZERO..=PERSIST_INTERVAL_JITTER);
        time::sleep(interval).await;
        let revision = rustpad.revision();
        if revision > last_revision {
            info!("persisting revision {} for id = {}", revision, id);
            if let Err(e) = db.store(&id, &rustpad.snapshot()).await {
                error!("when persisting document {}: {}", id, e);
            } else {
                last_revision = revision;
            }
        }
    }
}
