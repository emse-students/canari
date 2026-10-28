// HTTP handlers for the presence endpoints.
//
// These are plain Axum handlers with no dependency on the WebSocket
// lifecycle; they only need `AppState` to read from Redis, the presence
// audience (`audience.rs`) and the
// in-memory `connected_users` map.

use axum::{
    extract::{Query, State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Json},
};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::state::AppState;

// ── Request types ─────────────────────────────────────────────────────────

/// Body of `POST /api/presence`: the asked user ids, as a JSON array.
#[derive(serde::Deserialize)]
pub struct PresenceBody {
    /// The user ids to check.
    pub users: Vec<String>,
}

/// Query parameters of the LEGACY `GET /api/presence` ([`get_presence`]).
#[derive(serde::Deserialize)]
pub struct PresenceQuery {
    /// Comma-separated list of user IDs to check.
    pub users: String,
}

// ── The question both routes ask ──────────────────────────────────────────

/// The most distinct user ids one presence request may ask about. A client splits a larger
/// watchlist into requests of at most this many (`presenceStore.ts`), so an honest client never
/// meets the 400. The bound exists so the audience question sent to the services is bounded by
/// THIS service, and it is the number those services refuse above too
/// (`libs/contracts/presence-audience.cases.json`).
pub const MAX_PRESENCE_USERS: usize = 1000;

/// The caller nginx identified - a non-empty `X-User-Id`, trimmed and lowercased (the spelling
/// every Nest guard stores ids under) - or `None` for an anonymous caller.
///
/// nginx sets this header after the auth sub-request and it must never be accepted from an
/// untrusted client; that is the same contract `x-global-admin` is read under just below, and the
/// same one `NginxAuthGuard` enforces on the Nest services. A blank value is treated as absent:
/// `auth_request_set` yields an empty string when the sub-request set no such header, so "" is
/// exactly what an anonymous caller arrives with.
fn caller_id(headers: &HeaderMap) -> Option<String> {
    headers
        .get("x-user-id")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.trim().to_lowercase())
        .filter(|v| !v.is_empty())
}

/// The asked ids, whichever route carried them: trimmed, blanks dropped, duplicates collapsed,
/// order kept.
fn requested_ids<'a>(users: impl Iterator<Item = &'a str>) -> Vec<String> {
    let mut seen = HashSet::new();
    users
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .filter(|id| seen.insert(id.to_string()))
        .map(str::to_string)
        .collect()
}

/// A 401 for a caller nginx did not identify.
fn unauthorized() -> axum::response::Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(serde_json::json!({"error": "Unauthorized"})),
    )
        .into_response()
}

/// A 503 with a JSON body. Never a 401/403: a client may only sign out on those, and "the gateway
/// could not answer" is not "you are not allowed".
fn unavailable(reason: &str) -> axum::response::Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(serde_json::json!({ "error": reason })),
    )
        .into_response()
}

// ── POST /api/presence ────────────────────────────────────────────────────

/// `POST /api/presence` with `{ "users": [id, ...] }` - THE presence read since 2026-10-28.
///
/// THE IDS TRAVEL IN THE BODY, NEVER IN THE URL. The legacy `GET ?users=` put every watched id in
/// the request line, which every proxy on the way writes to its access log: a reverse-proxy log
/// scanner flagged the very long query strings as an attack, the ids of everybody a member watches
/// sat in logs of a host this project does not own, and a long enough watchlist outgrows a proxy's
/// header buffer, which fails that member's presence silently. A body is in no access log, and its
/// size is bounded by [`MAX_PRESENCE_USERS`] here and by the client's split.
///
/// Answered exactly as [`answer_presence`] says, after two refusals of its own: 401 for an
/// anonymous caller (checked BEFORE the body is read, so a stranger learns nothing about the shape
/// it expects), and 400 for a body that is not `{ "users": [string, ...] }` with a JSON
/// `Content-Type`.
pub async fn post_presence(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    body: Result<Json<PresenceBody>, JsonRejection>,
) -> axum::response::Response {
    let Some(viewer) = caller_id(&headers) else {
        return unauthorized();
    };
    let body = match body {
        Ok(Json(body)) => body,
        Err(rejection) => {
            tracing::warn!(
                "[presence] {} sent a body that is not {{ users: [string] }} - refused: {}",
                viewer,
                rejection.body_text()
            );
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "Expected { users: string[] }" })),
            )
                .into_response();
        }
    };
    answer_presence(
        &state,
        &viewer,
        requested_ids(body.users.iter().map(String::as_str)),
    )
    .await
}

// ── GET /api/presence (legacy) ────────────────────────────────────────────

/// The LEGACY presence read, `GET /api/presence?users=a,b,c` - kept ONLY for clients installed
/// before `POST /api/presence`, which keep calling it until they update (a store build is not
/// reached by a deploy). Same audience, same cap, same answers as [`post_presence`].
///
/// Removal condition and the measurement it waits on: `docs/wiki/legacy-compatibility.md`
/// ("the presence ids in a URL"). Every call is counted by [`LegacyGetTally`], which says how many
/// calls from how many callers it served, once per [`LEGACY_GET_SUMMARY_WINDOW`] at most.
pub async fn get_presence(
    headers: HeaderMap,
    Query(query): Query<PresenceQuery>,
    State(state): State<Arc<AppState>>,
) -> axum::response::Response {
    let Some(viewer) = caller_id(&headers) else {
        return unauthorized();
    };
    if let Some(summary) = state.legacy_presence_gets.record(&viewer, Instant::now()) {
        tracing::info!(
            "[presence] legacy GET /api/presence served {} calls from {} callers in the last {}s - \
             clients older than POST /api/presence (docs/wiki/legacy-compatibility.md)",
            summary.calls,
            summary.callers,
            summary.window.as_secs()
        );
    }
    answer_presence(&state, &viewer, requested_ids(query.users.split(','))).await
}

/// How often at most [`LegacyGetTally`] reports. A REPORTING cadence and nothing else: a wrong
/// value changes how many lines the log holds, never what any caller is answered.
pub const LEGACY_GET_SUMMARY_WINDOW: Duration = Duration::from_secs(3600);

/// What one closed window of legacy GETs held.
#[derive(Debug, PartialEq, Eq)]
pub struct LegacyGetSummary {
    /// Legacy calls served in the window.
    pub calls: u64,
    /// Distinct callers among them - each one an install still older than the POST.
    pub callers: usize,
    /// How long the window actually lasted (at least [`LEGACY_GET_SUMMARY_WINDOW`]).
    pub window: Duration,
}

/// Counts the legacy `GET /api/presence` calls so their removal is decided by a measurement.
///
/// ONE LINE PER WINDOW, NEVER ONE PER CALL: an old client polls every 10 s, so a line per call is
/// exactly the noise this route's replacement exists to end. The window is closed by the first
/// call that arrives after it has lasted [`LEGACY_GET_SUMMARY_WINDOW`], so there is no timer task:
/// a gateway nobody calls the legacy way logs nothing, and that silence IS the zero being waited
/// for. The callers' ids stay in memory for the window and are never logged.
pub struct LegacyGetTally {
    window: Mutex<LegacyGetWindow>,
}

struct LegacyGetWindow {
    opened: Instant,
    calls: u64,
    callers: HashSet<String>,
}

impl LegacyGetTally {
    /// A tally whose first window opens at `now`.
    pub fn new(now: Instant) -> Self {
        LegacyGetTally {
            window: Mutex::new(LegacyGetWindow {
                opened: now,
                calls: 0,
                callers: HashSet::new(),
            }),
        }
    }

    /// Counts one legacy call by `caller` at `now`. When the current window has lasted
    /// [`LEGACY_GET_SUMMARY_WINDOW`], it is closed and returned - this call opening the next one -
    /// so the caller logs exactly one line for it.
    pub fn record(&self, caller: &str, now: Instant) -> Option<LegacyGetSummary> {
        let mut w = self.window.lock().unwrap();
        let elapsed = now.saturating_duration_since(w.opened);
        let closed = (elapsed >= LEGACY_GET_SUMMARY_WINDOW).then(|| {
            let summary = LegacyGetSummary {
                calls: w.calls,
                callers: w.callers.len(),
                window: elapsed,
            };
            w.opened = now;
            w.calls = 0;
            w.callers.clear();
            summary
        });
        w.calls += 1;
        w.callers.insert(caller.to_string());
        closed.filter(|s| s.calls > 0)
    }
}

// ── The answer ────────────────────────────────────────────────────────────

/// Return a JSON map of `{ userId -> bool }` - whether each user has at least one active device
/// presence key in Redis - **for the asked users the caller may see, and for no one else.** The
/// one answer behind both routes; `viewer` is already identified and `asked` already distinct.
///
/// WHO MAY SEE WHOSE PRESENCE (WP-PRESENCE, decided by the user 2026-10-18): the caller
/// themself, and anyone who shares a live conversation or a community with the caller.
/// [`PresenceAudience::visible_to`](crate::audience::PresenceAudience::visible_to) asks the two
/// services that own those tables. Until then any signed-in user could ask about any user id.
///
/// AN ID THE CALLER MAY NOT SEE IS ABSENT FROM THE MAP - neither `true` nor `false`, and never a
/// 401/403, which a client reads as "sign out". An old client (floors 1.2.7 / 1.0.3) merges the
/// map into its own, so an absent key simply never turns its dot on: it degrades quietly. A new
/// client reads absence as "not visible" and drops the id from its map.
///
/// THE OTHER ANSWERS (the 401 for an anonymous caller is each route's, before this runs; measured
/// 2026-09-10: until then `auth_request` let a logged-OUT caller through, because
/// `/api/auth/verify` answers 200 to signed-out pages too, and anybody could read whether a named
/// person was online): 400 for more than [`MAX_PRESENCE_USERS`] ids; 503 when the audience or
/// Redis cannot be read, because an empty map there would read as "nobody is visible" when nobody
/// was asked.
///
/// Uses `SCAN` with a `user:online:{userId}:*` pattern rather than `KEYS` to
/// avoid blocking Redis on large keyspaces - and only for the ids the caller may see, so a crafted
/// id never reaches a SCAN pattern unless a service has matched it to a real membership.
async fn answer_presence(
    state: &AppState,
    viewer: &str,
    asked: Vec<String>,
) -> axum::response::Response {
    if asked.len() > MAX_PRESENCE_USERS {
        tracing::warn!(
            "[presence] {} asked about {} users (max {}) - refused",
            viewer,
            asked.len(),
            MAX_PRESENCE_USERS
        );
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Too many users" })),
        )
            .into_response();
    }

    let lowered: Vec<String> = asked.iter().map(|id| id.to_lowercase()).collect();
    let visible = match state.presence_audience.visible_to(viewer, &lowered).await {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(
                "[presence] audience unavailable for {} ({} asked) - answering 503: {}",
                viewer,
                asked.len(),
                e
            );
            return unavailable("Presence audience unavailable");
        }
    };
    let readable: Vec<&String> = asked
        .iter()
        .filter(|id| visible.contains(&id.to_lowercase()))
        .collect();
    tracing::debug!(
        "[presence] {} asked {} users, {} visible",
        viewer,
        asked.len(),
        readable.len()
    );

    let mut presence: HashMap<String, bool> = HashMap::new();
    if readable.is_empty() {
        return (StatusCode::OK, Json(presence)).into_response();
    }

    let mut con = match state.redis_client.get_multiplexed_async_connection().await {
        Ok(con) => con,
        Err(e) => {
            tracing::warn!(
                "[presence] Redis unavailable for {} - answering 503: {}",
                viewer,
                e
            );
            return unavailable("Presence store unavailable");
        }
    };
    for user in readable {
        let pattern = format!("user:online:{}:*", user);
        // Use SCAN with COUNT hint instead of KEYS to avoid blocking Redis.
        let mut cursor: u64 = 0;
        let mut found = false;
        loop {
            match redis::cmd("SCAN")
                .arg(cursor)
                .arg("MATCH")
                .arg(&pattern)
                .arg("COUNT")
                .arg(100u64)
                .query_async::<(u64, Vec<String>)>(&mut con)
                .await
            {
                Ok((next_cursor, keys)) => {
                    if !keys.is_empty() {
                        found = true;
                        break;
                    }
                    cursor = next_cursor;
                    if cursor == 0 {
                        break; // full scan complete, nothing found
                    }
                }
                Err(e) => {
                    tracing::warn!("[presence] SCAN failed for {} - answering 503: {}", user, e);
                    return unavailable("Presence store unavailable");
                }
            }
        }
        presence.insert(user.clone(), found);
    }

    (StatusCode::OK, Json(presence)).into_response()
}

// ── GET /api/admin/presence ───────────────────────────────────────────────

/// Return a JSON list of every known device with its WebSocket and Redis presence status.
///
/// Requires the `X-Global-Admin: true` header (injected by Nginx after auth verification).
/// Merges data from two sources:
/// - In-memory `connected_users` map (live WebSocket connections).
/// - Redis `user:online:*` keys (presence TTL state).
///
/// NOTE: Uses `KEYS user:online:*` which blocks Redis briefly; acceptable for a
/// low-traffic admin debugging endpoint.
pub async fn get_admin_presence(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let is_admin = headers
        .get("x-global-admin")
        .and_then(|v| v.to_str().ok())
        .map(|v| v == "true")
        .unwrap_or(false);

    if !is_admin {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"error": "Forbidden"})),
        )
            .into_response();
    }

    // In-memory WS connections: conn_key -> tab count
    let ws_map: std::collections::HashMap<String, usize> = {
        let map = state.connected_users.lock().unwrap();
        map.iter().map(|(k, v)| (k.clone(), v.len())).collect()
    };

    // Redis: scan all user:online:*:* keys with their TTL using SCAN to avoid blocking.
    let mut redis_entries: Vec<(String, String, i64)> = Vec::new();
    if let Ok(mut con) = state.redis_client.get_multiplexed_async_connection().await {
        let mut cursor: u64 = 0;
        loop {
            match redis::cmd("SCAN")
                .arg(cursor)
                .arg("MATCH")
                .arg("user:online:*:*")
                .arg("COUNT")
                .arg(100u64)
                .query_async::<(u64, Vec<String>)>(&mut con)
                .await
            {
                Ok((next_cursor, keys)) => {
                    for key in &keys {
                        // format: user:online:{userId}:{deviceId}
                        // splitn(4) so deviceIds containing ":" are preserved
                        let parts: Vec<&str> = key.splitn(4, ':').collect();
                        if parts.len() == 4 {
                            let ttl: i64 = redis::cmd("TTL")
                                .arg(key)
                                .query_async(&mut con)
                                .await
                                .unwrap_or(-1);
                            redis_entries.push((parts[2].to_string(), parts[3].to_string(), ttl));
                        }
                    }
                    cursor = next_cursor;
                    if cursor == 0 {
                        break;
                    }
                }
                Err(e) => {
                    tracing::warn!("[admin/presence] SCAN failed: {}", e);
                    break;
                }
            }
        }
    }

    // Merge WS + Redis into one unified list
    let mut all_keys: std::collections::HashSet<String> = std::collections::HashSet::new();
    for k in ws_map.keys() {
        all_keys.insert(k.clone());
    }
    for (user_id, device_id, _) in &redis_entries {
        all_keys.insert(format!("{}:{}", user_id, device_id));
    }

    let mut devices: Vec<serde_json::Value> = all_keys
        .iter()
        .filter_map(|conn_key| {
            let (user_id, device_id) = conn_key.split_once(':')?;
            let ws_tabs = ws_map.get(conn_key).copied().unwrap_or(0);
            let redis_entry = redis_entries
                .iter()
                .find(|(u, d, _)| u == user_id && d == device_id);
            let (redis_online, redis_ttl) = match redis_entry {
                Some((_, _, ttl)) => (true, *ttl),
                None => (false, -1i64),
            };
            Some(serde_json::json!({
                "userId": user_id,
                "deviceId": device_id,
                "wsConnected": ws_tabs > 0,
                "wsTabs": ws_tabs,
                "redisOnline": redis_online,
                "redisTtl": redis_ttl,
            }))
        })
        .collect();

    devices.sort_by(|a, b| {
        let ua = a["userId"].as_str().unwrap_or("");
        let ub = b["userId"].as_str().unwrap_or("");
        ua.cmp(ub).then_with(|| {
            let da = a["deviceId"].as_str().unwrap_or("");
            let db = b["deviceId"].as_str().unwrap_or("");
            da.cmp(db)
        })
    });

    let total = devices.len();
    (
        StatusCode::OK,
        Json(serde_json::json!({ "devices": devices, "total": total })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audience::PresenceAudience;
    use crate::audience::tests_support::{FakeServices, spawn_fake_services};
    use axum::Router;
    use axum::body::Body;
    use axum::http::Request;
    use axum::routing::get;
    use tower::ServiceExt;

    const SECRET: &str = "internal-secret-for-tests";

    /// The REAL handler behind the REAL route, not a re-implementation of it, with the audience
    /// asked of a fake chat-delivery and social-service listening on loopback.
    ///
    /// Redis is unreachable on purpose (`redis::Client::open` does not connect on construction).
    /// That makes the status itself the observation: a caller refused before Redis is a 401/400,
    /// an asked set with NOBODY visible is a 200 `{}` that never needed Redis, and a set with
    /// someone visible got past the audience and reached Redis - which, being down, is a 503.
    async fn app(services: FakeServices) -> (Router, FakeServices) {
        let base = spawn_fake_services(services.clone()).await;
        let client = redis::Client::open("redis://127.0.0.1:1/").expect("client construction");
        let audience = PresenceAudience::new(base.clone(), base, SECRET.to_string());
        let state = Arc::new(AppState::new(client, "test-secret".to_string(), audience));
        let router = Router::new()
            .route("/api/presence", get(get_presence).post(post_presence))
            .with_state(state);
        (router, services)
    }

    /// Sends one request through the real router and returns its status and body.
    async fn send(services: FakeServices, request: Request<Body>) -> (StatusCode, String) {
        let (router, _) = app(services).await;
        let response = router.oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 16)
            .await
            .unwrap();
        (status, String::from_utf8(bytes.to_vec()).unwrap())
    }

    /// A raw `POST /api/presence` with `body` as its JSON text.
    fn post_raw(body: &str, viewer: Option<&str>) -> Request<Body> {
        let mut builder = Request::builder()
            .method("POST")
            .uri("/api/presence")
            .header("content-type", "application/json");
        if let Some(value) = viewer {
            builder = builder.header("x-user-id", value);
        }
        builder.body(Body::from(body.to_string())).unwrap()
    }

    /// THE presence read: `users` (comma-separated, for brevity here) sent as a JSON array.
    async fn ask(
        services: FakeServices,
        users: &str,
        viewer: Option<&str>,
    ) -> (StatusCode, String) {
        let ids: Vec<&str> = users.split(',').collect();
        let body = serde_json::json!({ "users": ids }).to_string();
        send(services, post_raw(&body, viewer)).await
    }

    /// The legacy read, ids in the query string.
    async fn ask_legacy(
        services: FakeServices,
        users: &str,
        viewer: Option<&str>,
    ) -> (StatusCode, String) {
        let mut builder = Request::builder().uri(format!("/api/presence?users={users}"));
        if let Some(value) = viewer {
            builder = builder.header("x-user-id", value);
        }
        send(services, builder.body(Body::empty()).unwrap()).await
    }

    fn sharing(conversations: &[&str], communities: &[&str]) -> FakeServices {
        FakeServices::new(SECRET, conversations, communities)
    }

    #[tokio::test]
    async fn anonymous_caller_is_refused() {
        // The measured defect of 2026-09-10: 200 with a real answer, to a request carrying no
        // identity at all.
        let (status, _) = ask(sharing(&["bob"], &[]), "bob", None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn blank_identity_is_refused() {
        // `auth_request_set` yields "" when the sub-request set no such header, so an empty
        // string is exactly what an anonymous caller arrives with - not a hypothetical.
        assert_eq!(
            ask(sharing(&[], &[]), "bob", Some("")).await.0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            ask(sharing(&[], &[]), "bob", Some("   ")).await.0,
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn a_stranger_is_absent_from_the_answer_and_never_a_refusal() {
        // WP-PRESENCE: someone the caller shares nothing with is not reported at all - not
        // `false`, and above all not a 401/403, which a client reads as "sign out".
        let (status, body) = ask(sharing(&["bob"], &["carol"]), "mallory", Some("alice")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, "{}");
    }

    #[tokio::test]
    async fn someone_sharing_a_conversation_gets_past_the_audience() {
        // Reaches Redis, which is down here: the 503 is the proof the gate let them through.
        let (status, _) = ask(sharing(&["bob"], &[]), "bob,mallory", Some("alice")).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn someone_sharing_a_community_gets_past_the_audience() {
        let (status, _) = ask(sharing(&[], &["carol"]), "carol", Some("alice")).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn the_caller_always_sees_themself_without_asking_anybody() {
        let services = sharing(&[], &[]);
        let (status, _) = ask(services.clone(), "Alice", Some("alice")).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE); // past the gate, into Redis
        assert_eq!(services.hits(), 0);
    }

    #[tokio::test]
    async fn an_audience_that_cannot_be_read_is_a_503_never_a_403() {
        // A service refusing the GATEWAY (wrong secret) must not reach the client as a refusal of
        // the CLIENT: only a 401/403 may sign a user out.
        let services = FakeServices::new("another-secret", &["bob"], &[]);
        let (status, body) = ask(services, "bob", Some("alice")).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert!(body.contains("Presence audience unavailable"), "{body}");
    }

    #[tokio::test]
    async fn too_many_ids_are_refused_before_anybody_is_asked() {
        let services = sharing(&[], &[]);
        let users: Vec<String> = (0..=MAX_PRESENCE_USERS).map(|i| format!("u{i}")).collect();
        let (status, _) = ask(services.clone(), &users.join(","), Some("alice")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(services.hits(), 0);
    }

    /// The cap is one number in three places - here and in the validator chat-delivery and
    /// social-service share - and `libs/contracts/presence-audience.cases.json` is the one copy
    /// all three assert against. A gateway allowing more than a service accepts would turn every
    /// such question into a service 400, which this handler answers as a 503.
    #[test]
    fn the_cap_is_the_one_the_services_share() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../libs/contracts/presence-audience.cases.json"
        );
        let text = std::fs::read_to_string(path).expect("the presence-audience contract");
        let contract: serde_json::Value = serde_json::from_str(&text).expect("valid JSON");
        assert_eq!(
            contract["maxUserIds"].as_u64(),
            Some(MAX_PRESENCE_USERS as u64)
        );
    }

    #[test]
    fn requested_ids_trims_drops_blanks_and_collapses_duplicates() {
        assert_eq!(
            requested_ids(" bob,,carol , bob,".split(',')),
            vec!["bob", "carol"]
        );
    }

    // ── POST: the body, and what it refuses ──────────────────────────────

    #[tokio::test]
    async fn an_anonymous_post_is_refused_before_its_body_is_read() {
        // A body that is not even JSON: the 401 must come first, so a stranger learns nothing
        // about the shape the route expects.
        let services = sharing(&["bob"], &[]);
        let (status, _) = send(services.clone(), post_raw("not json", None)).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(services.hits(), 0);
    }

    #[tokio::test]
    async fn a_malformed_body_is_a_400_and_asks_nobody() {
        for body in [
            "not json",
            "{}",
            r#"{"users":"bob,carol"}"#,
            r#"{"users":[1,2]}"#,
            r#"["bob"]"#,
        ] {
            let services = sharing(&["bob"], &[]);
            let (status, response) = send(services.clone(), post_raw(body, Some("alice"))).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{body} -> {response}");
            assert_eq!(services.hits(), 0, "{body} reached the audience");
        }
    }

    #[tokio::test]
    async fn a_body_with_no_json_content_type_is_a_400() {
        let request = Request::builder()
            .method("POST")
            .uri("/api/presence")
            .header("x-user-id", "alice")
            .body(Body::from(r#"{"users":["bob"]}"#))
            .unwrap();
        let (status, _) = send(sharing(&["bob"], &[]), request).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn an_empty_list_is_an_empty_answer() {
        let (status, body) = ask(sharing(&[], &[]), "", Some("alice")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, "{}");
    }

    #[tokio::test]
    async fn the_cap_counts_distinct_ids_so_repeats_are_not_refused() {
        // A thousand copies of one id is ONE question, as on the legacy route.
        let users = vec!["mallory"; MAX_PRESENCE_USERS + 1].join(",");
        let (status, body) = ask(sharing(&[], &[]), &users, Some("alice")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, "{}");
    }

    #[tokio::test]
    async fn exactly_the_cap_is_answered() {
        let services = sharing(&[], &[]);
        let users: Vec<String> = (0..MAX_PRESENCE_USERS).map(|i| format!("u{i}")).collect();
        let (status, _) = ask(services.clone(), &users.join(","), Some("alice")).await;
        assert_eq!(status, StatusCode::OK);
        assert!(services.hits() > 0, "the audience was never asked");
    }

    // ── GET: the legacy shim answers exactly as the POST does ────────────

    #[tokio::test]
    async fn the_legacy_get_keeps_the_same_answers() {
        assert_eq!(
            ask_legacy(sharing(&["bob"], &[]), "bob", None).await.0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            ask_legacy(sharing(&["bob"], &["carol"]), "mallory", Some("alice")).await,
            (StatusCode::OK, "{}".to_string())
        );
        // Past the audience, into the deliberately absent Redis.
        assert_eq!(
            ask_legacy(sharing(&["bob"], &[]), "bob,mallory", Some("alice"))
                .await
                .0,
            StatusCode::SERVICE_UNAVAILABLE
        );
        let services = sharing(&[], &[]);
        let users: Vec<String> = (0..=MAX_PRESENCE_USERS).map(|i| format!("u{i}")).collect();
        assert_eq!(
            ask_legacy(services.clone(), &users.join(","), Some("alice"))
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(services.hits(), 0);
    }

    // ── The legacy tally: one line per window, never one per call ────────

    #[test]
    fn the_tally_reports_nothing_inside_a_window() {
        let t0 = Instant::now();
        let tally = LegacyGetTally::new(t0);
        for i in 0..50 {
            assert_eq!(
                tally.record("alice", t0 + Duration::from_secs(i * 10)),
                None
            );
        }
    }

    #[test]
    fn the_tally_closes_a_window_on_the_first_call_after_it_and_counts_distinct_callers() {
        let t0 = Instant::now();
        let tally = LegacyGetTally::new(t0);
        tally.record("alice", t0);
        tally.record("alice", t0 + Duration::from_secs(10));
        tally.record("bob", t0 + Duration::from_secs(20));
        let closing = t0 + LEGACY_GET_SUMMARY_WINDOW + Duration::from_secs(5);
        assert_eq!(
            tally.record("carol", closing),
            Some(LegacyGetSummary {
                calls: 3,
                callers: 2,
                window: LEGACY_GET_SUMMARY_WINDOW + Duration::from_secs(5),
            })
        );
        // The closing call opened the next window: it is counted there, once.
        assert_eq!(
            tally.record("carol", closing + LEGACY_GET_SUMMARY_WINDOW),
            Some(LegacyGetSummary {
                calls: 1,
                callers: 1,
                window: LEGACY_GET_SUMMARY_WINDOW,
            })
        );
    }

    #[test]
    fn a_window_nobody_called_in_says_nothing() {
        // The first legacy call a long time after boot closes an EMPTY window: that is no line,
        // because a line reporting zero calls is exactly what silence already says.
        let t0 = Instant::now();
        let tally = LegacyGetTally::new(t0);
        assert_eq!(
            tally.record("alice", t0 + LEGACY_GET_SUMMARY_WINDOW * 5),
            None
        );
    }

    #[tokio::test]
    async fn admin_presence_still_refuses_a_non_admin() {
        // The neighbouring handler has always checked; this pins that the change above did not
        // disturb it, and that the two refusals stay distinguishable (403 there, 401 here).
        let client = redis::Client::open("redis://127.0.0.1:1/").expect("client construction");
        let audience = PresenceAudience::new(String::new(), String::new(), String::new());
        let state = Arc::new(AppState::new(client, "test-secret".to_string(), audience));
        let app = Router::new()
            .route("/api/admin/presence", get(get_admin_presence))
            .with_state(state);
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/admin/presence")
                    .header("x-user-id", "someone")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
}
