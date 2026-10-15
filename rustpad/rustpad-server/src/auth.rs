//! Google sign-in for interviewers, restricted to one Google Workspace domain.
//!
//! Candidates never sign in: they reach a room through its unguessable link.
//! Only the dashboard and room creation require a session.

use std::time::{Duration, SystemTime};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use hmac::{Hmac, Mac};
use log::{info, warn};
use rand::Rng;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;
use warp::{
    http::{header, Response, StatusCode},
    hyper::Body,
    Filter, Reply,
};

const SESSION_COOKIE: &str = "rp_session";
const OAUTH_COOKIE: &str = "rp_oauth";
const SESSION_TTL: Duration = Duration::from_secs(12 * 3600);
const OAUTH_TTL: Duration = Duration::from_secs(600);

/// Google OAuth client credentials.
#[derive(Clone)]
pub struct GoogleClient {
    /// OAuth client ID.
    pub client_id: String,
    /// OAuth client secret.
    pub client_secret: String,
}

/// Authentication settings.
#[derive(Clone)]
pub struct AuthConfig {
    /// Origin the browser uses to reach the server, e.g. `https://interview.withrebar.ai`.
    pub public_origin: String,
    /// Key for signing session cookies.
    pub session_secret: Vec<u8>,
    /// Google OAuth client, or `None` to disable Google sign-in.
    pub google: Option<GoogleClient>,
    /// Google Workspace domain whose members may sign in.
    pub allowed_domain: String,
    /// Email for passwordless sign-in at `/auth/dev`. Honored only on a loopback origin.
    pub dev_login_email: Option<String>,
}

impl std::fmt::Debug for AuthConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuthConfig")
            .field("public_origin", &self.public_origin)
            .field("google", &self.google.is_some())
            .field("allowed_domain", &self.allowed_domain)
            .field("dev_login_email", &self.dev_login_email)
            .finish_non_exhaustive()
    }
}

impl Default for AuthConfig {
    fn default() -> Self {
        Self {
            public_origin: "http://127.0.0.1:3030".into(),
            session_secret: b"insecure-default-session-secret".to_vec(),
            google: None,
            allowed_domain: "withrebar.ai".into(),
            dev_login_email: None,
        }
    }
}

/// A signed-in interviewer.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct User {
    /// Verified Google account email.
    pub email: String,
    /// Display name.
    pub name: String,
    /// Avatar URL, if Google provided one.
    pub picture: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Session {
    #[serde(flatten)]
    user: User,
    exp: u64,
}

#[derive(Serialize, Deserialize)]
struct OAuthState {
    state: String,
    nonce: String,
    next: String,
    exp: u64,
}

fn unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .expect("SystemTime returned before UNIX_EPOCH")
        .as_secs()
}

fn random_hex() -> String {
    format!("{:032x}", rand::thread_rng().gen::<u128>())
}

impl AuthConfig {
    fn secure(&self) -> bool {
        self.public_origin.starts_with("https://")
    }

    fn redirect_uri(&self) -> String {
        format!("{}/auth/callback", self.public_origin)
    }

    /// Dev sign-in is only ever available when the server is reached on loopback.
    fn dev_email(&self) -> Option<&str> {
        let loopback = ["http://127.0.0.1:", "http://localhost:"]
            .iter()
            .any(|prefix| self.public_origin.starts_with(prefix));
        self.dev_login_email.as_deref().filter(|_| loopback)
    }

    /// Sign `value` for one `purpose`, so a token minted for one use never
    /// verifies as another.
    fn sign<T: Serialize>(&self, purpose: &str, value: &T) -> String {
        let payload = B64.encode(serde_json::to_vec(value).expect("serializable"));
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.session_secret).expect("any key size");
        mac.update(purpose.as_bytes());
        mac.update(b".");
        mac.update(payload.as_bytes());
        format!("{payload}.{}", B64.encode(mac.finalize().into_bytes()))
    }

    fn verify<T: DeserializeOwned>(&self, purpose: &str, token: &str) -> Option<T> {
        let (payload, signature) = token.split_once('.')?;
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.session_secret).expect("any key size");
        mac.update(purpose.as_bytes());
        mac.update(b".");
        mac.update(payload.as_bytes());
        mac.verify_slice(&B64.decode(signature).ok()?).ok()?;
        serde_json::from_slice(&B64.decode(payload).ok()?).ok()
    }

    /// Mint a session cookie value for a user, as the OAuth callback does.
    pub fn mint_session(&self, user: &User) -> String {
        self.sign(
            "session",
            &Session {
                user: user.clone(),
                exp: unix_secs() + SESSION_TTL.as_secs(),
            },
        )
    }

    /// Resolve the user from a session cookie value, if valid and unexpired.
    pub fn user(&self, cookie: Option<&str>) -> Option<User> {
        let session: Session = self.verify("session", cookie?)?;
        (session.exp > unix_secs() && self.member(&session.user.email)).then_some(session.user)
    }

    fn member(&self, email: &str) -> bool {
        email.rsplit_once('@').map_or(false, |(_, domain)| {
            domain.eq_ignore_ascii_case(&self.allowed_domain)
        })
    }

    /// True when a browser request comes from our own origin.
    pub fn same_origin(&self, origin: Option<&str>) -> bool {
        origin == Some(self.public_origin.as_str())
    }

    fn cookie(&self, name: &str, value: &str, path: &str, max_age: Duration) -> String {
        format!(
            "{name}={value}; HttpOnly; SameSite=Lax; Path={path}; Max-Age={}{}",
            max_age.as_secs(),
            if self.secure() { "; Secure" } else { "" }
        )
    }

    /// Check an ID token received directly from Google's token endpoint.
    ///
    /// OIDC Core 3.1.3.7 allows TLS server validation of the token endpoint in
    /// place of checking the token signature, so this verifies claims only.
    fn verify_id_token(
        &self,
        id_token: &str,
        nonce: &str,
        client_id: &str,
    ) -> Result<User, &'static str> {
        let payload = id_token.split('.').nth(1).ok_or("exchange")?;
        let claims: Value = serde_json::from_slice(&B64.decode(payload).map_err(|_| "exchange")?)
            .map_err(|_| "exchange")?;
        let issuer_ok = matches!(
            claims["iss"].as_str(),
            Some("https://accounts.google.com" | "accounts.google.com")
        );
        if !issuer_ok
            || claims["aud"].as_str() != Some(client_id)
            || claims["exp"]
                .as_u64()
                .map_or(true, |exp| exp <= unix_secs())
            || claims["nonce"].as_str() != Some(nonce)
        {
            return Err("exchange");
        }
        let email = claims["email"].as_str().ok_or("exchange")?;
        // `hd` is only set for Workspace accounts, so a gmail.com account with
        // a look-alike address can never pass.
        if claims["email_verified"].as_bool() != Some(true)
            || !claims["hd"]
                .as_str()
                .map_or(false, |hd| hd.eq_ignore_ascii_case(&self.allowed_domain))
            || !self.member(email)
        {
            return Err("domain");
        }
        Ok(User {
            email: email.to_lowercase(),
            name: claims["name"].as_str().unwrap_or(email).to_owned(),
            picture: claims["picture"].as_str().map(str::to_owned),
        })
    }
}

/// Only same-site relative paths, so `next` can never redirect off-site.
/// Only plain same-site app paths, so `next` can never redirect off-site.
/// Browsers drop tabs and newlines from URLs, so anything beyond a strict
/// character set could turn `/\t/evil.example` into `//evil.example`.
fn safe_next(next: Option<String>) -> String {
    next.filter(|n| {
        n.starts_with('/')
            && !n.starts_with("//")
            && n.len() <= 256
            && n.bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'_' | b'-'))
    })
    .unwrap_or_else(|| "/".into())
}

fn redirect(location: &str) -> Response<Body> {
    let location = header::HeaderValue::from_str(location)
        .unwrap_or_else(|_| header::HeaderValue::from_static("/"));
    Response::builder()
        .status(StatusCode::FOUND)
        .header(header::LOCATION, location)
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::empty())
        .expect("valid response")
}

/// JSON error reply.
pub fn json_error(status: StatusCode, message: &str) -> Response<Body> {
    let mut reply =
        warp::reply::with_status(warp::reply::json(&json!({ "error": message })), status)
            .into_response();
    reply
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    reply
}

/// Extracts the session user, if any.
pub fn optional_user(
    auth: AuthConfig,
) -> impl Filter<Extract = (Option<User>,), Error = std::convert::Infallible> + Clone {
    warp::cookie::optional::<String>(SESSION_COOKIE)
        .map(move |cookie: Option<String>| auth.user(cookie.as_deref()))
}

#[derive(Deserialize)]
struct LoginQuery {
    next: Option<String>,
}

#[derive(Deserialize)]
struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
}

#[derive(Deserialize)]
struct DevQuery {
    email: Option<String>,
    next: Option<String>,
}

/// Routes under `/auth`.
pub fn routes(auth: AuthConfig) -> warp::filters::BoxedFilter<(Response<Body>,)> {
    let with_auth = {
        let auth = auth.clone();
        warp::any().map(move || auth.clone())
    };
    let http = reqwest::Client::builder()
        .https_only(true)
        .timeout(Duration::from_secs(15))
        .build()
        .expect("HTTP client");

    let login = warp::path!("auth" / "login")
        .and(warp::get())
        .and(warp::query::<LoginQuery>())
        .and(with_auth.clone())
        .map(login);

    let callback = warp::path!("auth" / "callback")
        .and(warp::get())
        .and(warp::query::<CallbackQuery>())
        .and(warp::cookie::optional::<String>(OAUTH_COOKIE))
        .and(with_auth.clone())
        .and(warp::any().map(move || http.clone()))
        .then(callback);

    let logout = warp::path!("auth" / "logout")
        .and(warp::post())
        .and(warp::header::optional::<String>("origin"))
        .and(with_auth.clone())
        .map(|origin: Option<String>, auth: AuthConfig| {
            if !auth.same_origin(origin.as_deref()) {
                return json_error(StatusCode::FORBIDDEN, "Cross-origin request refused");
            }
            Response::builder()
                .status(StatusCode::NO_CONTENT)
                .header(
                    header::SET_COOKIE,
                    auth.cookie(SESSION_COOKIE, "", "/", Duration::ZERO),
                )
                .body(Body::empty())
                .expect("valid response")
        });

    let dev = warp::path!("auth" / "dev")
        .and(warp::get())
        .and(warp::query::<DevQuery>())
        .and(with_auth)
        .map(|query: DevQuery, auth: AuthConfig| {
            let Some(default_email) = auth.dev_email() else {
                return json_error(StatusCode::NOT_FOUND, "Not found");
            };
            let email = query
                .email
                .unwrap_or_else(|| default_email.to_owned())
                .to_lowercase();
            if !auth.member(&email) {
                return redirect("/?auth_error=domain");
            }
            let user = User {
                name: email.split('@').next().unwrap_or_default().to_owned(),
                email,
                picture: None,
            };
            let mut reply = redirect(&safe_next(query.next));
            reply.headers_mut().insert(
                header::SET_COOKIE,
                auth.cookie(SESSION_COOKIE, &auth.mint_session(&user), "/", SESSION_TTL)
                    .parse()
                    .unwrap(),
            );
            reply
        });

    login
        .or(callback)
        .unify()
        .or(logout)
        .unify()
        .or(dev)
        .unify()
        .boxed()
}

fn login(query: LoginQuery, auth: AuthConfig) -> Response<Body> {
    let Some(google) = &auth.google else {
        return redirect("/?auth_error=config");
    };
    let flow = OAuthState {
        state: random_hex(),
        nonce: random_hex(),
        next: safe_next(query.next),
        exp: unix_secs() + OAUTH_TTL.as_secs(),
    };
    let url = reqwest::Url::parse_with_params(
        "https://accounts.google.com/o/oauth2/v2/auth",
        &[
            ("client_id", google.client_id.as_str()),
            ("redirect_uri", &auth.redirect_uri()),
            ("response_type", "code"),
            ("scope", "openid email profile"),
            ("state", &flow.state),
            ("nonce", &flow.nonce),
            ("hd", &auth.allowed_domain),
            ("prompt", "select_account"),
        ],
    )
    .expect("valid URL");
    let mut reply = redirect(url.as_str());
    reply.headers_mut().insert(
        header::SET_COOKIE,
        auth.cookie(OAUTH_COOKIE, &auth.sign("oauth", &flow), "/auth", OAUTH_TTL)
            .parse()
            .unwrap(),
    );
    reply
}

async fn callback(
    query: CallbackQuery,
    cookie: Option<String>,
    auth: AuthConfig,
    http: reqwest::Client,
) -> Response<Body> {
    let result = async {
        let google = auth.google.as_ref().ok_or("config")?;
        let flow: OAuthState = cookie
            .as_deref()
            .and_then(|c| auth.verify("oauth", c))
            .filter(|f: &OAuthState| f.exp > unix_secs())
            .ok_or("state")?;
        if query.state.as_deref() != Some(flow.state.as_str()) {
            return Err("state");
        }
        let code = query.code.ok_or("exchange")?;
        let response = http
            .post("https://oauth2.googleapis.com/token")
            .form(&[
                ("code", code.as_str()),
                ("client_id", &google.client_id),
                ("client_secret", &google.client_secret),
                ("redirect_uri", &auth.redirect_uri()),
                ("grant_type", "authorization_code"),
            ])
            .send()
            .await
            .map_err(|_| "exchange")?;
        if !response.status().is_success() {
            warn!("Google token exchange returned HTTP {}", response.status());
            return Err("exchange");
        }
        let tokens: Value = response.json().await.map_err(|_| "exchange")?;
        let id_token = tokens["id_token"].as_str().ok_or("exchange")?;
        let user = auth.verify_id_token(id_token, &flow.nonce, &google.client_id)?;
        Ok((user, flow.next))
    }
    .await;

    let mut reply = match &result {
        Ok((user, next)) => {
            info!("{} signed in", user.email);
            redirect(next)
        }
        Err(code) => {
            warn!("sign-in refused: {code}");
            redirect(&format!("/?auth_error={code}"))
        }
    };
    let headers = reply.headers_mut();
    headers.append(
        header::SET_COOKIE,
        auth.cookie(OAUTH_COOKIE, "", "/auth", Duration::ZERO)
            .parse()
            .unwrap(),
    );
    if let Ok((user, _)) = &result {
        headers.append(
            header::SET_COOKIE,
            auth.cookie(SESSION_COOKIE, &auth.mint_session(user), "/", SESSION_TTL)
                .parse()
                .unwrap(),
        );
    }
    reply
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> AuthConfig {
        AuthConfig {
            google: Some(GoogleClient {
                client_id: "client".into(),
                client_secret: "secret".into(),
            }),
            ..AuthConfig::default()
        }
    }

    fn id_token(claims: Value) -> String {
        format!("e30.{}.sig", B64.encode(claims.to_string()))
    }

    fn claims() -> Value {
        json!({
            "iss": "https://accounts.google.com", "aud": "client", "exp": unix_secs() + 60,
            "nonce": "n", "email": "Ada@withrebar.ai", "email_verified": true,
            "hd": "withrebar.ai", "name": "Ada",
        })
    }

    #[test]
    fn sessions_round_trip_and_reject_tampering() {
        let auth = config();
        let user = User {
            email: "ada@withrebar.ai".into(),
            name: "Ada".into(),
            picture: None,
        };
        let token = auth.mint_session(&user);
        assert_eq!(auth.user(Some(&token)), Some(user));

        let (_, signature) = token.split_once('.').unwrap();
        let forged = B64.encode(
            br#"{"email":"eve@withrebar.ai","name":"Eve","picture":null,"exp":99999999999}"#,
        );
        assert_eq!(auth.user(Some(&format!("{forged}.{signature}"))), None);

        let other = AuthConfig {
            session_secret: b"other".to_vec(),
            ..config()
        };
        assert_eq!(other.user(Some(&token)), None);
    }

    #[test]
    fn sessions_from_other_domains_are_rejected() {
        let auth = config();
        let token = auth.mint_session(&User {
            email: "eve@gmail.com".into(),
            name: "Eve".into(),
            picture: None,
        });
        assert_eq!(auth.user(Some(&token)), None);
    }

    #[test]
    fn id_token_requires_workspace_domain() {
        let auth = config();
        let user = auth
            .verify_id_token(&id_token(claims()), "n", "client")
            .unwrap();
        assert_eq!(user.email, "ada@withrebar.ai");

        let mut gmail = claims();
        gmail["email"] = json!("ada@gmail.com");
        gmail.as_object_mut().unwrap().remove("hd");
        assert_eq!(
            auth.verify_id_token(&id_token(gmail), "n", "client"),
            Err("domain")
        );

        let mut other_hd = claims();
        other_hd["hd"] = json!("evil.example");
        assert_eq!(
            auth.verify_id_token(&id_token(other_hd), "n", "client"),
            Err("domain")
        );

        let mut unverified = claims();
        unverified["email_verified"] = json!(false);
        assert_eq!(
            auth.verify_id_token(&id_token(unverified), "n", "client"),
            Err("domain")
        );
    }

    #[test]
    fn id_token_checks_audience_nonce_and_expiry() {
        let auth = config();
        assert_eq!(
            auth.verify_id_token(&id_token(claims()), "other", "client"),
            Err("exchange")
        );
        assert_eq!(
            auth.verify_id_token(&id_token(claims()), "n", "other"),
            Err("exchange")
        );
        let mut expired = claims();
        expired["exp"] = json!(unix_secs() - 1);
        assert_eq!(
            auth.verify_id_token(&id_token(expired), "n", "client"),
            Err("exchange")
        );
        let mut issuer = claims();
        issuer["iss"] = json!("https://evil.example");
        assert_eq!(
            auth.verify_id_token(&id_token(issuer), "n", "client"),
            Err("exchange")
        );
    }

    #[test]
    fn next_is_always_same_site() {
        assert_eq!(safe_next(Some("/r/abc".into())), "/r/abc");
        for bad in [
            "//evil.example",
            "https://evil.example",
            "/\\evil.example",
            "/\t/evil.example",
            "/\n",
            "/%2F/evil.example",
            "",
        ] {
            assert_eq!(safe_next(Some(bad.into())), "/");
        }
        assert_eq!(safe_next(None), "/");
    }

    #[test]
    fn tokens_are_bound_to_their_purpose() {
        let auth = config();
        let flow = OAuthState {
            state: "s".into(),
            nonce: "n".into(),
            next: "/".into(),
            exp: unix_secs() + 60,
        };
        let token = auth.sign("oauth", &flow);
        assert!(auth.verify::<OAuthState>("oauth", &token).is_some());
        assert!(auth.verify::<OAuthState>("session", &token).is_none());
    }

    #[test]
    fn dev_login_only_on_loopback() {
        let mut auth = AuthConfig {
            dev_login_email: Some("dev@withrebar.ai".into()),
            ..AuthConfig::default()
        };
        assert!(auth.dev_email().is_some());
        auth.public_origin = "https://interview.withrebar.ai".into();
        assert!(auth.dev_email().is_none());
        auth.public_origin = "http://127.0.0.1.evil.example".into();
        assert!(auth.dev_email().is_none());
    }
}
