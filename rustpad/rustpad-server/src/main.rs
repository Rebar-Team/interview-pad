use std::time::Duration;

use log::warn;
use rand::Rng;
use rustpad_server::{
    auth::{AuthConfig, GoogleClient},
    database::Database,
    server, ServerConfig,
};

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

#[tokio::main]
async fn main() {
    dotenv::dotenv().ok();
    pretty_env_logger::init();

    let port = std::env::var("PORT")
        .unwrap_or_else(|_| String::from("3030"))
        .parse()
        .expect("Unable to parse PORT");

    let public_origin = env("PUBLIC_ORIGIN").unwrap_or_else(|| format!("http://127.0.0.1:{port}"));
    let session_secret = match env("SESSION_SECRET") {
        Some(secret) if secret.len() >= 32 => secret.into_bytes(),
        Some(_) => panic!("SESSION_SECRET must be at least 32 bytes"),
        None => {
            warn!("SESSION_SECRET is unset; sign-ins will not survive a restart");
            rand::thread_rng().gen::<[u8; 32]>().to_vec()
        }
    };
    let google = match (env("GOOGLE_CLIENT_ID"), env("GOOGLE_CLIENT_SECRET")) {
        (Some(client_id), Some(client_secret)) => Some(GoogleClient {
            client_id,
            client_secret,
        }),
        _ => {
            warn!("GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET unset; Google sign-in is disabled");
            None
        }
    };

    let config = ServerConfig {
        expiry_days: std::env::var("EXPIRY_DAYS")
            .unwrap_or_else(|_| String::from("1"))
            .parse()
            .expect("Unable to parse EXPIRY_DAYS"),
        database: match std::env::var("SQLITE_URI") {
            Ok(uri) => Some(
                Database::new(&uri)
                    .await
                    .expect("Unable to connect to SQLITE_URI"),
            ),
            Err(_) => None,
        },
        auth: AuthConfig {
            public_origin,
            session_secret,
            google,
            allowed_domain: env("GOOGLE_ALLOWED_DOMAIN").unwrap_or_else(|| "withrebar.ai".into()),
            dev_login_email: env("DEV_LOGIN_EMAIL"),
        },
        // Between a minute and a week.
        room_ttl: Duration::from_secs(
            env("ROOM_TTL_MINUTES")
                .map(|m| m.parse::<u64>().expect("Unable to parse ROOM_TTL_MINUTES"))
                .unwrap_or(6 * 60)
                .clamp(1, 7 * 24 * 60)
                * 60,
        ),
    };

    warp::serve(server(config)).run(([0, 0, 0, 0], port)).await;
}
