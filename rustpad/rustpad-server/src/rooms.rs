//! Interview rooms: created by signed-in interviewers, writable for a fixed
//! window after creation, then read-only forever.

use std::sync::Arc;
use std::time::{Duration, SystemTime};

use anyhow::Result;
use dashmap::DashMap;
use rand::{seq::SliceRandom, Rng};
use serde::{Deserialize, Serialize};

use crate::database::Database;

/// An interview room.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Room {
    /// Unguessable room ID used in the URL.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Email of the interviewer who created the room.
    pub created_by: String,
    /// Creation time, in milliseconds since the Unix epoch.
    pub created_at: i64,
    /// End of the writable window, in milliseconds since the Unix epoch.
    pub expires_at: i64,
    /// When the creator ended the interview, if ended manually.
    pub ended_at: Option<i64>,
}

impl Room {
    /// Whether edits, the assistant and code execution are still allowed.
    pub fn writable(&self) -> bool {
        self.ended_at.is_none() && now_ms() < self.expires_at
    }

    /// Time left in the writable window.
    pub fn remaining(&self) -> Duration {
        Duration::from_millis(self.expires_at.saturating_sub(now_ms()).max(0) as u64)
    }
}

/// Current time in milliseconds since the Unix epoch.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .expect("SystemTime returned before UNIX_EPOCH")
        .as_millis() as i64
}

/// Room registry, backed by the database when persistence is enabled.
#[derive(Clone)]
pub struct Rooms {
    memory: Arc<DashMap<String, Room>>,
    database: Option<Database>,
    ttl: Duration,
}

impl Rooms {
    /// Construct a registry whose rooms stay writable for `ttl`.
    pub fn new(database: Option<Database>, ttl: Duration) -> Self {
        Self {
            memory: Default::default(),
            database,
            ttl,
        }
    }

    /// Look up a room by ID.
    pub async fn get(&self, id: &str) -> Result<Option<Room>> {
        if let Some(room) = self.memory.get(id) {
            return Ok(Some(room.clone()));
        }
        let Some(db) = &self.database else {
            return Ok(None);
        };
        let room = db.load_room(id).await?;
        if let Some(room) = &room {
            return Ok(Some(
                self.memory
                    .entry(id.to_owned())
                    .or_insert_with(|| room.clone())
                    .clone(),
            ));
        }
        Ok(room)
    }

    /// Create a new room.
    pub async fn create(&self, name: &str, created_by: &str) -> Result<Room> {
        let created_at = now_ms();
        let room = Room {
            id: room_id(),
            name: name.to_owned(),
            created_by: created_by.to_owned(),
            created_at,
            expires_at: created_at + self.ttl.as_millis() as i64,
            ended_at: None,
        };
        if let Some(db) = &self.database {
            db.store_room(&room).await?;
        }
        self.memory.insert(room.id.clone(), room.clone());
        Ok(room)
    }

    /// Permanently end a room. The caller must authorize its creator first.
    pub async fn end(&self, mut room: Room) -> Result<Room> {
        room.ended_at.get_or_insert_with(now_ms);
        if let Some(db) = &self.database {
            db.end_room(&room).await?;
        }
        self.memory.insert(room.id.clone(), room.clone());
        Ok(room)
    }

    /// All rooms, newest first.
    pub async fn list(&self) -> Result<Vec<Room>> {
        if let Some(db) = &self.database {
            return db.list_rooms().await;
        }
        let mut rooms: Vec<Room> = self.memory.iter().map(|r| r.value().clone()).collect();
        rooms.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(rooms)
    }
}

/// Request body for creating a room.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateRoom {
    /// Optional display name; blank means a generated gamertag.
    #[serde(default)]
    pub name: String,
}

/// Maximum length of a room name, in characters.
pub const MAX_NAME_CHARS: usize = 80;

fn room_id() -> String {
    const CHARS: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let mut rng = rand::thread_rng();
    (0..12)
        .map(|_| *CHARS.choose(&mut rng).expect("non-empty") as char)
        .collect()
}

/// Generate an Xbox-style gamertag, e.g. `TurboWalrus73`.
pub fn gamertag() -> String {
    const ADJECTIVES: &[&str] = &[
        "Atomic", "Blazing", "Cosmic", "Crispy", "Dapper", "Electric", "Feral", "Frosty", "Funky",
        "Galactic", "Glitchy", "Groovy", "Hyper", "Jolly", "Lunar", "Mighty", "Neon", "Nimble",
        "Pixel", "Quantum", "Rapid", "Rogue", "Salty", "Shadow", "Sneaky", "Sonic", "Spicy",
        "Stealthy", "Turbo", "Vivid", "Wily", "Zesty",
    ];
    const NOUNS: &[&str] = &[
        "Badger", "Bison", "Cobra", "Comet", "Coyote", "Falcon", "Ferret", "Gecko", "Goblin",
        "Hornet", "Jackal", "Kraken", "Lemur", "Lynx", "Mantis", "Moose", "Narwhal", "Ninja",
        "Otter", "Panda", "Pelican", "Phoenix", "Raptor", "Raven", "Rhino", "Squid", "Tiger",
        "Toucan", "Viper", "Walrus", "Wizard", "Yeti",
    ];
    let mut rng = rand::thread_rng();
    format!(
        "{}{}{:02}",
        ADJECTIVES.choose(&mut rng).expect("non-empty"),
        NOUNS.choose(&mut rng).expect("non-empty"),
        rng.gen_range(0..100)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_long_and_alphanumeric() {
        let id = room_id();
        assert_eq!(id.len(), 12);
        assert!(id.bytes().all(|b| b.is_ascii_alphanumeric()));
        assert_ne!(room_id(), room_id());
    }

    #[test]
    fn gamertags_look_like_gamertags() {
        let tag = gamertag();
        assert!(tag.chars().next().unwrap().is_ascii_uppercase());
        assert!(tag[tag.len() - 2..].bytes().all(|b| b.is_ascii_digit()));
    }

    #[tokio::test]
    async fn rooms_lock_after_ttl() {
        let rooms = Rooms::new(None, Duration::from_millis(50));
        let room = rooms.create("Loop", "ada@withrebar.ai").await.unwrap();
        assert!(room.writable());
        assert_eq!(rooms.get(&room.id).await.unwrap(), Some(room.clone()));
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert!(!room.writable());
        assert_eq!(room.remaining(), Duration::ZERO);
    }
}
