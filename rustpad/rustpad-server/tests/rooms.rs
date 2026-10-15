//! Tests for interviewer sign-in, room creation and the read-only window.

use std::time::Duration;

use anyhow::Result;
use common::*;
use operational_transform::OperationSeq;
use rustpad_server::{auth::AuthConfig, database::Database, server, ServerConfig};
use serde_json::{json, Value};
use tempfile::NamedTempFile;
use tokio::time;

pub mod common;

fn origin() -> String {
    AuthConfig::default().public_origin
}

#[tokio::test]
async fn test_rooms_require_sign_in() -> Result<()> {
    let filter = server(ServerConfig::default());

    for (method, path) in [
        ("GET", "/api/me"),
        ("GET", "/api/rooms"),
        ("GET", "/api/gamertag"),
    ] {
        let resp = warp::test::request()
            .method(method)
            .path(path)
            .reply(&filter)
            .await;
        assert_eq!(resp.status(), 401, "{method} {path}");
    }
    let resp = warp::test::request()
        .method("POST")
        .path("/api/rooms")
        .header("origin", origin())
        .json(&json!({ "name": "x" }))
        .reply(&filter)
        .await;
    assert_eq!(resp.status(), 401);

    // A forged cookie is no better than none.
    let resp = warp::test::request()
        .path("/api/me")
        .header(
            "cookie",
            "rp_session=eyJlbWFpbCI6ImV2ZUB3aXRocmViYXIuYWkifQ.AAAA",
        )
        .reply(&filter)
        .await;
    assert_eq!(resp.status(), 401);
    Ok(())
}

#[tokio::test]
async fn test_create_and_list_rooms() -> Result<()> {
    let filter = server(ServerConfig::default());

    let resp = warp::test::request()
        .path("/api/me")
        .header("cookie", session_cookie())
        .reply(&filter)
        .await;
    assert_eq!(resp.status(), 200);
    let me: Value = serde_json::from_slice(resp.body())?;
    assert_eq!(me["email"], "ada@withrebar.ai");
    assert_eq!(me["roomTtlMs"], 6 * 3600 * 1000);

    let resp = warp::test::request()
        .method("POST")
        .path("/api/rooms")
        .header("cookie", session_cookie())
        .header("origin", origin())
        .json(&json!({ "name": "  Backend loop  " }))
        .reply(&filter)
        .await;
    assert_eq!(resp.status(), 201);
    let named: Value = serde_json::from_slice(resp.body())?;
    assert_eq!(named["name"], "Backend loop");
    assert_eq!(named["createdBy"], "ada@withrebar.ai");
    assert_eq!(named["writable"], true);
    let six_hours = 6 * 3600 * 1000;
    assert_eq!(
        named["expiresAt"].as_i64().unwrap() - named["createdAt"].as_i64().unwrap(),
        six_hours
    );

    let generated = create_room(&filter).await;
    assert_eq!(generated.len(), 12);

    let resp = warp::test::request()
        .path("/api/rooms")
        .header("cookie", session_cookie())
        .reply(&filter)
        .await;
    let rooms: Vec<Value> = serde_json::from_slice(resp.body())?;
    assert_eq!(rooms.len(), 2);
    let tag = rooms
        .iter()
        .find(|r| r["id"] == generated.as_str())
        .unwrap();
    assert!(
        !tag["name"].as_str().unwrap().is_empty(),
        "blank name gets a gamertag"
    );

    // The public view hides who created the room.
    let resp = warp::test::request()
        .path(&format!("/api/rooms/{}", named["id"].as_str().unwrap()))
        .reply(&filter)
        .await;
    assert_eq!(resp.status(), 200);
    let public: Value = serde_json::from_slice(resp.body())?;
    assert_eq!(public["name"], "Backend loop");
    assert!(public.get("createdBy").is_none());
    assert!(public["serverNow"].is_i64());
    assert_eq!(public["assistant"], false, "no key in tests");

    let resp = warp::test::request()
        .path("/api/rooms/nope")
        .reply(&filter)
        .await;
    assert_eq!(resp.status(), 404);
    Ok(())
}

#[tokio::test]
async fn test_create_room_rejects_cross_origin_and_long_names() -> Result<()> {
    let filter = server(ServerConfig::default());
    let resp = warp::test::request()
        .method("POST")
        .path("/api/rooms")
        .header("cookie", session_cookie())
        .header("origin", "https://evil.example")
        .json(&json!({ "name": "x" }))
        .reply(&filter)
        .await;
    assert_eq!(resp.status(), 403);

    let resp = warp::test::request()
        .method("POST")
        .path("/api/rooms")
        .header("cookie", session_cookie())
        .header("origin", origin())
        .json(&json!({ "name": "x".repeat(81) }))
        .reply(&filter)
        .await;
    assert_eq!(resp.status(), 400);
    Ok(())
}

#[tokio::test]
async fn test_unknown_room_is_not_created_on_visit() -> Result<()> {
    let filter = server(ServerConfig::default());
    assert!(connect(&filter, "made-up").await.is_err());
    let resp = warp::test::request()
        .path("/api/text/made-up")
        .reply(&filter)
        .await;
    assert_eq!(resp.status(), 404);
    Ok(())
}

/// Fail instead of hanging if an expected message never arrives.
async fn within<T>(future: impl std::future::Future<Output = Result<T>>) -> Result<T> {
    time::timeout(Duration::from_secs(10), future).await?
}

#[tokio::test]
async fn test_room_turns_read_only() -> Result<()> {
    pretty_env_logger::try_init().ok();
    let filter = server(ServerConfig {
        room_ttl: Duration::from_secs(2),
        ..ServerConfig::default()
    });
    let id = create_room(&filter).await;

    let mut client = connect(&filter, &id).await?;
    assert_eq!(within(client.recv_raw()).await?, json!({ "Identity": 0 }));
    let room = within(client.recv_raw()).await?;
    assert_eq!(room["Room"]["writable"], true);
    assert!(room["Room"]["server_now"].is_i64());

    let mut operation = OperationSeq::default();
    operation.insert("hello");
    client
        .send(&json!({ "Edit": { "revision": 0, "operation": operation } }))
        .await;
    within(client.recv())
        .await?
        .get("History")
        .expect("edit accepted");
    expect_text(&filter, &id, "hello").await;

    // The server announces the lock to connected clients.
    let room = within(client.recv_raw()).await?;
    assert_eq!(room["Room"]["writable"], false);

    let mut operation = OperationSeq::default();
    operation.retain(5);
    operation.insert(" world");
    client
        .send(&json!({ "Edit": { "revision": 1, "operation": operation } }))
        .await;
    client.send(&json!({ "SetLanguage": "rust" })).await;
    // Messages are handled in order, so once this echo arrives the edit and
    // language change above have been processed (and dropped).
    client
        .send(&json!({ "ClientInfo": { "name": "Ada", "hue": 1 } }))
        .await;
    let echo = within(client.recv()).await?;
    assert!(echo.get("UserInfo").is_some(), "got {echo}");
    expect_text(&filter, &id, "hello").await;

    // Late joiners see the read-only state up front, before the history.
    let mut late = connect(&filter, &id).await?;
    assert_eq!(within(late.recv_raw()).await?, json!({ "Identity": 1 }));
    assert_eq!(within(late.recv_raw()).await?["Room"]["writable"], false);
    assert!(within(late.recv_raw()).await?.get("History").is_some());
    Ok(())
}

#[tokio::test]
async fn test_pty_gate() -> Result<()> {
    let open = server(ServerConfig::default());
    let id = create_room(&open).await;
    let gate = |filter, uri: String, origin: String| async move {
        warp::test::request()
            .path("/api/pty-auth")
            .header("x-forwarded-uri", uri)
            .header("origin", origin)
            .reply(filter)
            .await
    };

    let resp = gate(&open, format!("/pty/{id}"), origin()).await;
    assert_eq!(resp.status(), 204);
    assert!(resp.headers().contains_key("x-room-expires-at"));
    let resp = gate(&open, format!("/pty/{id}"), "https://evil.example".into()).await;
    assert_eq!(resp.status(), 403);
    let resp = gate(&open, "/pty/nope".into(), origin()).await;
    assert_eq!(resp.status(), 404);
    let resp = gate(&open, format!("/pty/{id}?x=1"), origin()).await;
    assert_eq!(resp.status(), 204);
    // Extra segments would become a different ptyd session; refuse them.
    for uri in [
        format!("/pty/{id}/extra"),
        format!("/pty/{id}%2F"),
        "/pty/".into(),
    ] {
        let resp = gate(&open, uri.clone(), origin()).await;
        assert_eq!(resp.status(), 404, "{uri}");
    }

    let locked = server(ServerConfig {
        room_ttl: Duration::ZERO,
        ..ServerConfig::default()
    });
    let id = create_room(&locked).await;
    let resp = gate(&locked, format!("/pty/{id}"), origin()).await;
    assert_eq!(resp.status(), 403);
    Ok(())
}

#[tokio::test]
async fn test_rooms_persist_across_restart() -> Result<()> {
    let path = NamedTempFile::new()?.into_temp_path();
    let uri = format!("sqlite://{}", path.to_str().unwrap());

    let filter = server(ServerConfig {
        database: Some(Database::new(&uri).await?),
        ..ServerConfig::default()
    });
    let id = create_room(&filter).await;

    let restarted = server(ServerConfig {
        database: Some(Database::new(&uri).await?),
        ..ServerConfig::default()
    });
    let resp = warp::test::request()
        .path(&format!("/api/rooms/{id}"))
        .reply(&restarted)
        .await;
    assert_eq!(resp.status(), 200);
    Ok(())
}

#[tokio::test]
async fn test_legacy_pads_become_read_only_rooms() -> Result<()> {
    use sqlx::{migrate::Migrator, sqlite::SqliteConnectOptions, ConnectOptions};
    use std::str::FromStr;

    // A database as production has it before rooms: only migration 1 applied.
    let path = NamedTempFile::new()?.into_temp_path();
    let uri = format!("sqlite://{}", path.to_str().unwrap());
    let v1 = tempfile::tempdir()?;
    std::fs::copy(
        concat!(env!("CARGO_MANIFEST_DIR"), "/migrations/1_document.sql"),
        v1.path().join("1_document.sql"),
    )?;
    {
        let mut conn = SqliteConnectOptions::from_str(&uri)?
            .create_if_missing(true)
            .connect()
            .await?;
        Migrator::new(v1.path()).await?.run(&mut conn).await?;
        sqlx::query("INSERT INTO document (id, text, language) VALUES ('legacy', 'old', NULL)")
            .execute(&mut conn)
            .await?;
    }

    // Upgrading runs the room migration.
    let filter = server(ServerConfig {
        database: Some(Database::new(&uri).await?),
        ..ServerConfig::default()
    });
    let resp = warp::test::request()
        .path("/api/rooms/legacy")
        .reply(&filter)
        .await;
    assert_eq!(resp.status(), 200);
    let room: Value = serde_json::from_slice(resp.body())?;
    assert_eq!(room["writable"], false);
    expect_text(&filter, "legacy", "old").await;

    // Readable by link, but kept off the dashboard.
    let resp = warp::test::request()
        .path("/api/rooms")
        .header("cookie", session_cookie())
        .reply(&filter)
        .await;
    let rooms: Vec<Value> = serde_json::from_slice(resp.body())?;
    assert!(rooms.is_empty());
    Ok(())
}

#[tokio::test]
async fn test_room_names_reject_hidden_characters() -> Result<()> {
    let filter = server(ServerConfig::default());
    for name in ["evil\u{202E}gnp", "zero\u{200B}width", "new\nline"] {
        let resp = warp::test::request()
            .method("POST")
            .path("/api/rooms")
            .header("cookie", session_cookie())
            .header("origin", origin())
            .json(&json!({ "name": name }))
            .reply(&filter)
            .await;
        assert_eq!(resp.status(), 400, "{name:?}");
    }
    Ok(())
}
