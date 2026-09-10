// HTTP handlers for the presence endpoints.
//
// These are plain Axum handlers with no dependency on the WebSocket
// lifecycle; they only need `AppState` to read from Redis and the
// in-memory `connected_users` map.

use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Json},
};
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

/// Whether nginx identified the caller - the presence of a non-empty `X-User-Id`.
///
/// nginx sets this header after the auth sub-request and it must never be accepted from an
/// untrusted client; that is the same contract `x-global-admin` is read under just below, and the
/// same one `NginxAuthGuard` enforces on the Nest services. A blank value is treated as absent:
/// `auth_request_set` yields an empty string when the sub-request set no such header, so "" is
/// exactly what an anonymous caller arrives with.
fn is_authenticated(headers: &HeaderMap) -> bool {
    headers
        .get("x-user-id")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| !v.trim().is_empty())
}

/// Return a JSON map of `{ userId -> bool }` indicating which users have at least
/// one active device presence key in Redis.
///
/// REQUIRES AN AUTHENTICATED CALLER, and until 2026-09-10 it required nothing at all.
///
/// The edge config puts `/api/presence` behind `auth_request /internal/auth/verify`, which is
/// exactly what an access check looks like - but `/api/auth/verify` answers 200 for a logged-OUT
/// caller too, carrying `x-logged-in: false` so signed-out pages can render, and nginx treats any
/// 2xx as permission granted. That sub-request says WHO you are, never WHETHER you may pass.
/// Measured that day against the local copy of production, with no session of any kind:
///
/// ```text
/// GET /api/presence?users=<a real user id>   ->  200  {"<that id>":false}
/// ```
///
/// So whether a named person is online was readable by anybody who could name them.
/// `get_admin_presence` below had carried its header check since it was written; this one simply
/// never got one. **A gate is only a gate if it can say no.**
///
/// WHAT THIS DELIBERATELY DOES NOT DECIDE: whether an authenticated user may ask about an
/// arbitrary user id, rather than only people they share a conversation with. That is a real
/// question and a larger one - the gateway does not know who shares what - and answering it here
/// would be scope this defect does not license. It is filed in the backlog.
///
/// Uses `SCAN` with a `user:online:{userId}:*` pattern rather than `KEYS` to
/// avoid blocking Redis on large keyspaces.
pub async fn get_presence(
    headers: HeaderMap,
    Query(query): Query<PresenceQuery>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    use std::collections::HashMap;

    if !is_authenticated(&headers) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error": "Unauthorized"})),
        )
            .into_response();
    }

    let mut presence = HashMap::new();
    let users_list: Vec<&str> = query.users.split(',').collect();

    if let Ok(mut con) = state.redis_client.get_multiplexed_async_connection().await {
        for user in users_list {
            if user.trim().is_empty() {
                continue;
            }
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
                        tracing::warn!("[presence] SCAN failed for {}: {}", user, e);
                        break;
                    }
                }
            }
            presence.insert(user.to_string(), found);
        }
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
    use axum::Router;
    use axum::body::Body;
    use axum::http::Request;
    use axum::routing::get;
    use tower::ServiceExt;

    /// The REAL handler behind the REAL route, not a re-implementation of it.
    ///
    /// This is deliberate. A sibling suite in this repository was found on the same day to be
    /// testing a hand-written copy of the logic it was meant to watch, which cannot fail when the
    /// real code changes. Redis is never reached here: the refusal returns before any connection
    /// is attempted, and `redis::Client::open` does not connect on construction, so an authorised
    /// request simply finds no keys. That difference is the whole assertion.
    fn app() -> Router {
        let client = redis::Client::open("redis://127.0.0.1:1/").expect("client construction");
        let state = Arc::new(AppState::new(client, "test-secret".to_string()));
        Router::new()
            .route("/api/presence", get(get_presence))
            .with_state(state)
    }

    async fn status_for(header: Option<&str>) -> StatusCode {
        let mut builder = Request::builder().uri("/api/presence?users=someone");
        if let Some(value) = header {
            builder = builder.header("x-user-id", value);
        }
        app()
            .oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap()
            .status()
    }

    #[tokio::test]
    async fn anonymous_caller_is_refused() {
        // The measured defect: 200 with a real answer, to a request carrying no identity at all.
        assert_eq!(status_for(None).await, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn blank_identity_is_refused() {
        // `auth_request_set` yields "" when the sub-request set no such header, so an empty
        // string is exactly what an anonymous caller arrives with - not a hypothetical.
        assert_eq!(status_for(Some("")).await, StatusCode::UNAUTHORIZED);
        assert_eq!(status_for(Some("   ")).await, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn identified_caller_is_served() {
        // Redis is unreachable here, so the answer is an empty map - the point is that the
        // request got PAST the gate rather than what it found.
        assert_eq!(status_for(Some("a-real-user")).await, StatusCode::OK);
    }

    #[tokio::test]
    async fn admin_presence_still_refuses_a_non_admin() {
        // The neighbouring handler has always checked; this pins that the change above did not
        // disturb it, and that the two refusals stay distinguishable (403 there, 401 here).
        let client = redis::Client::open("redis://127.0.0.1:1/").expect("client construction");
        let state = Arc::new(AppState::new(client, "test-secret".to_string()));
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
