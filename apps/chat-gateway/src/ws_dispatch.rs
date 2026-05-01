// WS message dispatch — one async function per message type.
//
// All send-path operations (mls, commit, welcome) now go directly from
// the frontend to the delivery service via HTTP.  The gateway WS
// connection is receive-only for those message types; WS frames arriving
// here are control/signalling messages only.
//
// Remaining inbound frame types:
//   • welcome_request   — forwarded to one online peer
//   • reinvite_request  — forwarded to one online peer
//   • read              — no-op

use std::sync::Arc;
use tokio::sync::mpsc;

use crate::state::AppState;

// ── Connection context (one per WebSocket session) ────────────────────────

#[allow(dead_code)]
pub struct WsConn<'a> {
    pub state: &'a Arc<AppState>,
    pub user_id: &'a str,
    pub device_id: &'a str,
    /// Channel to push frames back to this client.
    pub tx: &'a mpsc::Sender<String>,
}

// ── Parsed incoming frame ─────────────────────────────────────────────────

pub struct WsFrame {
    pub msg_type: String,
    pub group_id: String,
}

impl WsFrame {
    /// Parse a raw JSON value into a `WsFrame`.
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

/// Called when the client explicitly signals it is going offline.
/// Returns `true` to instruct the recv loop to break immediately.
#[allow(dead_code)]
pub async fn handle_disconnect(
    state: &std::sync::Arc<crate::state::AppState>,
    user_id: &str,
    device_id: &str,
) {
    use redis::AsyncCommands;
    let redis_key = format!("user:online:{}:{}", user_id, device_id);
    tracing::info!(
        "[presence] Explicit disconnect from {}:{} — removing presence key immediately",
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

#[allow(dead_code)]
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

// ── Handler: "reinvite_request" ───────────────────────────────────────────

#[allow(dead_code)]
pub async fn handle_reinvite_request(conn: &WsConn<'_>, frame: &WsFrame) {
    tracing::info!(
        "Processing reinvite_request from {}:{} for group {}",
        conn.user_id,
        conn.device_id,
        frame.group_id
    );

    let notification = serde_json::json!({
        "type": "reinvite_request",
        "senderId": conn.user_id,
        "senderDeviceId": conn.device_id,
        "groupId": frame.group_id,
    })
    .to_string();

    let sender_key = format!("{}:{}", conn.user_id, conn.device_id);
    forward_to_one_peer(conn, &frame.group_id, &sender_key, notification).await;
}

// ── Shared helper ─────────────────────────────────────────────────────────

/// Forward a notification to exactly one online group member that is not the
/// sender. Sends `no_peer_online` back to the sender if no peer is reachable.
#[allow(dead_code)]
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
