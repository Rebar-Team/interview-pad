use anyhow::{anyhow, Result};
use rustpad_server::auth::{AuthConfig, User};
use serde_json::{json, Value};
use warp::{filters::BoxedFilter, test::WsClient, Reply};

/// A test WebSocket client that sends and receives JSON messages.
pub struct JsonSocket(WsClient);

impl JsonSocket {
    pub async fn send(&mut self, msg: &Value) {
        self.0.send_text(msg.to_string()).await
    }

    /// Receive the next message, skipping room metadata.
    pub async fn recv(&mut self) -> Result<Value> {
        loop {
            let msg = self.recv_raw().await?;
            if msg.get("Room").is_none() {
                return Ok(msg);
            }
        }
    }

    /// Receive the next message, including room metadata.
    pub async fn recv_raw(&mut self) -> Result<Value> {
        let msg = self.0.recv().await?;
        let msg = msg.to_str().map_err(|_| anyhow!("non-string message"))?;
        Ok(serde_json::from_str(msg)?)
    }

    /// Expect the socket to close, allowing room metadata before it does.
    pub async fn recv_closed(&mut self) -> Result<()> {
        loop {
            let Ok(msg) = self.0.recv().await else {
                return Ok(());
            };
            let value: Value = serde_json::from_str(msg.to_str().unwrap_or("null"))?;
            if value.get("Room").is_none() {
                return Err(anyhow!("expected close, got {value}"));
            }
        }
    }
}

/// Connect a new test client WebSocket.
pub async fn connect(
    filter: &BoxedFilter<(impl Reply + 'static,)>,
    id: &str,
) -> Result<JsonSocket> {
    let client = warp::test::ws()
        .path(&format!("/api/socket/{}", id))
        .handshake(filter.clone())
        .await?;
    Ok(JsonSocket(client))
}

/// Check the text route.
pub async fn expect_text(filter: &BoxedFilter<(impl Reply + 'static,)>, id: &str, text: &str) {
    let resp = warp::test::request()
        .path(&format!("/api/text/{}", id))
        .reply(filter)
        .await;
    assert_eq!(resp.status(), 200);
    assert_eq!(resp.body(), text);
}

/// Session cookie for a signed-in interviewer under the default config.
pub fn session_cookie() -> String {
    let token = AuthConfig::default().mint_session(&User {
        email: "ada@withrebar.ai".into(),
        name: "Ada".into(),
        picture: None,
    });
    format!("rp_session={token}")
}

/// Create a room as a signed-in interviewer, returning its ID.
pub async fn create_room(filter: &BoxedFilter<(impl Reply + 'static,)>) -> String {
    let resp = warp::test::request()
        .method("POST")
        .path("/api/rooms")
        .header("cookie", session_cookie())
        .header("origin", AuthConfig::default().public_origin)
        .json(&json!({ "name": "" }))
        .reply(filter)
        .await;
    assert_eq!(resp.status(), 201);
    let room: Value = serde_json::from_slice(resp.body()).unwrap();
    room["id"].as_str().unwrap().to_owned()
}
