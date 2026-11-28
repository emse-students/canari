// The blind mail relay (docs/wiki/mail-client.md D4 and D5, docs/wiki/mail-client-transport.md).
//
// The web client speaks TLS to the school mailbox ITSELF (frontend/mail-tls, compiled to WASM) and
// needs only a pipe for the ciphertext: a page cannot open a TCP socket, and Partage sends no CORS
// header. This route is that pipe: a WebSocket in, ONE TCP connection out, to ONE destination
// named by configuration. It never terminates TLS and never reads past a record header - it counts
// record types for its log, and that is all it knows of what crosses it.
//
// What it admits, in order. The REQUEST is refused before the upgrade, as an HTTP status:
//   - the switch is on (`MAIL_RELAY_ENABLED`, off by default, D12), or 404;
//   - the page's origin, exactly as `/api/ws` (`crate::origin`), or 403;
//   - an ACCESS token, exactly as `/api/ws` (cookie, else `?token=`), or 401.
// The ACCOUNT is refused AFTER the upgrade, with a close code (`close_code`), because a browser
// cannot read the status of a refused upgrade - every refusal would reach the page as one 1006:
//   - a place under the caps below (connections held, new connections per minute, bytes over the
//     rolling window - per account - and connections in all), or 4006;
//   - an ELIGIBLE account: its stored mail class is one of `MAIL_CLASSES` (D1), asked of
//     core-service, or 4005 - and 4007 when core-service could not say.
// Then the upstream must answer the TCP connect within its deadline, or 502 before the upgrade.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::{
    extract::{
        Query, State,
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use futures::{sink::SinkExt, stream::StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::handlers::{SocketEnd, admit_origin, classify_socket_error, socket_token};
use crate::models::{AuthParams, TokenRejection, decode_access_claims};
use crate::state::AppState;

// ── The caps, in one place ───────────────────────────────────────────────────────────────────────

/// Concurrent relay connections one account may hold. A client keeps ONE persistent TLS
/// connection (keep-alive) and opens a second only while the first is being replaced, so four
/// covers two devices with room for a reconnect each.
pub const MAX_MAIL_CONNECTIONS_PER_ACCOUNT: usize = 4;
/// Concurrent relay connections on this process, all accounts together.
pub const MAX_MAIL_CONNECTIONS: usize = 400;
/// Bytes one connection may carry, both directions together. Past it the relay ends the
/// connection ([`RelayEnd::ByteCap`]) and the client opens a new one: the cap bounds what one
/// socket can cost, not what an account can read. Partage refuses a message above 30 MB, so a
/// connection carries several of the largest before reaching it.
pub const MAX_BYTES_PER_CONNECTION: u64 = 256 * 1024 * 1024;
/// The largest WebSocket message the relay accepts from a client: the client sends what its TLS
/// produced, records of at most 16 KiB plus overhead, a few at a time.
pub const MAX_CLIENT_MESSAGE_BYTES: usize = 1024 * 1024;
/// How long the TCP connect to the upstream may take before the upgrade is answered 502.
pub const UPSTREAM_CONNECT_DEADLINE: Duration = Duration::from_secs(10);
/// How long a connection may carry nothing, either way, before the relay ends it itself with
/// [`close_code::IDLE`]. CLEARLY BELOW EVERY HOP that would cut a silent connection: nginx's 120 s
/// on the location (`proxy_read_timeout`, `proxy_send_timeout`) and the Cloudflare edge's 100 s
/// (its proxy read timeout, which ends an idle proxied WebSocket too). An idle keep-alive
/// connection then ends as an ORDINARY end the client classifies, never as a hop's cut, which
/// reaches it as an unexplained 1006. Ten seconds of margin, so the two never race
/// (`.github/scripts/tests/mail-relay-route.test.mjs` holds both bounds).
pub const IDLE_DEADLINE: Duration = Duration::from_secs(90);
/// How long the eligibility question to core-service may take. core-service answers it with ONE
/// primary-key read of `users.mailClass` and asks nobody else, so a slower answer is a fault.
pub const ELIGIBILITY_DEADLINE: Duration = Duration::from_secs(5);
/// New relay connections one account may open in [`NEW_CONNECTION_WINDOW`]. Every connection the
/// relay makes to Partage leaves from ONE egress address, which RENATER sees for every student at
/// once: an account that reconnects in a loop must not spend that address's standing. An honest
/// client holds one keep-alive connection and replaces it on an idle close (every 90 s at most) or
/// a spent connection - a few a minute, two devices included.
pub const MAX_NEW_CONNECTIONS_PER_WINDOW: usize = 20;
/// The rolling window [`MAX_NEW_CONNECTIONS_PER_WINDOW`] is counted over.
pub const NEW_CONNECTION_WINDOW: Duration = Duration::from_secs(60);
/// Bytes one account may move through the relay, both ways and all its connections together, in
/// [`BYTE_BUDGET_WINDOW`]. [`MAX_BYTES_PER_CONNECTION`] bounds one socket only: without this an
/// account could open a new one each time and pull without end through the one egress address. A
/// mailbox read heavily (attachments of up to 30 MB, Partage's limit) stays far below it.
pub const ACCOUNT_BYTE_BUDGET: u64 = 512 * 1024 * 1024;
/// The rolling window [`ACCOUNT_BYTE_BUDGET`] is counted over.
pub const BYTE_BUDGET_WINDOW: Duration = Duration::from_secs(60 * 60);
/// The granularity of the byte ledger: bytes moved within one slot are one entry, so an account's
/// ledger holds at most `BYTE_BUDGET_WINDOW / BYTE_SLOT` entries, whatever its frame sizes.
const BYTE_SLOT: Duration = Duration::from_secs(1);
/// Past this many accounts in the ledger, an admission sweeps out every account with nothing held
/// and nothing left in either window: what bounds the ledger's memory, by count and not by clock.
const LEDGER_SWEEP_ABOVE: usize = 1_024;
/// Bytes read from the upstream at a time, and so the largest frame the relay sends.
const READ_CHUNK: usize = 64 * 1024;

/// The mail classes whose accounts may use the relay (D1): the VALUES of
/// `libs/contracts/mail-domains.json`'s `classes`, which core-service stores at sign-in and the
/// client reads too (`the_classes_are_the_contracts`).
pub const MAIL_CLASSES: [&str; 2] = ["student", "staff"];

/// The WebSocket close codes the relay ends a connection with - the client classifies on the CODE
/// (`frontend/src/lib/mail/relayTransport.ts`), never on the reason text.
pub mod close_code {
    /// The upstream closed its side: the ordinary end of a keep-alive connection.
    pub const UPSTREAM_CLOSED: u16 = 4000;
    /// The connection carried [`super::MAX_BYTES_PER_CONNECTION`].
    pub const BYTE_CAP: u16 = 4001;
    /// The upstream connection failed after it was established.
    pub const UPSTREAM_ERROR: u16 = 4002;
    /// The client sent something that is not a binary frame.
    pub const PROTOCOL: u16 = 4003;
    /// Nothing crossed for [`super::IDLE_DEADLINE`]: an ordinary end, like the upstream closing.
    pub const IDLE: u16 = 4004;
    /// The account holds no eligible mail class (D1): refused after the upgrade, never retried.
    pub const NOT_ELIGIBLE: u16 = 4005;
    /// A cap was reached: the account's connections held, its new connections per minute, its
    /// bytes over the rolling window (at admission, or mid-connection), or the relay's connections
    /// in all. A later attempt may pass.
    pub const CAP: u16 = 4006;
    /// The account's eligibility could not be established (core-service down, slow or refusing
    /// the secret): a fault on our side, never an answer about the account.
    pub const UNAVAILABLE: u16 = 4007;
}

/// Whether `class` is one of [`MAIL_CLASSES`]: exact, as core-service stores it.
pub fn is_eligible_class(class: &str) -> bool {
    MAIL_CLASSES.contains(&class)
}

// ── Configuration ────────────────────────────────────────────────────────────────────────────────

/// The one destination: a host and a port, nothing else.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Upstream {
    pub host: String,
    pub port: u16,
}

impl std::fmt::Display for Upstream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}:{}", self.host, self.port)
    }
}

/// Why the relay's configuration was refused at startup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigRefusal {
    /// `MAIL_RELAY_ENABLED` is neither on nor off.
    UnreadableSwitch(String),
    /// The switch is on and `MAIL_RELAY_UPSTREAM` is unset.
    NoUpstream,
    /// `MAIL_RELAY_UPSTREAM` is not exactly one `host:port`.
    NotOneHostPort(String),
    /// The switch is on and `CORE_SERVICE_URL` or `INTERNAL_SECRET` is unset, so no account could
    /// ever be found eligible.
    NoEligibilitySource(&'static str),
}

impl std::fmt::Display for ConfigRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConfigRefusal::UnreadableSwitch(v) => {
                write!(
                    f,
                    "MAIL_RELAY_ENABLED is {v:?}, which is neither on (1, true) nor off (0, false, unset)"
                )
            }
            ConfigRefusal::NoUpstream => write!(
                f,
                "MAIL_RELAY_ENABLED is on and MAIL_RELAY_UPSTREAM is not set"
            ),
            ConfigRefusal::NotOneHostPort(v) => write!(
                f,
                "MAIL_RELAY_UPSTREAM is {v:?}, which is not exactly ONE host:port - the relay dials one destination and nothing else"
            ),
            ConfigRefusal::NoEligibilitySource(name) => write!(
                f,
                "MAIL_RELAY_ENABLED is on and {name} is not set, so no account could be found eligible"
            ),
        }
    }
}

impl Upstream {
    /// Reads `raw` as exactly ONE `host:port`: a DNS name or an IPv4 address, and a port above 0.
    /// A list, a URL, a path, a wildcard, credentials or whitespace are refused, never trimmed into
    /// shape: the allowlist is of one, and what it names must be written plainly.
    pub fn parse(raw: &str) -> Result<Upstream, ConfigRefusal> {
        let refuse = || ConfigRefusal::NotOneHostPort(raw.to_string());
        let (host, port) = raw.rsplit_once(':').ok_or_else(refuse)?;
        let host_ok = !host.is_empty()
            && host.len() <= 253
            && host
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
            && !host.starts_with(['.', '-'])
            && !host.ends_with(['.', '-']);
        if !host_ok {
            return Err(refuse());
        }
        if port.is_empty() || !port.chars().all(|c| c.is_ascii_digit()) {
            return Err(refuse());
        }
        let port: u16 = port.parse().map_err(|_| refuse())?;
        if port == 0 {
            return Err(refuse());
        }
        Ok(Upstream {
            host: host.to_ascii_lowercase(),
            port,
        })
    }
}

/// What the environment says the relay is: off, or on with everything it needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayConfig {
    pub upstream: Upstream,
    pub core_url: String,
    pub internal_secret: String,
}

impl RelayConfig {
    /// Reads the four variables. `Ok(None)` is OFF, the default (D12); an unreadable switch or an
    /// incomplete ON is refused, and the gateway does not start on it.
    pub fn from_values(
        enabled: Option<&str>,
        upstream: Option<&str>,
        core_url: Option<&str>,
        internal_secret: Option<&str>,
    ) -> Result<Option<RelayConfig>, ConfigRefusal> {
        match enabled.map(str::trim).unwrap_or("") {
            "" | "0" | "false" => return Ok(None),
            "1" | "true" => {}
            other => return Err(ConfigRefusal::UnreadableSwitch(other.to_string())),
        }
        let upstream = Upstream::parse(upstream.ok_or(ConfigRefusal::NoUpstream)?)?;
        let core_url = core_url
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .ok_or(ConfigRefusal::NoEligibilitySource("CORE_SERVICE_URL"))?;
        let internal_secret = internal_secret
            .filter(|v| !v.is_empty())
            .ok_or(ConfigRefusal::NoEligibilitySource("INTERNAL_SECRET"))?;
        Ok(Some(RelayConfig {
            upstream,
            core_url: core_url.trim_end_matches('/').to_string(),
            internal_secret: internal_secret.to_string(),
        }))
    }
}

// ── Eligibility ──────────────────────────────────────────────────────────────────────────────────

/// Why core-service could not say whether an account is eligible. Never "not eligible": a relay
/// that could not ask answers 503, and the client keeps its session.
#[derive(Debug)]
pub enum EligibilityError {
    /// core-service could not be reached, or did not answer within [`ELIGIBILITY_DEADLINE`].
    Unreachable(String),
    /// It answered something other than a 200 or a 404 (a 5xx: its database unreachable; a 403: a
    /// refused secret).
    Upstream(u16),
    /// A 200 whose body is not `{ "mailClass": string | null }`.
    Malformed(String),
}

impl std::fmt::Display for EligibilityError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EligibilityError::Unreachable(e) => write!(f, "core-service unreachable: {e}"),
            EligibilityError::Upstream(s) => write!(f, "core-service answered {s}"),
            EligibilityError::Malformed(e) => {
                write!(f, "core-service answered a malformed body: {e}")
            }
        }
    }
}

#[derive(serde::Deserialize)]
struct ClassAnswer {
    #[serde(rename = "mailClass")]
    mail_class: Option<String>,
}

/// Asks core-service for an account's mail class (`GET /api/internal/users/:id/mail-class`): the
/// class learnt from MiConnect's `school_mail` claim at the last sign-in granted that scope, and
/// stored on the user row. Canari stores no address, and nobody asks MiConnect per connection
/// (mail-client-transport.md#eligibility).
pub struct Eligibility {
    http: reqwest::Client,
    core_url: String,
    internal_secret: String,
}

impl Eligibility {
    /// `core_url` is core-service's internal base WITHOUT `/api`, as the compose files name it.
    pub fn new(core_url: String, internal_secret: String) -> Self {
        let http = reqwest::Client::builder()
            .timeout(ELIGIBILITY_DEADLINE)
            .build()
            .expect("reqwest client with a timeout always builds");
        Eligibility {
            http,
            core_url,
            internal_secret,
        }
    }

    /// `account`'s mail class: `Some(class)`, or `None` when core-service answered that it has none
    /// (an unknown account, or one MiConnect sent no school address for) - both answers.
    pub async fn class_of(&self, account: &str) -> Result<Option<String>, EligibilityError> {
        let url = format!(
            "{}/api/internal/users/{}/mail-class",
            self.core_url,
            urlencode_segment(account)
        );
        let res = self
            .http
            .get(&url)
            .header("x-internal-secret", &self.internal_secret)
            .send()
            .await
            .map_err(|e| EligibilityError::Unreachable(e.to_string()))?;
        match res.status().as_u16() {
            200 => {
                let answer: ClassAnswer = res
                    .json()
                    .await
                    .map_err(|e| EligibilityError::Malformed(e.to_string()))?;
                Ok(answer.mail_class)
            }
            404 => Ok(None),
            other => Err(EligibilityError::Upstream(other)),
        }
    }
}

/// Percent-encodes one path segment (an OIDC subject is opaque text).
fn urlencode_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

// ── Places, rates and budgets ────────────────────────────────────────────────────────────────────

/// Why a place was refused - every one closes with [`close_code::CAP`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlaceRefusal {
    /// The account holds its [`MAX_MAIL_CONNECTIONS_PER_ACCOUNT`].
    Account,
    /// The process holds its [`MAX_MAIL_CONNECTIONS`].
    Process,
    /// The account opened [`MAX_NEW_CONNECTIONS_PER_WINDOW`] in the last [`NEW_CONNECTION_WINDOW`].
    Rate,
    /// The account moved its [`ACCOUNT_BYTE_BUDGET`] in the last [`BYTE_BUDGET_WINDOW`].
    Budget,
}

/// What one account is using: its connections held, when it opened its recent ones, and what it
/// moved in the byte window (one entry per [`BYTE_SLOT`]).
#[derive(Debug, Default)]
struct AccountUse {
    held: usize,
    opens: VecDeque<Instant>,
    bytes: VecDeque<(Instant, u64)>,
    bytes_total: u64,
}

impl AccountUse {
    /// Drops what left the windows at `now`.
    fn prune(&mut self, now: Instant, rate_window: Duration, byte_window: Duration) {
        while self
            .opens
            .front()
            .is_some_and(|t| now.saturating_duration_since(*t) >= rate_window)
        {
            self.opens.pop_front();
        }
        while let Some(&(t, n)) = self.bytes.front() {
            if now.saturating_duration_since(t) < byte_window {
                break;
            }
            self.bytes.pop_front();
            self.bytes_total -= n;
        }
    }

    /// Nothing held and nothing in either window: the entry says nothing and may go.
    fn is_idle(&self) -> bool {
        self.held == 0 && self.opens.is_empty() && self.bytes.is_empty()
    }
}

/// The relay, as the router holds it.
pub struct MailRelay {
    pub upstream: Upstream,
    pub eligibility: Eligibility,
    /// The caps, from the constants above; a field so a test can lower one.
    pub max_per_account: usize,
    pub max_total: usize,
    pub max_bytes: u64,
    pub idle: Duration,
    pub max_new_per_window: usize,
    pub new_connection_window: Duration,
    pub byte_budget: u64,
    pub byte_budget_window: Duration,
    accounts: Mutex<HashMap<String, AccountUse>>,
    refusals: crate::log_repeat::RepeatCounter,
}

/// A held place: given back when dropped, whether the socket ran or was never upgraded.
pub struct Place {
    relay: Arc<MailRelay>,
    account: String,
}

impl Drop for Place {
    fn drop(&mut self) {
        let mut accounts = self
            .relay
            .accounts
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if let Some(usage) = accounts.get_mut(&self.account) {
            usage.held = usage.held.saturating_sub(1);
        }
    }
}

impl MailRelay {
    /// The relay of `config`, with the caps of this file.
    pub fn new(config: RelayConfig) -> Self {
        MailRelay {
            upstream: config.upstream,
            eligibility: Eligibility::new(config.core_url, config.internal_secret),
            max_per_account: MAX_MAIL_CONNECTIONS_PER_ACCOUNT,
            max_total: MAX_MAIL_CONNECTIONS,
            max_bytes: MAX_BYTES_PER_CONNECTION,
            idle: IDLE_DEADLINE,
            max_new_per_window: MAX_NEW_CONNECTIONS_PER_WINDOW,
            new_connection_window: NEW_CONNECTION_WINDOW,
            byte_budget: ACCOUNT_BYTE_BUDGET,
            byte_budget_window: BYTE_BUDGET_WINDOW,
            accounts: Mutex::new(HashMap::new()),
            refusals: crate::log_repeat::RepeatCounter::new(4_096),
        }
    }

    /// Takes a place for `account` at `now`, counted and registered in one step under the lock.
    /// The account's own caps come before the process's (the narrower reason is named): the
    /// connections it holds, then the process's, then its new connections in the window, then its
    /// bytes in the window. An admitted open counts towards the rate; a refused one does not.
    pub fn admit(self: &Arc<Self>, account: &str, now: Instant) -> Result<Place, PlaceRefusal> {
        let mut accounts = self.accounts.lock().unwrap_or_else(|p| p.into_inner());
        if accounts.len() > LEDGER_SWEEP_ABOVE {
            for usage in accounts.values_mut() {
                usage.prune(now, self.new_connection_window, self.byte_budget_window);
            }
            accounts.retain(|_, usage| !usage.is_idle());
        }
        let total: usize = accounts.values().map(|u| u.held).sum();
        let usage = accounts.entry(account.to_string()).or_default();
        usage.prune(now, self.new_connection_window, self.byte_budget_window);
        if usage.held >= self.max_per_account {
            return Err(PlaceRefusal::Account);
        }
        if total >= self.max_total {
            return Err(PlaceRefusal::Process);
        }
        if usage.opens.len() >= self.max_new_per_window {
            return Err(PlaceRefusal::Rate);
        }
        if usage.bytes_total >= self.byte_budget {
            return Err(PlaceRefusal::Budget);
        }
        usage.held += 1;
        usage.opens.push_back(now);
        // Admitted with room to spare ends the episode of refusals (crate::log_repeat).
        if usage.held < self.max_per_account {
            self.refusals.forget(account);
        }
        Ok(Place {
            relay: self.clone(),
            account: account.to_string(),
        })
    }

    /// Charges `n` bytes moved at `now` to `account`'s window. Answers what the window then holds,
    /// and whether that is still within the budget ([`ACCOUNT_BYTE_BUDGET`]).
    pub fn charge(&self, account: &str, n: u64, now: Instant) -> (u64, bool) {
        let mut accounts = self.accounts.lock().unwrap_or_else(|p| p.into_inner());
        let usage = accounts.entry(account.to_string()).or_default();
        usage.prune(now, self.new_connection_window, self.byte_budget_window);
        match usage.bytes.back_mut() {
            Some((slot, moved)) if now.saturating_duration_since(*slot) < BYTE_SLOT => *moved += n,
            _ => usage.bytes.push_back((now, n)),
        }
        usage.bytes_total += n;
        (usage.bytes_total, usage.bytes_total <= self.byte_budget)
    }
}

// ── TLS record counting, for the log only ────────────────────────────────────────────────────────

/// Counts the TLS records crossing one direction by content type, reading the 5-byte record
/// headers and skipping every body. Nothing else of the stream is looked at.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct RecordCounter {
    header: [u8; 5],
    header_len: usize,
    body_left: usize,
    pub change_cipher_spec: u64,
    pub alert: u64,
    pub handshake: u64,
    pub application_data: u64,
    /// A header naming no TLS content type: the stream is not TLS (or the count lost its place).
    pub other: u64,
}

impl RecordCounter {
    /// Advances over `bytes`, counting each record header it completes.
    pub fn observe(&mut self, mut bytes: &[u8]) {
        while !bytes.is_empty() {
            if self.body_left > 0 {
                let skip = self.body_left.min(bytes.len());
                self.body_left -= skip;
                bytes = &bytes[skip..];
                continue;
            }
            let take = (5 - self.header_len).min(bytes.len());
            self.header[self.header_len..self.header_len + take].copy_from_slice(&bytes[..take]);
            self.header_len += take;
            bytes = &bytes[take..];
            if self.header_len == 5 {
                match self.header[0] {
                    20 => self.change_cipher_spec += 1,
                    21 => self.alert += 1,
                    22 => self.handshake += 1,
                    23 => self.application_data += 1,
                    _ => self.other += 1,
                }
                self.body_left = u16::from_be_bytes([self.header[3], self.header[4]]) as usize;
                self.header_len = 0;
            }
        }
    }
}

impl std::fmt::Display for RecordCounter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "hs={} ccs={} alert={} app={} other={}",
            self.handshake, self.change_cipher_spec, self.alert, self.application_data, self.other
        )
    }
}

// ── The route ────────────────────────────────────────────────────────────────────────────────────

/// Axum handler for `GET /api/mail/relay` (see the head of this file for what it admits).
pub async fn mail_relay_handler(
    ws: WebSocketUpgrade,
    Query(params): Query<AuthParams>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    let Some(relay) = state.mail_relay.clone() else {
        tracing::debug!("[mail-relay] asked while MAIL_RELAY_ENABLED is off - 404");
        return (StatusCode::NOT_FOUND, "Not found").into_response();
    };
    if let Err(refusal) = admit_origin(&state, &headers) {
        return *refusal;
    }
    let Some(token) = socket_token(&headers, params.token.as_deref()) else {
        return (StatusCode::UNAUTHORIZED, "Missing auth token").into_response();
    };
    let account = match decode_access_claims(&token, state.jwt_secret.as_bytes()) {
        Ok(claims) => claims.sub,
        Err(TokenRejection::NotAnAccessToken(kind)) => {
            tracing::warn!("[mail-relay] refused: a '{kind}' token is not an access token");
            return (StatusCode::UNAUTHORIZED, "Invalid parameters").into_response();
        }
        Err(TokenRejection::Invalid(e)) => {
            tracing::debug!("[mail-relay] refused: {e}");
            return (StatusCode::UNAUTHORIZED, "Invalid parameters").into_response();
        }
    };
    let short = short_id(&account);

    // THE PLACE IS TAKEN BEFORE ANYTHING IS ASKED OF ANYONE: an account at a cap is refused
    // without a question to core-service or a connect to the upstream. Every line about an account
    // names it by `short` (the first 8 characters of its Canari id), so an abuse window seen from
    // the egress address can be put on the account that made it.
    let place = match relay.admit(&account, Instant::now()) {
        Ok(place) => place,
        Err(refusal) => {
            if let Some(n) = relay.refusals.hit(&account) {
                tracing::warn!(
                    "[mail-relay] REFUSED for {short} ({refusal:?}; limits {} held per account, {} in all, {} new per {} s, {} bytes per {} s) - closed {}, refusal #{n} of this episode",
                    relay.max_per_account,
                    relay.max_total,
                    relay.max_new_per_window,
                    relay.new_connection_window.as_secs(),
                    relay.byte_budget,
                    relay.byte_budget_window.as_secs(),
                    close_code::CAP
                );
            }
            return refuse_after_upgrade(ws, close_code::CAP);
        }
    };

    match relay.eligibility.class_of(&account).await {
        Ok(Some(class)) if is_eligible_class(&class) => {
            tracing::debug!("[mail-relay] {short} is eligible ({class})");
        }
        Ok(class) => {
            // An answer: this account holds no school address. Said once per account and episode -
            // a client that keeps asking is a client the tab should not have been shown to.
            if let Some(n) = relay.refusals.hit(&format!("ineligible:{account}")) {
                tracing::info!(
                    "[mail-relay] {short} is not eligible (class {:?}) - closed {}, refusal #{n}",
                    class.as_deref().unwrap_or("none"),
                    close_code::NOT_ELIGIBLE
                );
            }
            return refuse_after_upgrade(ws, close_code::NOT_ELIGIBLE);
        }
        Err(e) => {
            tracing::warn!(
                "[mail-relay] eligibility of {short} UNKNOWN, closing {}: {e}",
                close_code::UNAVAILABLE
            );
            return refuse_after_upgrade(ws, close_code::UNAVAILABLE);
        }
    }

    // CONNECTED BEFORE THE UPGRADE: an upstream that does not answer is a 502 the client reads as
    // a status, never a socket that opens and dies. The stream travels in the upgrade callback, so
    // an upgrade that never completes closes it.
    let upstream = relay.upstream.clone();
    let stream = match tokio::time::timeout(
        UPSTREAM_CONNECT_DEADLINE,
        TcpStream::connect((upstream.host.as_str(), upstream.port)),
    )
    .await
    {
        Ok(Ok(stream)) => stream,
        Ok(Err(e)) => {
            tracing::warn!("[mail-relay] {short}: connect to {upstream} FAILED: {e} - 502");
            return (StatusCode::BAD_GATEWAY, "Upstream unreachable").into_response();
        }
        Err(_) => {
            tracing::warn!(
                "[mail-relay] {short}: connect to {upstream} took over {} s - 502",
                UPSTREAM_CONNECT_DEADLINE.as_secs()
            );
            return (StatusCode::BAD_GATEWAY, "Upstream unreachable").into_response();
        }
    };
    let _ = stream.set_nodelay(true);
    tracing::debug!("[mail-relay] {short}: connected to {upstream}, upgrading");
    ws.max_frame_size(MAX_CLIENT_MESSAGE_BYTES)
        .max_message_size(MAX_CLIENT_MESSAGE_BYTES)
        .on_upgrade(move |socket| async move {
            pipe(socket, stream, &relay, &account, short).await;
            drop(place);
        })
}

/// Upgrades, then closes at once with `code`: how the relay refuses an ACCOUNT. A browser reads
/// the close code of an open socket, while a refused upgrade reaches the page as a bare 1006
/// whatever its status. No place is held and no upstream is dialled for it.
fn refuse_after_upgrade(ws: WebSocketUpgrade, code: u16) -> Response {
    ws.on_upgrade(move |mut socket| async move {
        let _ = socket
            .send(Message::Close(Some(CloseFrame {
                code,
                reason: "".into(),
            })))
            .await;
        // Flushes the Close; its error is the client already gone - nothing to say.
        let _ = SinkExt::close(&mut socket).await;
    })
}

/// The first eight characters of an account id: enough to follow one account through the log.
fn short_id(account: &str) -> String {
    account.chars().take(8).collect()
}

/// Why a relay connection ended - the one thing that decides the level of its line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelayEnd {
    /// The client closed politely, or reset the socket (a page closed): ordinary.
    ClientClosed,
    /// The upstream closed its side: ordinary, a keep-alive connection ends so.
    UpstreamClosed,
    /// Nothing crossed for the idle deadline: ordinary, the relay ended it before nginx would.
    Idle,
    /// The connection carried its byte cap.
    ByteCap,
    /// The account moved its byte budget over the rolling window, on this and its other connections.
    Budget,
    /// The client sent a frame that is not binary.
    Protocol,
    /// The client's socket failed with something other than a reset.
    ClientFault,
    /// The upstream's socket failed.
    UpstreamFault,
}

/// What one connection carried, said once when it ends.
#[derive(Debug, Default)]
struct Tally {
    up_bytes: u64,
    down_bytes: u64,
    up_records: RecordCounter,
    down_records: RecordCounter,
}

/// Pipes bytes both ways until either side ends, then says ONE line (INFO for an ordinary end,
/// WARN for a cap or a fault) with the byte counts and record types - never content.
async fn pipe(
    socket: WebSocket,
    stream: TcpStream,
    relay: &MailRelay,
    account: &str,
    short: String,
) {
    let max_bytes = relay.max_bytes;
    let idle_after = relay.idle;
    let started = Instant::now();
    // What the account's window held at the last charge, for the end line.
    let mut window_bytes = 0u64;
    let idle = tokio::time::sleep(idle_after);
    tokio::pin!(idle);
    let (mut ws_tx, mut ws_rx) = socket.split();
    let (mut tcp_rx, mut tcp_tx) = stream.into_split();
    let mut tally = Tally::default();
    let mut buf = vec![0u8; READ_CHUNK];

    let end = loop {
        tokio::select! {
            incoming = ws_rx.next() => match incoming {
                Some(Ok(Message::Binary(bytes))) => {
                    idle.as_mut().reset(tokio::time::Instant::now() + idle_after);
                    tally.up_bytes += bytes.len() as u64;
                    if tally.up_bytes + tally.down_bytes > max_bytes {
                        break RelayEnd::ByteCap;
                    }
                    let (held, within) = relay.charge(account, bytes.len() as u64, Instant::now());
                    window_bytes = held;
                    if !within {
                        break RelayEnd::Budget;
                    }
                    tally.up_records.observe(&bytes);
                    if tcp_tx.write_all(&bytes).await.is_err() {
                        break RelayEnd::UpstreamFault;
                    }
                }
                // Answered by the socket itself (a Ping gets its Pong).
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                Some(Ok(Message::Text(_))) => break RelayEnd::Protocol,
                Some(Ok(Message::Close(_))) | None => break RelayEnd::ClientClosed,
                Some(Err(e)) => match classify_socket_error(&e) {
                    SocketEnd::Goodbye => break RelayEnd::ClientClosed,
                    other => {
                        tracing::debug!("[mail-relay] {short}: client socket ended {other:?}: {e}");
                        break RelayEnd::ClientFault;
                    }
                },
            },
            read = tcp_rx.read(&mut buf) => match read {
                Ok(0) => break RelayEnd::UpstreamClosed,
                Ok(n) => {
                    idle.as_mut().reset(tokio::time::Instant::now() + idle_after);
                    tally.down_bytes += n as u64;
                    if tally.up_bytes + tally.down_bytes > max_bytes {
                        break RelayEnd::ByteCap;
                    }
                    let (held, within) = relay.charge(account, n as u64, Instant::now());
                    window_bytes = held;
                    if !within {
                        break RelayEnd::Budget;
                    }
                    tally.down_records.observe(&buf[..n]);
                    if ws_tx.send(Message::Binary(buf[..n].to_vec().into())).await.is_err() {
                        break RelayEnd::ClientClosed;
                    }
                }
                Err(e) => {
                    tracing::debug!("[mail-relay] {short}: upstream read failed: {e}");
                    break RelayEnd::UpstreamFault;
                }
            },
            () = &mut idle => break RelayEnd::Idle,
        }
    };

    // The client is told WHY by a close code it classifies on (`close_code`); a client that left
    // is told nothing. The upstream's half is shut either way.
    let code = match end {
        RelayEnd::ClientClosed | RelayEnd::ClientFault => None,
        RelayEnd::UpstreamClosed => Some(close_code::UPSTREAM_CLOSED),
        RelayEnd::Idle => Some(close_code::IDLE),
        RelayEnd::ByteCap => Some(close_code::BYTE_CAP),
        RelayEnd::Budget => Some(close_code::CAP),
        RelayEnd::UpstreamFault => Some(close_code::UPSTREAM_ERROR),
        RelayEnd::Protocol => Some(close_code::PROTOCOL),
    };
    if let Some(code) = code {
        let _ = ws_tx
            .send(Message::Close(Some(CloseFrame {
                code,
                reason: "".into(),
            })))
            .await;
    }
    // Completes the closing handshake (a client's Close is answered, not dropped, as on /api/ws);
    // after our own Close it only flushes. Its error is the socket already gone - nothing to say.
    let _ = ws_tx.close().await;
    let _ = tcp_tx.shutdown().await;

    let line = format!(
        "[mail-relay] {short} ended: {end:?} after {} ms - up {} bytes ({}), down {} bytes ({}); the account's window holds {} of {} bytes per {} s",
        started.elapsed().as_millis(),
        tally.up_bytes,
        tally.up_records,
        tally.down_bytes,
        tally.down_records,
        window_bytes,
        relay.byte_budget,
        relay.byte_budget_window.as_secs()
    );
    match end {
        RelayEnd::ClientClosed | RelayEnd::UpstreamClosed | RelayEnd::Idle => {
            tracing::info!("{line}")
        }
        RelayEnd::ByteCap
        | RelayEnd::Budget
        | RelayEnd::Protocol
        | RelayEnd::ClientFault
        | RelayEnd::UpstreamFault => {
            tracing::warn!("{line}")
        }
    }
}

#[cfg(test)]
mod tests;
