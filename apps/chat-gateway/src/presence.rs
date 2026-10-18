// HTTP handlers for the presence endpoints.
//
// These are plain Axum handlers with no dependency on the WebSocket
// lifecycle; they only need `AppState` to read from Redis, the presence
// audience (`audience.rs`) and the
// in-memory `connected_users` map.

use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Json},
};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use crate::state::AppState;

// ── Query types ───────────────────────────────────────────────────────────

/// Query parameters for `GET /api/presence`.
#[derive(serde::Deserialize)]
pub struct PresenceQuery {
    /// Comma-separated list of user IDs to check.
    pub users: String,
}

// ── GET /api/presence ─────────────────────────────────────────────────────

/// The most user ids one `GET /api/presence` may ask about. The URL itself bounds an honest
/// client well below this (a few hundred uuids fill nginx's header buffer); the bound exists so
/// the audience question sent to the services is bounded by THIS service, not by a proxy setting.
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

/// The ids a `users=` query names: trimmed, blanks dropped, duplicates collapsed, order kept.
fn requested_ids(users: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    users
        .split(',')
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .filter(|id| seen.insert(id.to_string()))
        .map(str::to_string)
        .collect()
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

/// Return a JSON map of `{ userId -> bool }` - whether each user has at least one active device
/// presence key in Redis - **for the asked users the caller may see, and for no one else.**
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
/// THE OTHER ANSWERS: 401 for an anonymous caller (measured 2026-09-10: until then
/// `auth_request` let a logged-OUT caller through, because `/api/auth/verify` answers 200 to
/// signed-out pages too, and anybody could read whether a named person was online); 400 for more
/// than [`MAX_PRESENCE_USERS`] ids; 503 when the audience or Redis cannot be read, because an
/// empty map there would read as "nobody is visible" when nobody was asked.
///
/// Uses `SCAN` with a `user:online:{userId}:*` pattern rather than `KEYS` to
/// avoid blocking Redis on large keyspaces - and only for the ids the caller may see, so a crafted
/// id never reaches a SCAN pattern unless a service has matched it to a real membership.
pub async fn get_presence(
    headers: HeaderMap,
    Query(query): Query<PresenceQuery>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let Some(viewer) = caller_id(&headers) else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error": "Unauthorized"})),
        )
            .into_response();
    };

    let asked = requested_ids(&query.users);
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
    let visible = match state.presence_audience.visible_to(&viewer, &lowered).await {
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
            .route("/api/presence", get(get_presence))
            .with_state(state);
        (router, services)
    }

    async fn ask(
        services: FakeServices,
        users: &str,
        viewer: Option<&str>,
    ) -> (StatusCode, String) {
        let (router, _) = app(services).await;
        let mut builder = Request::builder().uri(format!("/api/presence?users={users}"));
        if let Some(value) = viewer {
            builder = builder.header("x-user-id", value);
        }
        let response = router
            .oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 16)
            .await
            .unwrap();
        (status, String::from_utf8(bytes.to_vec()).unwrap())
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

    #[test]
    fn requested_ids_trims_drops_blanks_and_collapses_duplicates() {
        assert_eq!(requested_ids(" bob,,carol , bob,"), vec!["bob", "carol"]);
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
