//! Tests for the Interview Assistant's room chat socket and interaction log.

use anyhow::Result;
use common::*;
use rustpad_server::{auth::AuthConfig, server, ServerConfig};
use serde_json::{json, Value};

pub mod common;

#[tokio::test]
async fn test_chat_socket_requires_pad_origin() -> Result<()> {
    let filter = server(ServerConfig::default());
    let id = create_room(&filter).await;
    let refused = warp::test::ws()
        .path(&format!("/api/assistant/{id}"))
        .header("origin", "https://evil.example")
        .handshake(filter.clone())
        .await;
    assert!(refused.is_err());
    Ok(())
}

#[tokio::test]
async fn test_chat_socket_sends_snapshot_and_errors() -> Result<()> {
    let filter = server(ServerConfig::default());
    let id = create_room(&filter).await;
    let client = warp::test::ws()
        .path(&format!("/api/assistant/{id}"))
        .header("origin", AuthConfig::default().public_origin)
        .handshake(filter.clone())
        .await?;
    let mut socket = JsonSocket::from(client);
    let snapshot = socket.recv().await?;
    assert_eq!(
        snapshot,
        json!({"type": "snapshot", "messages": [], "busy": null})
    );
    socket
        .send(&json!({"type": "ask", "message": "hi", "code": "", "language": "python"}))
        .await;
    let error = socket.recv().await?;
    assert_eq!(error["type"], "error");
    assert_eq!(error["request"], "ask");
    assert_eq!(
        error["error"],
        "The Interview Assistant is turned off on this server."
    );
    Ok(())
}

#[tokio::test]
async fn test_log_requires_sign_in() -> Result<()> {
    let filter = server(ServerConfig::default());
    let id = create_room(&filter).await;
    let resp = warp::test::request()
        .path(&format!("/api/assistant/{id}/log"))
        .reply(&filter)
        .await;
    assert_eq!(resp.status(), 401);
    let resp = warp::test::request()
        .path(&format!("/api/assistant/{id}/log"))
        .header("cookie", session_cookie())
        .reply(&filter)
        .await;
    assert_eq!(resp.status(), 200);
    let entries: Value = serde_json::from_slice(resp.body())?;
    assert_eq!(entries, json!([]));
    Ok(())
}
