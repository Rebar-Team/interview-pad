//! The Interview Assistant: one shared chat per room, over a WebSocket.
//!
//! Everyone in a room sees the same conversation live, like the editor and the
//! terminal. Messages are stored with the room, so the chat and the model's
//! memory survive reloads and restarts, and every interaction is logged in
//! full for review.

mod client;
mod diff;
mod patch;

use client::{AssistantClient, Attempt, Message};
use futures::{SinkExt, StreamExt};
use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    convert::Infallible,
    sync::{
        atomic::{AtomicI64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio::sync::{broadcast, Mutex, Semaphore};
use warp::{
    http::StatusCode,
    ws::{WebSocket, Ws},
    Filter, Reply,
};

use crate::{
    auth::{json_error, optional_user, AuthConfig, User},
    database::{AssistantMessage, Database},
    rooms::{now_ms, Rooms},
    rustpad::Rustpad,
};

/// Upstream calls in flight across all rooms.
const GLOBAL_CONCURRENCY: usize = 8;
/// How long a question waits for an upstream slot before giving up.
const PERMIT_WAIT: Duration = Duration::from_secs(30);
/// Messages of history the model sees: ten questions and their replies.
const HISTORY_MESSAGES: usize = 20;
/// Byte budget for that history.
const HISTORY_BYTES: usize = 128_000;
/// Messages shown when the panel opens.
const SHOWN_MESSAGES: u32 = 200;
const MAX_QUESTION_BYTES: usize = 2000;
const MAX_CODE_BYTES: usize = 24_000;
const MAX_AUTHOR_CHARS: usize = 64;
/// An idle chat nobody is connected to leaves memory after this; it is
/// reloaded from the database on the next connection.
const IDLE_EVICTION: Duration = Duration::from_secs(1800);

/// A question, with the editor state it is about.
pub(super) struct Ask {
    message: String,
    code: String,
    language: String,
    /// Where the asker is in the editor, so "here" and "this" resolve.
    cursor: Option<Cursor>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    /// 1-based line number.
    line: u32,
    /// Selected text, if any.
    #[serde(default)]
    selection: String,
}

/// From the panel.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ClientMessage {
    Ask {
        message: String,
        code: String,
        language: String,
        #[serde(default)]
        cursor: Option<Cursor>,
        #[serde(default)]
        author: String,
    },
    Clear,
    /// Apply a proposed edit to the room's code. The server edits the shared
    /// document itself, so an edit lands once however many people click.
    Apply {
        id: i64,
        #[serde(default)]
        author: String,
    },
    /// Revert an applied edit the same way.
    Undo {
        id: i64,
    },
}

/// To the panel.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Event {
    /// The whole chat, on connecting.
    Snapshot {
        messages: Vec<AssistantMessage>,
        busy: Option<String>,
    },
    /// A new or updated message.
    Message {
        message: AssistantMessage,
    },
    /// Whose question is being answered, if any.
    Busy {
        busy: Option<String>,
    },
    Cleared,
    /// Only to the client whose request failed.
    Error {
        error: String,
        /// The failed request's type (`ask`, `apply`, ...), so the panel can
        /// tell a refused question from other failures.
        request: Option<String>,
    },
}

struct ChatState {
    messages: Vec<AssistantMessage>,
    /// Who asked the question being answered.
    busy: Option<String>,
    touched: Instant,
}

/// One room's conversation.
struct Chat {
    room: String,
    state: Mutex<ChatState>,
    events: broadcast::Sender<Event>,
}

impl Chat {
    fn new(room: String, messages: Vec<AssistantMessage>) -> Self {
        Self {
            room,
            state: Mutex::new(ChatState {
                messages,
                busy: None,
                touched: Instant::now(),
            }),
            events: broadcast::channel(64).0,
        }
    }

    fn publish(&self, event: Event) {
        // No receivers just means nobody is connected.
        let _ = self.events.send(event);
    }

    async fn snapshot(&self) -> Event {
        let state = self.state.lock().await;
        Event::Snapshot {
            messages: state.messages.clone(),
            busy: state.busy.clone(),
        }
    }

    async fn finish(&self) {
        self.state.lock().await.busy = None;
        self.publish(Event::Busy { busy: None });
    }
}

/// Clears a chat's busy state however a question's task ends, panics included.
struct Answering(Option<Arc<Chat>>);

impl Answering {
    async fn finish(mut self) {
        if let Some(chat) = self.0.take() {
            chat.finish().await;
        }
    }
}

impl Drop for Answering {
    fn drop(&mut self) {
        if let Some(chat) = self.0.take() {
            tokio::spawn(async move { chat.finish().await });
        }
    }
}

/// The last `HISTORY_MESSAGES` exchanges the model should remember. Failed
/// questions and their errors are left out, as is the chat before a clear.
fn history(messages: &[AssistantMessage]) -> (Vec<Message>, bool) {
    let mut pairs: Vec<(&AssistantMessage, &AssistantMessage)> = Vec::new();
    for pair in messages.windows(2) {
        if pair[0].role == "user" && pair[1].role == "assistant" && pair[1].kind != "error" {
            pairs.push((&pair[0], &pair[1]));
        }
    }
    let asked_already = messages
        .iter()
        .rev()
        .find(|m| m.role == "assistant" && m.kind != "error")
        .map_or(false, |m| m.kind == "clarify");
    let mut out: Vec<Message> = Vec::new();
    for (question, answer) in pairs.into_iter().rev().take(HISTORY_MESSAGES / 2) {
        let answer = match &answer.patch {
            Some(patch) => format!(
                "{}\n\nProposed edit ({}):\n{patch}",
                answer.content,
                match &answer.applied_by {
                    Some(who) => format!("applied by {who}"),
                    None => "not applied".into(),
                }
            ),
            None => answer.content.clone(),
        };
        let size: usize = out.iter().map(|m| m.content.len()).sum();
        if size + question.content.len() + answer.len() > HISTORY_BYTES {
            break;
        }
        out.push(Message {
            role: "assistant",
            content: answer,
        });
        out.push(Message {
            role: "user",
            content: question.content.clone(),
        });
    }
    out.reverse();
    (out, asked_already)
}

fn author(name: &str) -> String {
    let name: String = name.trim().chars().take(MAX_AUTHOR_CHARS).collect();
    if name.is_empty() {
        "Someone".into()
    } else {
        name
    }
}

/// The room's live document, if its editor is loaded.
pub(super) type Documents = Arc<dyn Fn(&str) -> Option<Arc<Rustpad>> + Send + Sync>;

struct Assistant {
    client: AssistantClient,
    documents: Documents,
    database: Option<Database>,
    chats: Mutex<HashMap<String, Arc<Chat>>>,
    /// IDs for messages that couldn't be stored: negative, so they never
    /// collide with database rows.
    unsaved_id: AtomicI64,
    global: Semaphore,
    enabled: bool,
    rooms: Rooms,
    auth: AuthConfig,
}

impl Assistant {
    fn new(
        rooms: Rooms,
        auth: AuthConfig,
        database: Option<Database>,
        documents: Documents,
    ) -> Self {
        Self {
            client: AssistantClient::new(std::env::var("OPENAI_API_KEY").ok()),
            documents,
            database,
            chats: Default::default(),
            unsaved_id: AtomicI64::new(0),
            global: Semaphore::new(GLOBAL_CONCURRENCY),
            enabled: enabled(),
            rooms,
            auth,
        }
    }

    /// The room's chat, loading it from the database on first use.
    async fn chat(&self, room: &str) -> Arc<Chat> {
        let mut chats = self.chats.lock().await;
        if let Some(chat) = chats.get(room) {
            // Mark it in use before the socket subscribes, so eviction can't
            // drop it in between and leave the room with two chats.
            chat.state.lock().await.touched = Instant::now();
            return chat.clone();
        }
        let messages = match &self.database {
            Some(db) => match db.load_assistant_messages(room, SHOWN_MESSAGES).await {
                Ok(messages) => messages,
                Err(e) => {
                    error!("loading assistant chat for {room}: {e:#}");
                    Vec::new()
                }
            },
            None => Vec::new(),
        };
        let chat = Arc::new(Chat::new(room.to_owned(), messages));
        chats.insert(room.to_owned(), chat.clone());
        chat
    }

    /// Drop idle chats nobody is connected to. Only with a database, which
    /// still holds them.
    async fn evict(&self) {
        if self.database.is_none() {
            return;
        }
        let mut chats = self.chats.lock().await;
        let mut idle = Vec::new();
        for (room, chat) in chats.iter() {
            if chat.events.receiver_count() > 0 {
                continue;
            }
            if let Ok(state) = chat.state.try_lock() {
                if state.busy.is_none() && state.touched.elapsed() > IDLE_EVICTION {
                    idle.push(room.clone());
                }
            }
        }
        for room in idle {
            chats.remove(&room);
        }
    }

    /// Store a message, add it to the chat and send it to everyone.
    async fn post(&self, chat: &Chat, mut message: AssistantMessage) -> AssistantMessage {
        let mut state = chat.state.lock().await;
        let stored = match &self.database {
            Some(db) => db.insert_assistant_message(&chat.room, &message).await,
            None => Err(anyhow::anyhow!("no database")),
        };
        message.id = match stored {
            Ok(id) => id,
            Err(e) => {
                if self.database.is_some() {
                    error!("storing assistant message for {}: {e:#}", chat.room);
                }
                self.unsaved_id.fetch_sub(1, Ordering::Relaxed) - 1
            }
        };
        state.messages.push(message.clone());
        state.touched = Instant::now();
        chat.publish(Event::Message {
            message: message.clone(),
        });
        message
    }

    /// Handle one message from a panel. An error goes back to that panel only.
    async fn handle(self: &Arc<Self>, chat: &Arc<Chat>, text: &str) -> Result<(), String> {
        let request: ClientMessage =
            serde_json::from_str(text).map_err(|_| "Malformed request".to_owned())?;
        if !self.enabled {
            return Err("The Interview Assistant is turned off on this server.".into());
        }
        match self.rooms.get(&chat.room).await {
            Ok(Some(room)) if room.writable() => {}
            Ok(Some(_)) => return Err("This room is read-only.".into()),
            Ok(None) => return Err("Room not found".into()),
            Err(e) => {
                error!("loading room {}: {e:#}", chat.room);
                return Err("Internal error".into());
            }
        }
        match request {
            ClientMessage::Ask {
                message,
                code,
                language,
                cursor,
                author: name,
            } => {
                let ask = Ask {
                    message: message.trim().to_owned(),
                    code,
                    language,
                    cursor,
                };
                if ask.message.is_empty()
                    || ask.message.len() > MAX_QUESTION_BYTES
                    || ask.code.len() > MAX_CODE_BYTES
                    || ask.language.len() > 32
                {
                    return Err("Question limit: 2,000 bytes; code limit: 24,000 bytes".into());
                }
                let name = author(&name);
                {
                    let mut state = chat.state.lock().await;
                    if let Some(who) = &state.busy {
                        return Err(format!(
                            "The assistant is still answering {who}'s question. Send yours when it's done."
                        ));
                    }
                    state.busy = Some(name.clone());
                }
                chat.publish(Event::Busy {
                    busy: Some(name.clone()),
                });
                let answering = Answering(Some(chat.clone()));
                let (this, chat) = (self.clone(), chat.clone());
                tokio::spawn(async move {
                    this.answer(&chat, ask, name).await;
                    answering.finish().await;
                });
                Ok(())
            }
            ClientMessage::Clear => {
                let mut state = chat.state.lock().await;
                if state.busy.is_some() {
                    return Err("Wait for the current answer before clearing the chat.".into());
                }
                if let Some(db) = &self.database {
                    if let Err(e) = db.clear_assistant_messages(&chat.room).await {
                        error!("clearing assistant chat for {}: {e:#}", chat.room);
                        return Err("Couldn't clear the chat. Try again.".into());
                    }
                }
                state.messages.clear();
                chat.publish(Event::Cleared);
                Ok(())
            }
            ClientMessage::Apply { id, author: name } => {
                self.apply(chat, id, Some(author(&name))).await
            }
            ClientMessage::Undo { id } => self.apply(chat, id, None).await,
        }
    }

    /// Apply edit `id` to the room's document (`by` is who applied it), or with
    /// `None` undo it. The chat lock makes checking and applying one step.
    async fn apply(&self, chat: &Chat, id: i64, by: Option<String>) -> Result<(), String> {
        let mut state = chat.state.lock().await;
        let Some(message) = state
            .messages
            .iter_mut()
            .find(|m| m.id == id && m.patch.is_some())
        else {
            return Err("That edit is no longer in the chat.".into());
        };
        if message.applied_by.is_none() && by.is_none() {
            return Err("That edit isn't applied.".into());
        }
        let document = (self.documents)(&chat.room)
            .ok_or("The room's editor isn't open on the server. Reload the page and try again.")?;
        let proposal = message.patch.clone().unwrap_or_default();
        let applied_by = message.applied_by.clone();
        // Whether the edit is applied comes from the code itself: anyone's
        // Ctrl+Z can revert it without the chat knowing.
        document.edit_text(|code| {
            let applied = patch::contains(code, &proposal);
            match (&by, applied) {
                (Some(_), true) => Err(match &applied_by {
                    Some(who) => format!("{who} already applied this edit."),
                    None => "This edit is already in the code.".into(),
                }),
                (Some(_), false) => patch::locate(code, &proposal)
                    .map(|r| Some(patch::apply(code, &r)))
                    .map_err(|_| {
                        "The code this edit changes was modified after it was proposed, so it \
                         can't be applied. Ask again for an updated edit."
                            .into()
                    }),
                // Reverted in the editor (the original is back, so the edit
                // would apply again): just record that.
                (None, false) if patch::locate(code, &proposal).is_ok() => Ok(None),
                // Neither applied as proposed nor reverted: edited since.
                (None, false) => Err(
                    "The code this edit changed has been modified since, so it can't be \
                     undone automatically. Change it back by hand."
                        .into(),
                ),
                (None, true) => {
                    let undo = patch::reverse(&proposal);
                    patch::locate(code, &undo)
                        .map(|r| Some(patch::apply(code, &r)))
                        .map_err(|_| {
                            "The code this edit changed has been modified since, so it can't be \
                             undone automatically. Change it back by hand."
                                .into()
                        })
                }
            }
        })?;
        message.applied_by = by;
        let message = message.clone();
        if let Some(db) = &self.database {
            if let Err(e) = db
                .set_assistant_applied(id, message.applied_by.as_deref())
                .await
            {
                error!("recording applied edit {id}: {e:#}");
            }
        }
        info!(
            "assistant room={} edit={id} {}",
            chat.room,
            if message.applied_by.is_some() {
                "applied"
            } else {
                "undone"
            }
        );
        chat.publish(Event::Message { message });
        Ok(())
    }

    /// Post the question, ask the model, post the reply and log everything.
    async fn answer(&self, chat: &Chat, ask: Ask, name: String) {
        let started = Instant::now();
        let created_at = now_ms();
        let (history, asked_already) = history(&chat.state.lock().await.messages);
        self.post(
            chat,
            AssistantMessage {
                id: 0,
                created_at,
                author: name.clone(),
                role: "user".into(),
                kind: "question".into(),
                content: ask.message.clone(),
                patch: None,
                notice: None,
                applied_by: None,
            },
        )
        .await;
        let mut attempts: Vec<Attempt> = Vec::new();
        let result = match tokio::time::timeout(PERMIT_WAIT, self.global.acquire()).await {
            Ok(Ok(_permit)) => {
                self.client
                    .reply(history.clone(), &ask, asked_already, &mut attempts)
                    .await
            }
            _ => Err("The assistant is busy with other interviews. Try again in a moment.".into()),
        };
        let reply = match &result {
            Ok(reply) => AssistantMessage {
                id: 0,
                created_at: now_ms(),
                author: String::new(),
                role: "assistant".into(),
                kind: reply.kind.clone(),
                content: reply.message.clone(),
                patch: reply.patch.clone(),
                notice: reply.notice.clone(),
                applied_by: None,
            },
            Err(error) => AssistantMessage {
                id: 0,
                created_at: now_ms(),
                author: String::new(),
                role: "assistant".into(),
                kind: "error".into(),
                content: format!("Something went wrong: {error}"),
                patch: None,
                notice: None,
                applied_by: None,
            },
        };
        let reply = self.post(chat, reply).await;
        let took_ms = started.elapsed().as_millis() as u64;
        match &result {
            Ok(_) => info!(
                "assistant room={} kind={} attempts={} took={took_ms}ms",
                chat.room,
                reply.kind,
                attempts.len()
            ),
            Err(error) => warn!(
                "assistant room={} error after {took_ms}ms: {error}",
                chat.room
            ),
        }
        let entry = json!({
            "author": name,
            "question": ask.message,
            "language": ask.language,
            "cursor": ask.cursor,
            "code": ask.code,
            "model": self.client.model(),
            "history": history,
            "askedAlready": asked_already,
            "attempts": attempts,
            "reply": reply,
            "error": result.err(),
            "tookMs": took_ms,
        });
        if let Some(db) = &self.database {
            if let Err(e) = db
                .insert_assistant_log(&chat.room, created_at, &entry.to_string())
                .await
            {
                error!("logging assistant interaction for {}: {e:#}", chat.room);
            }
        }
    }

    /// Serve one panel: the chat so far, then live updates both ways.
    async fn connect(self: Arc<Self>, socket: WebSocket, chat: Arc<Chat>) {
        let (mut sink, mut stream) = socket.split();
        let mut events = chat.events.subscribe();
        let send = |event: &Event| warp::ws::Message::text(serde_json::to_string(event).unwrap());
        if sink.send(send(&chat.snapshot().await)).await.is_err() {
            return;
        }
        loop {
            let outgoing = tokio::select! {
                event = events.recv() => match event {
                    Ok(event) => event,
                    // Too far behind to catch up message by message.
                    Err(broadcast::error::RecvError::Lagged(_)) => chat.snapshot().await,
                    Err(broadcast::error::RecvError::Closed) => break,
                },
                incoming = stream.next() => match incoming {
                    Some(Ok(message)) if message.is_close() => break,
                    Some(Ok(message)) => {
                        let Ok(text) = message.to_str() else { continue };
                        match self.handle(&chat, text).await {
                            Ok(()) => continue,
                            Err(error) => Event::Error {
                                error,
                                request: serde_json::from_str::<Value>(text)
                                    .ok()
                                    .and_then(|v| v["type"].as_str().map(str::to_owned)),
                            },
                        }
                    }
                    _ => break,
                },
            };
            if sink.send(send(&outgoing)).await.is_err() {
                break;
            }
        }
        chat.state.lock().await.touched = Instant::now();
    }
}

/// Whether the assistant is switched on and has a key. Without a key every
/// request would fail, so the feature is hidden instead.
pub(crate) fn enabled() -> bool {
    std::env::var("ASSISTANT_ENABLED").as_deref() == Ok("1")
        && std::env::var("OPENAI_API_KEY").map_or(false, |k| !k.is_empty())
}

pub(super) fn routes(
    rooms: Rooms,
    auth: AuthConfig,
    database: Option<Database>,
    documents: Documents,
) -> warp::filters::BoxedFilter<(impl Reply,)> {
    let assistant = Arc::new(Assistant::new(rooms, auth.clone(), database, documents));
    let cleaner = Arc::downgrade(&assistant);
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(300)).await;
            match cleaner.upgrade() {
                Some(state) => state.evict().await,
                None => break,
            }
        }
    });
    let state = warp::any().map(move || assistant.clone());
    let socket = warp::path!("assistant" / String)
        .and(warp::ws())
        .and(warp::header::optional::<String>("origin"))
        .and(optional_user(auth.clone()))
        .and(state.clone())
        .then(socket_handler);
    let log = warp::path!("assistant" / String / "log")
        .and(warp::get())
        .and(optional_user(auth))
        .and(state)
        .then(log_handler);
    socket.or(log).boxed()
}

/// `GET /api/assistant/{room}`: the room's shared chat, as a WebSocket.
async fn socket_handler(
    room: String,
    ws: Ws,
    origin: Option<String>,
    user: Option<User>,
    state: Arc<Assistant>,
) -> warp::reply::Response {
    // Browsers always send Origin on WebSocket handshakes; checking it stops
    // other sites from opening the chat with a visitor's cookies.
    if !state.auth.same_origin(origin.as_deref()) {
        return json_error(StatusCode::FORBIDDEN, "Pad origin required");
    }
    match state.rooms.get(&room).await {
        Ok(Some(found)) if found.ended_at.is_some() && user.is_none() => {
            json_error(StatusCode::GONE, "Thank you for interviewing with Rebar.")
        }
        Ok(Some(_)) => {
            let chat = state.chat(&room).await;
            // A full 24 KB buffer, JSON-escaped, plus the question and selection.
            ws.max_message_size(160 * 1024)
                .on_upgrade(move |socket| state.connect(socket, chat))
                .into_response()
        }
        Ok(None) => json_error(StatusCode::NOT_FOUND, "Room not found"),
        Err(e) => {
            error!("loading room {room}: {e:#}");
            json_error(StatusCode::INTERNAL_SERVER_ERROR, "Internal error")
        }
    }
}

/// `GET /api/assistant/{room}/log`: every interaction in full, for interviewers.
async fn log_handler(
    room: String,
    user: Option<User>,
    state: Arc<Assistant>,
) -> Result<warp::reply::Response, Infallible> {
    if user.is_none() {
        return Ok(json_error(StatusCode::UNAUTHORIZED, "Sign in required"));
    }
    let entries = match &state.database {
        Some(db) => match db.load_assistant_log(&room).await {
            Ok(entries) => entries,
            Err(e) => {
                error!("loading assistant log for {room}: {e:#}");
                return Ok(json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal error",
                ));
            }
        },
        None => Vec::new(),
    };
    let entries: Vec<Value> = entries
        .into_iter()
        .map(|e| {
            let mut entry: Value = serde_json::from_str(&e.entry).unwrap_or(Value::Null);
            entry["id"] = json!(e.id);
            entry["createdAt"] = json!(e.created_at);
            entry
        })
        .collect();
    let mut reply = warp::reply::json(&entries).into_response();
    reply
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    Ok(reply)
}

#[cfg(test)]
mod tests {
    use super::*;
    use client::tests::completed;

    fn message(id: i64, role: &str, kind: &str, content: &str) -> AssistantMessage {
        AssistantMessage {
            id,
            created_at: 0,
            author: if role == "user" {
                "Ada".into()
            } else {
                String::new()
            },
            role: role.into(),
            kind: kind.into(),
            content: content.into(),
            patch: None,
            notice: None,
            applied_by: None,
        }
    }

    async fn fixture(replies: Vec<Result<Value, String>>) -> (Arc<Assistant>, Arc<Chat>, Database) {
        let (state, chat, db, _) = fixture_with_document(replies).await;
        (state, chat, db)
    }

    /// Also the room's live document, which applied edits change.
    async fn fixture_with_document(
        replies: Vec<Result<Value, String>>,
    ) -> (Arc<Assistant>, Arc<Chat>, Database, Arc<Rustpad>) {
        let document = Arc::new(Rustpad::default());
        let live = document.clone();
        let file = tempfile::NamedTempFile::new().unwrap();
        let db = Database::new(&format!("sqlite://{}", file.path().display()))
            .await
            .unwrap();
        // Keep the file for the test's lifetime.
        std::mem::forget(file);
        let rooms = Rooms::new(Some(db.clone()), Duration::from_secs(3600));
        let room = rooms.create("Loop", "ada@withrebar.ai").await.unwrap();
        let mut state = Assistant::new(
            rooms,
            AuthConfig::default(),
            Some(db.clone()),
            Arc::new(move |_| Some(live.clone())),
        );
        state.client = AssistantClient::scripted(replies);
        state.enabled = true;
        let state = Arc::new(state);
        let chat = state.chat(&room.id).await;
        (state, chat, db, document)
    }

    fn ask(message: &str, code: &str) -> String {
        json!({"type":"ask","message":message,"code":code,"language":"python","author":"Ada"})
            .to_string()
    }

    /// Wait until the chat is idle again.
    async fn settle(chat: &Chat) {
        for _ in 0..200 {
            if chat.state.lock().await.busy.is_none() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("assistant never finished");
    }

    #[test]
    fn history_keeps_ten_answered_exchanges_and_skips_errors() {
        let mut messages = Vec::new();
        for i in 0..15 {
            messages.push(message(2 * i, "user", "question", &format!("q{i}")));
            messages.push(message(2 * i + 1, "assistant", "answer", &format!("a{i}")));
        }
        messages.push(message(100, "user", "question", "failed"));
        messages.push(message(101, "assistant", "error", "boom"));
        let (history, asked) = history(&messages);
        assert_eq!(history.len(), HISTORY_MESSAGES);
        assert_eq!(history[0].content, "q5");
        assert_eq!(history[19].content, "a14");
        assert!(!asked);
    }

    #[test]
    fn history_notes_applied_edits_and_pending_questions() {
        let mut edit = message(1, "assistant", "edit", "Renamed it.");
        edit.patch = Some("@@\n-a\n+b".into());
        edit.applied_by = Some("Ada".into());
        let messages = vec![
            message(0, "user", "question", "rename"),
            edit,
            message(2, "user", "question", "now sort"),
            message(3, "assistant", "clarify", "By what?"),
        ];
        let (history, asked) = history(&messages);
        assert!(history[1]
            .content
            .contains("Proposed edit (applied by Ada)"));
        assert!(asked, "the last reply was a question");
    }

    #[test]
    fn history_respects_the_byte_budget() {
        let messages = vec![
            message(0, "user", "question", &"q".repeat(HISTORY_BYTES)),
            message(1, "assistant", "answer", "a"),
            message(2, "user", "question", "recent"),
            message(3, "assistant", "answer", "reply"),
        ];
        let (history, _) = history(&messages);
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].content, "recent");
    }

    #[tokio::test]
    async fn question_and_edit_are_shared_stored_and_logged() {
        let (state, chat, db) = fixture(vec![Ok(completed(
            json!({"kind":"edit","message":"Done.","code":"x = 2\n"}),
        ))])
        .await;
        let mut events = chat.events.subscribe();
        state
            .handle(&chat, &ask("make it 2", "x = 1\n"))
            .await
            .unwrap();
        settle(&chat).await;

        let mut kinds = Vec::new();
        while let Ok(event) = events.try_recv() {
            kinds.push(match event {
                Event::Message { message } => message.kind,
                Event::Busy { busy } => format!("busy={busy:?}"),
                _ => "other".into(),
            });
        }
        assert_eq!(
            kinds,
            ["busy=Some(\"Ada\")", "question", "edit", "busy=None"]
        );

        let stored = db.load_assistant_messages(&chat.room, 10).await.unwrap();
        assert_eq!(stored.len(), 2);
        assert_eq!(stored[0].author, "Ada");
        assert!(stored[1].patch.as_deref().unwrap().contains("+x = 2"));

        let log = db.load_assistant_log(&chat.room).await.unwrap();
        let entry: Value = serde_json::from_str(&log[0].entry).unwrap();
        assert_eq!(entry["question"], "make it 2");
        assert_eq!(entry["code"], "x = 1\n");
        assert_eq!(entry["attempts"].as_array().unwrap().len(), 1);
        assert!(entry["attempts"][0]["output"]
            .as_str()
            .unwrap()
            .contains("x = 2"));
        assert_eq!(entry["reply"]["kind"], "edit");

        // A fresh chat (after a restart) reloads the conversation.
        state.chats.lock().await.clear();
        let reloaded = state.chat(&chat.room).await;
        assert_eq!(reloaded.state.lock().await.messages.len(), 2);
    }

    #[tokio::test]
    async fn failures_are_shown_logged_and_forgotten() {
        let (state, chat, db) =
            fixture(vec![Err("OpenAI returned HTTP 500: overloaded".into())]).await;
        state.handle(&chat, &ask("q", "")).await.unwrap();
        settle(&chat).await;
        let messages = chat.state.lock().await.messages.clone();
        assert_eq!(messages[1].kind, "error");
        assert!(messages[1].content.contains("HTTP 500: overloaded"));
        assert!(history(&messages).0.is_empty());
        let entry: Value =
            serde_json::from_str(&db.load_assistant_log(&chat.room).await.unwrap()[0].entry)
                .unwrap();
        assert_eq!(entry["error"], "OpenAI returned HTTP 500: overloaded");
    }

    #[tokio::test]
    async fn one_question_at_a_time_and_no_clearing_mid_answer() {
        let (state, chat, _) = fixture(vec![]).await;
        chat.state.lock().await.busy = Some("Grace".into());
        let err = state.handle(&chat, &ask("q", "")).await.unwrap_err();
        assert!(err.contains("Grace"), "{err}");
        let err = state
            .handle(&chat, &json!({"type":"clear"}).to_string())
            .await
            .unwrap_err();
        assert!(err.contains("Wait"), "{err}");
    }

    #[tokio::test]
    async fn clear_hides_the_chat_but_keeps_the_log() {
        let (state, chat, db) = fixture(vec![Ok(completed(
            json!({"kind":"answer","message":"Hi.","code":null}),
        ))])
        .await;
        state.handle(&chat, &ask("hello", "")).await.unwrap();
        settle(&chat).await;
        state
            .handle(&chat, &json!({"type":"clear"}).to_string())
            .await
            .unwrap();
        assert!(chat.state.lock().await.messages.is_empty());
        assert!(db
            .load_assistant_messages(&chat.room, 10)
            .await
            .unwrap()
            .is_empty());
        assert_eq!(db.load_assistant_log(&chat.room).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn edits_apply_once_on_the_server_and_undo() {
        let (state, chat, db, document) = fixture_with_document(vec![Ok(completed(
            json!({"kind":"edit","message":"Done.","code":"def f():\n    x = 1\n    return x\n"}),
        ))])
        .await;
        let code = "def f():\n    return x\n";
        document.edit_text(|_| Ok(Some(code.into()))).unwrap();
        state.handle(&chat, &ask("q", code)).await.unwrap();
        settle(&chat).await;
        let id = chat.state.lock().await.messages[1].id;
        let apply = |name: &str| json!({"type":"apply","id":id,"author":name}).to_string();
        let undo = json!({"type":"undo","id":id}).to_string();
        let applied_by = || async {
            db.load_assistant_messages(&chat.room, 10).await.unwrap()[1]
                .applied_by
                .clone()
        };

        // Someone typed elsewhere meanwhile; the edit still lands, once.
        document
            .edit_text(|text| Ok(Some(format!("# notes\n{text}"))))
            .unwrap();
        state.handle(&chat, &apply("Ada")).await.unwrap();
        let err = state.handle(&chat, &apply("Grace")).await.unwrap_err();
        assert_eq!(err, "Ada already applied this edit.");
        assert_eq!(
            document.text(),
            "# notes\ndef f():\n    x = 1\n    return x\n"
        );
        assert_eq!(applied_by().await.as_deref(), Some("Ada"));

        state.handle(&chat, &undo).await.unwrap();
        assert_eq!(document.text(), "# notes\ndef f():\n    return x\n");
        assert_eq!(applied_by().await, None);
        assert!(state.handle(&chat, &undo).await.is_err(), "nothing to undo");

        // Someone's Ctrl+Z reverts an applied edit behind the chat's back.
        let reverted = document.text();
        state.handle(&chat, &apply("Ada")).await.unwrap();
        document.edit_text(|_| Ok(Some(reverted.clone()))).unwrap();
        // Undo just records it; the code is left alone.
        state.handle(&chat, &undo).await.unwrap();
        assert_eq!(document.text(), reverted);
        assert_eq!(applied_by().await, None);
        // And Apply works again after a Ctrl+Z, too.
        state.handle(&chat, &apply("Ada")).await.unwrap();
        document.edit_text(|_| Ok(Some(reverted.clone()))).unwrap();
        state.handle(&chat, &apply("Grace")).await.unwrap();
        assert_eq!(applied_by().await.as_deref(), Some("Grace"));
        assert!(document.text().contains("    x = 1\n"));
        state.handle(&chat, &undo).await.unwrap();
        assert_eq!(document.text(), reverted);

        // Applied, then edited right where it landed: Undo refuses rather
        // than pretend, and the edit stays marked applied.
        state.handle(&chat, &apply("Ada")).await.unwrap();
        document
            .edit_text(|text| Ok(Some(text.replace("    return x\n", "    return x + 1\n"))))
            .unwrap();
        let err = state.handle(&chat, &undo).await.unwrap_err();
        assert!(err.contains("modified since"), "{err}");
        assert!(document.text().contains("    x = 1\n    return x + 1\n"));
        assert_eq!(applied_by().await.as_deref(), Some("Ada"));

        // Code the edit changes was rewritten: refused, document untouched.
        document
            .edit_text(|_| Ok(Some("def g():\n    pass\n".into())))
            .unwrap();
        let err = state.handle(&chat, &apply("Ada")).await.unwrap_err();
        assert!(err.contains("modified after it was proposed"), "{err}");
        assert_eq!(document.text(), "def g():\n    pass\n");
        assert_eq!(applied_by().await.as_deref(), Some("Ada"), "unchanged");

        let question = json!({"type":"apply","id":id - 1}).to_string();
        let err = state.handle(&chat, &question).await.unwrap_err();
        assert!(err.contains("no longer"), "questions have no edit");
    }

    #[tokio::test]
    async fn read_only_rooms_and_bad_input_never_reach_model() {
        let (state, chat, _) = fixture(vec![]).await;
        for request in [
            ask("", ""),
            ask("q", &"x".repeat(MAX_CODE_BYTES + 1)),
            "not json".into(),
        ] {
            assert!(state.handle(&chat, &request).await.is_err());
        }
        let rooms = Rooms::new(None, Duration::ZERO);
        let room = rooms.create("Done", "ada@withrebar.ai").await.unwrap();
        let mut expired = Assistant::new(rooms, AuthConfig::default(), None, Arc::new(|_| None));
        expired.enabled = true;
        let expired = Arc::new(expired);
        let chat = expired.chat(&room.id).await;
        let err = expired.handle(&chat, &ask("q", "")).await.unwrap_err();
        assert_eq!(err, "This room is read-only.");
        assert!(state.client.sent().is_empty());
    }
}
