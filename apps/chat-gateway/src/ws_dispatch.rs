// WS message dispatch - one async function per message type.
//
// All send-path operations (mls, commit, welcome) now go directly from
// the frontend to the delivery service via HTTP.  The gateway WS
// connection is receive-only for those message types; WS frames arriving
// here are control/signalling messages only.
//
// Remaining inbound frame types:
//   • welcome_request   - forwarded to one online peer
//   • read              - no-op

use std::sync::Arc;
use tokio::sync::mpsc;

use crate::state::AppState;

// ── Connection context (one per WebSocket session) ────────────────────────

/// Bundles the per-session references needed by dispatch handlers so they
/// can be passed as a single argument rather than a long parameter list.
pub struct WsConn<'a> {
    pub state: &'a Arc<AppState>,
    pub user_id: &'a str,
    pub device_id: &'a str,
    /// Channel to push frames back to this client.
    pub tx: &'a mpsc::Sender<String>,
}

// ── Parsed incoming frame ─────────────────────────────────────────────────

/// Minimal parsed representation of an inbound WebSocket JSON frame.
pub struct WsFrame {
    /// The `type` field from the JSON object (e.g. `"welcome_request"`).
    pub msg_type: String,
    /// The `groupId` field, or an empty string when absent.
    pub group_id: String,
}

impl WsFrame {
    /// Parse a raw JSON value into a `WsFrame`.
    /// Always returns `Some`; the option wrapper exists for future validation.
    pub fn parse(json: &serde_json::Value) -> Option<Self> {
        let msg_type = json
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let group_id = json
            .get("groupId")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();

        Some(WsFrame { msg_type, group_id })
    }
}

// ── Handler: "disconnect" ─────────────────────────────────────────────────

/// Handle an explicit client disconnect frame.
///
/// Immediately removes the `user:online:{userId}:{deviceId}` Redis presence key
/// so peers see the user as offline without waiting for the TTL to expire.
/// The caller should break out of the recv loop after this returns.
pub async fn handle_disconnect(
    state: &std::sync::Arc<crate::state::AppState>,
    user_id: &str,
    device_id: &str,
) {
    use redis::AsyncCommands;
    let redis_key = format!("user:online:{}:{}", user_id, device_id);
    tracing::info!(
        "[presence] Explicit disconnect from {}:{} - removing presence key immediately",
        user_id,
        device_id
    );
    match state.redis_client.get_multiplexed_async_connection().await {
        Ok(mut con) => {
            if let Err(e) = con.del::<_, ()>(&redis_key).await {
                tracing::warn!(
                    "[presence] DEL failed on explicit disconnect for {}:{}: {}",
                    user_id,
                    device_id,
                    e
                );
            }
        }
        Err(e) => {
            tracing::warn!(
                "[presence] Redis unavailable on explicit disconnect for {}:{}: {}",
                user_id,
                device_id,
                e
            );
        }
    }
}

// ── Handler: "welcome_request" ────────────────────────────────────────────

/// Handle a `welcome_request` frame from a client that wants to join a group.
///
/// Builds a notification JSON object and forwards it to exactly one online
/// group peer that is not the sender.  If no peer is reachable, sends
/// `no_peer_online` back to the requester.
pub async fn handle_welcome_request(conn: &WsConn<'_>, frame: &WsFrame) {
    tracing::info!(
        "Processing welcome_request from {}:{} for group {}",
        conn.user_id,
        conn.device_id,
        frame.group_id
    );

    let notification = serde_json::json!({
        "type": "welcome_request",
        "groupId": frame.group_id,
        "requesterUserId": conn.user_id,
        "requesterDeviceId": conn.device_id,
    })
    .to_string();

    let sender_key = format!("{}:{}", conn.user_id, conn.device_id);
    forward_to_one_peer(conn, &frame.group_id, &sender_key, notification).await;
}

// ── Shared helper ─────────────────────────────────────────────────────────

/// Forward a notification to exactly one online group member that is not the sender.
///
/// Looks up the group member list in Redis (`group:members:{group_id}`), then
/// iterates the in-memory `connected_users` map to find the first online peer.
/// Sends `no_peer_online` back to the original sender if no peer is reachable.
async fn forward_to_one_peer(
    conn: &WsConn<'_>,
    group_id: &str,
    sender_key: &str,
    notification: String,
) {
    use redis::AsyncCommands;

    let mut forwarded = false;

    if let Ok(mut con) = conn
        .state
        .redis_client
        .get_multiplexed_async_connection()
        .await
    {
        let members_key = format!("group:members:{}", group_id);
        if let Ok(members) = con.smembers::<_, Vec<String>>(&members_key).await {
            // Drop the MutexGuard before any .await boundary.
            let target = {
                let map = conn.state.connected_users.lock().unwrap();
                members
                    .iter()
                    .filter(|m| m.as_str() != sender_key)
                    .find_map(|m| {
                        map.get(m)
                            .and_then(|senders| senders.values().next().cloned())
                            .map(|s| (m.clone(), s))
                    })
            };

            if let Some((member, sender)) = target {
                let _ = sender.try_send(notification);
                forwarded = true;
                tracing::info!("forwarded to {}", member);
            }
        }
    }

    if !forwarded {
        let no_peer =
            serde_json::json!({ "type": "no_peer_online", "groupId": group_id }).to_string();
        let _ = conn.tx.send(no_peer).await;
        tracing::info!(
            "no_peer_online sent back to {}:{} for group {}",
            conn.user_id,
            conn.device_id,
            group_id
        );
    }
}
