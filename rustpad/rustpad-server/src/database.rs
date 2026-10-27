//! Backend SQLite database handlers for persisting documents.

use std::str::FromStr;

use anyhow::{bail, Result};
use serde::Serialize;
use sqlx::{sqlite::SqliteConnectOptions, ConnectOptions, SqlitePool};

use crate::rooms::Room;

/// Represents a document persisted in database storage.
#[derive(sqlx::FromRow, PartialEq, Eq, Clone, Debug)]
pub struct PersistedDocument {
    /// Text content of the document.
    pub text: String,
    /// Language of the document for editor syntax highlighting.
    pub language: Option<String>,
}

/// One message in a room's shared Interview Assistant chat.
#[derive(sqlx::FromRow, Serialize, PartialEq, Eq, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AssistantMessage {
    /// Unique ID, increasing in chat order.
    pub id: i64,
    /// Milliseconds since the Unix epoch.
    pub created_at: i64,
    /// Display name of whoever asked; empty for the assistant.
    pub author: String,
    /// `user` or `assistant`.
    pub role: String,
    /// `question` for user messages; `edit`, `clarify`, `answer` or `error`
    /// for the assistant.
    pub kind: String,
    /// The question, or the assistant's reply.
    pub content: String,
    /// Proposed edit, as a context-anchored patch.
    pub patch: Option<String>,
    /// Note from the server about the reply, such as a dropped edit.
    pub notice: Option<String>,
    /// Who applied the proposed edit, once applied.
    pub applied_by: Option<String>,
}

/// One logged assistant interaction.
#[derive(sqlx::FromRow, Serialize, PartialEq, Eq, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AssistantLog {
    /// Log row ID.
    pub id: i64,
    /// Milliseconds since the Unix epoch.
    pub created_at: i64,
    /// The full interaction, as JSON.
    pub entry: String,
}

/// A driver for database operations wrapping a pool connection.
#[derive(Clone, Debug)]
pub struct Database {
    pool: SqlitePool,
}

impl Database {
    /// Construct a new database from Postgres connection URI.
    pub async fn new(uri: &str) -> Result<Self> {
        {
            // Create database file if missing, and run migrations.
            let mut conn = SqliteConnectOptions::from_str(uri)?
                .create_if_missing(true)
                .connect()
                .await?;
            sqlx::migrate!().run(&mut conn).await?;
        }
        Ok(Database {
            pool: SqlitePool::connect(uri).await?,
        })
    }

    /// Load the text of a document from the database.
    pub async fn load(&self, document_id: &str) -> Result<PersistedDocument> {
        sqlx::query_as(r#"SELECT text, language FROM document WHERE id = $1"#)
            .bind(document_id)
            .fetch_one(&self.pool)
            .await
            .map_err(|e| e.into())
    }

    /// Store the text of a document in the database.
    pub async fn store(&self, document_id: &str, document: &PersistedDocument) -> Result<()> {
        let result = sqlx::query(
            r#"
INSERT INTO
    document (id, text, language)
VALUES
    ($1, $2, $3)
ON CONFLICT(id) DO UPDATE SET
    text = excluded.text,
    language = excluded.language"#,
        )
        .bind(document_id)
        .bind(&document.text)
        .bind(&document.language)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() != 1 {
            bail!(
                "expected store() to receive 1 row affected, but it affected {} rows instead",
                result.rows_affected(),
            );
        }
        Ok(())
    }

    /// Load a room by ID.
    pub async fn load_room(&self, id: &str) -> Result<Option<Room>> {
        sqlx::query_as(
            r#"SELECT id, name, created_by, created_at, expires_at, ended_at FROM room WHERE id = $1"#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| e.into())
    }

    /// Insert a new room.
    pub async fn store_room(&self, room: &Room) -> Result<()> {
        sqlx::query(
            r#"
INSERT INTO
    room (id, name, created_by, created_at, expires_at)
VALUES
    ($1, $2, $3, $4, $5)"#,
        )
        .bind(&room.id)
        .bind(&room.name)
        .bind(&room.created_by)
        .bind(room.created_at)
        .bind(room.expires_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Persist the permanent end of an interview.
    pub async fn end_room(&self, room: &Room) -> Result<()> {
        sqlx::query("UPDATE room SET ended_at = COALESCE(ended_at, $2) WHERE id = $1")
            .bind(&room.id)
            .bind(room.ended_at)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// List all rooms, newest first.
    pub async fn list_rooms(&self) -> Result<Vec<Room>> {
        sqlx::query_as(
            // Pads migrated from before rooms existed have no creator; they stay
            // reachable by link but don't belong on the dashboard.
            r#"SELECT id, name, created_by, created_at, expires_at, ended_at FROM room WHERE created_by != '' ORDER BY created_at DESC LIMIT 500"#,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.into())
    }

    /// Count the number of documents in the database.
    pub async fn count(&self) -> Result<usize> {
        let row: (i64,) = sqlx::query_as("SELECT count(*) FROM document")
            .fetch_one(&self.pool)
            .await?;
        Ok(row.0 as usize)
    }

    /// Store an assistant chat message, returning its ID.
    pub async fn insert_assistant_message(
        &self,
        room_id: &str,
        message: &AssistantMessage,
    ) -> Result<i64> {
        let result = sqlx::query(
            r#"
INSERT INTO
    assistant_message (room_id, created_at, author, role, kind, content, patch, notice)
VALUES
    ($1, $2, $3, $4, $5, $6, $7, $8)"#,
        )
        .bind(room_id)
        .bind(message.created_at)
        .bind(&message.author)
        .bind(&message.role)
        .bind(&message.kind)
        .bind(&message.content)
        .bind(&message.patch)
        .bind(&message.notice)
        .execute(&self.pool)
        .await?;
        Ok(result.last_insert_rowid())
    }

    /// The newest `limit` uncleared chat messages of a room, oldest first.
    pub async fn load_assistant_messages(
        &self,
        room_id: &str,
        limit: u32,
    ) -> Result<Vec<AssistantMessage>> {
        let mut messages: Vec<AssistantMessage> = sqlx::query_as(
            r#"
SELECT id, created_at, author, role, kind, content, patch, notice, applied_by
FROM assistant_message
WHERE room_id = $1 AND cleared = 0
ORDER BY id DESC
LIMIT $2"#,
        )
        .bind(room_id)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        messages.reverse();
        Ok(messages)
    }

    /// Record who applied a proposed edit, or clear it if applying failed.
    pub async fn set_assistant_applied(&self, id: i64, applied_by: Option<&str>) -> Result<()> {
        sqlx::query("UPDATE assistant_message SET applied_by = $2 WHERE id = $1")
            .bind(id)
            .bind(applied_by)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Hide a room's chat from the panel and the model. The rows stay for review.
    pub async fn clear_assistant_messages(&self, room_id: &str) -> Result<()> {
        sqlx::query("UPDATE assistant_message SET cleared = 1 WHERE room_id = $1")
            .bind(room_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Log one assistant interaction.
    pub async fn insert_assistant_log(
        &self,
        room_id: &str,
        created_at: i64,
        entry: &str,
    ) -> Result<()> {
        sqlx::query("INSERT INTO assistant_log (room_id, created_at, entry) VALUES ($1, $2, $3)")
            .bind(room_id)
            .bind(created_at)
            .bind(entry)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Every logged assistant interaction of a room, oldest first.
    pub async fn load_assistant_log(&self, room_id: &str) -> Result<Vec<AssistantLog>> {
        sqlx::query_as(
            "SELECT id, created_at, entry FROM assistant_log WHERE room_id = $1 ORDER BY id",
        )
        .bind(room_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.into())
    }
}
