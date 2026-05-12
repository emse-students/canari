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

/// Return a JSON map of `{ userId -> bool }` indicating which users have at least
/// one active device presence key in Redis.
///
/// Uses `SCAN` with a `user:online:{userId}:*` pattern rather than `KEYS` to
/// avoid blocking Redis on large keyspaces.
pub async fn get_presence(
    Query(query): Query<PresenceQuery>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    use std::collections::HashMap;
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

    // Redis: scan all user:online:* keys with their TTL
    // NOTE: KEYS blocks Redis — acceptable for a low-traffic admin endpoint.
    let mut redis_entries: Vec<(String, String, i64)> = Vec::new();
    if let Ok(mut con) = state.redis_client.get_multiplexed_async_connection().await
        && let Ok(keys) = redis::cmd("KEYS")
            .arg("user:online:*")
            .query_async::<Vec<String>>(&mut con)
            .await
    {
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
