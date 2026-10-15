//! Backend SQLite database handlers for persisting documents.

use std::str::FromStr;

use anyhow::{bail, Result};
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
            r#"SELECT id, name, created_by, created_at, expires_at FROM room WHERE id = $1"#,
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

    /// List all rooms, newest first.
    pub async fn list_rooms(&self) -> Result<Vec<Room>> {
        sqlx::query_as(
            // Pads migrated from before rooms existed have no creator; they stay
            // reachable by link but don't belong on the dashboard.
            r#"SELECT id, name, created_by, created_at, expires_at FROM room WHERE created_by != '' ORDER BY created_at DESC LIMIT 500"#,
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
}
