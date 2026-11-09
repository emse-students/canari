// WS message dispatch - one async function per message type.
//
// All send-path operations (mls, commit, welcome) now go directly from
// the frontend to the delivery service via HTTP.  The gateway WS
// connection is receive-only for those message types; WS frames arriving
// here are control/signalling messages only.
//
// Remaining inbound frame types:
//   • disconnect        - retires this connection's session
//   • typing            - relayed to the group's other online members, sender's seat checked
//   • welcome_request   - RETIRED 2026-11-01: ignored and logged (`RETIRED_FRAMES`)

use std::sync::{Arc, LazyLock};
use tokio::sync::mpsc;

use crate::log_repeat::RepeatCounter;

use crate::state::AppState;

// ── Connection context (one per WebSocket session) ────────────────────────

/// Bundles the per-session references needed by dispatch handlers so they
/// can be passed as a single argument rather than a long parameter list.
pub struct WsConn<'a> {
    pub state: &'a Arc<AppState>,
    pub user_id: &'a str,
    pub device_id: &'a str,
}

// ── Parsed incoming frame ─────────────────────────────────────────────────

/// Minimal parsed representation of an inbound WebSocket JSON frame.
pub struct WsFrame {
    /// The `type` field from the JSON object (e.g. `"welcome_request"`).
    pub msg_type: String,
    /// The `groupId` field, or an empty string when absent.
    pub group_id: String,
    /// The `state` field (used by `typing`: `"start"`/`"stop"`), empty when absent.
    pub state: String,
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

        let state = json
            .get("state")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();

        Some(WsFrame {
            msg_type,
            group_id,
            state,
        })
    }
}

// ── Handler: "disconnect" ─────────────────────────────────────────────────

/// Handle an explicit client disconnect frame.
///
/// Retires THIS connection's session at once (crate::addressing): its field leaves the device's
/// sessions hash, recorded as left so no refresh in flight brings it back, and the presence key
/// `user:online:{userId}:{deviceId}` goes in the same script when no session of the device is left
/// on ANY gateway process. Two tabs of one browser share a `deviceId`, so the question is asked of
/// the shared hash rather than decided here - a sibling tab, here or on another process, keeps the
/// device online.
///
/// `conn_id` identifies the connection sending the frame. The caller should break out of the recv
/// loop after this returns, which drops `ConnectionGuard`; its own retirement of the same session
/// is then a no-op.
pub async fn handle_disconnect(
    state: &std::sync::Arc<crate::state::AppState>,
    user_id: &str,
    device_id: &str,
    conn_id: u64,
) {
    let conn_key = format!("{}:{}", user_id, device_id);
    let field = crate::addressing::session_field(&state.instance_id, conn_id);

    tracing::info!(
        "[presence] Explicit disconnect from {} (conn_id={}) - retiring its session",
        conn_key,
        conn_id
    );
    match state.redis_client.get_multiplexed_async_connection().await {
        Ok(mut con) => {
            if let Err(e) = crate::addressing::leave_session(
                &mut con,
                &conn_key,
                Some(&field),
                crate::handlers::PRESENCE_TTL_SECS,
            )
            .await
            {
                tracing::warn!(
                    "[presence] Retiring the session failed on explicit disconnect for {}: {}",
                    conn_key,
                    e
                );
            }
        }
        Err(e) => {
            tracing::warn!(
                "[presence] Redis unavailable on explicit disconnect for {}: {}",
                conn_key,
                e
            );
        }
    }
}

// ── Retired frames ────────────────────────────────────────────────────────

/// Frame types the gateway no longer acts on.
///
/// `welcome_request` (retired 2026-11-01): a re-add request goes over HTTP
/// (`POST mls/welcome-request`), where chat-delivery checks the caller's seat first. The WebSocket
/// path relayed it to one online member with no seat check, and no client sends it any more.
pub const RETIRED_FRAMES: &[&str] = &["welcome_request"];

/// True when `msg_type` names a frame in [`RETIRED_FRAMES`].
pub fn is_retired_frame(msg_type: &str) -> bool {
    RETIRED_FRAMES.contains(&msg_type)
}

/// Repeats of one sender's retired frame - a client still speaking the old protocol keeps doing it.
static RETIRED_FRAME_REPEATS: LazyLock<RepeatCounter> = LazyLock::new(|| RepeatCounter::new(5000));

/// Ignore a retired frame, and say so: an old client, or a hand-written one, is still sending it.
/// Nothing is answered.
pub fn handle_retired_frame(user_id: &str, device_id: &str, frame: &WsFrame) {
    let subject = format!("{}:{}:{}", frame.msg_type, user_id, device_id);
    if let Some(n) = RETIRED_FRAME_REPEATS.hit(&subject) {
        tracing::warn!(
            "[WS] retired frame type={} from {}:{} group={} IGNORED (occurrence {}) - this path is HTTP now",
            frame.msg_type,
            user_id,
            device_id,
            frame.group_id,
            n
        );
    }
}

// ── Handler: "typing" ─────────────────────────────────────────────────────

/// Repeats of one sender's typing into one group it holds no seat in.
static TYPING_REFUSAL_REPEATS: LazyLock<RepeatCounter> = LazyLock::new(|| RepeatCounter::new(5000));

/// Relay an ephemeral typing signal to every other online member of the group.
///
/// Best-effort, fire-and-forget: typing is non-critical, never persisted and
/// never queued. Only used for MLS groups/DMs (channels route typing through
/// the social-service `chat:channel_events` path, which knows channel members).
///
/// The sender must appear in the group's routing set (`group:members:{groupId}`): a signal from an
/// account holding no seat is dropped and logged at each power of ten of its count, since a client
/// can send one per keystroke.
pub async fn handle_typing(conn: &WsConn<'_>, frame: &WsFrame) {
    use redis::AsyncCommands;

    if frame.group_id.is_empty() {
        return;
    }
    let state = if frame.state == "stop" {
        "stop"
    } else {
        "start"
    };

    let mut con = match conn
        .state
        .redis_client
        .get_multiplexed_async_connection()
        .await
    {
        Ok(con) => con,
        Err(e) => {
            tracing::warn!(
                "[TYPING] Redis unavailable, signal for {} dropped: {}",
                frame.group_id,
                e
            );
            return;
        }
    };
    let members_key = format!("group:members:{}", frame.group_id);
    let members = match con.smembers::<_, Vec<String>>(&members_key).await {
        Ok(members) => members,
        Err(e) => {
            tracing::warn!(
                "[TYPING] roster of {} unreadable, signal dropped: {}",
                frame.group_id,
                e
            );
            return;
        }
    };

    let Some(audience) = typing_audience(&members, conn.user_id) else {
        let subject = format!("{}:{}", conn.user_id, frame.group_id);
        if let Some(n) = TYPING_REFUSAL_REPEATS.hit(&subject) {
            tracing::warn!(
                "[TYPING] {}:{} holds no seat in group {} - signal REFUSED (occurrence {})",
                conn.user_id,
                conn.device_id,
                frame.group_id,
                n
            );
        }
        return;
    };

    let notification = serde_json::json!({
        "type": "typing",
        "groupId": frame.group_id,
        "userId": conn.user_id,
        "state": state,
    })
    .to_string();

    let targets: Vec<mpsc::Sender<String>> = {
        let map = conn.state.connected_users.lock().unwrap();
        audience
            .iter()
            .filter_map(|m| map.get(*m))
            .flat_map(|senders| senders.values().cloned())
            .collect()
    };
    for tx in targets {
        let _ = tx.try_send(notification.clone());
    }
}

/// The routing-set entries (`userId:deviceId`) a typing signal from `sender_user` reaches - every
/// device but the sender's own - or `None` when no device of the sender is in the set, i.e. the
/// sender holds no seat this gateway can see.
fn typing_audience<'m>(members: &'m [String], sender_user: &str) -> Option<Vec<&'m str>> {
    let sender_prefix = format!("{}:", sender_user);
    if !members.iter().any(|m| m.starts_with(&sender_prefix)) {
        return None;
    }
    Some(
        members
            .iter()
            .filter(|m| !m.starts_with(&sender_prefix))
            .map(String::as_str)
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::{is_retired_frame, typing_audience};

    #[test]
    fn a_welcome_request_frame_is_retired_and_typing_is_not() {
        assert!(is_retired_frame("welcome_request"));
        assert!(!is_retired_frame("typing"));
        assert!(!is_retired_frame("disconnect"));
    }

    #[test]
    fn a_seated_sender_reaches_every_other_member_but_not_its_own_devices() {
        let members = vec![
            "alice:phone".to_string(),
            "alice:laptop".to_string(),
            "bob:phone".to_string(),
        ];
        assert_eq!(typing_audience(&members, "alice"), Some(vec!["bob:phone"]));
    }

    #[test]
    fn a_sender_with_no_seat_reaches_nobody() {
        let members = vec!["alice:phone".to_string(), "bob:phone".to_string()];
        assert_eq!(typing_audience(&members, "mallory"), None);
        assert_eq!(typing_audience(&[], "mallory"), None);
    }

    #[test]
    fn a_user_id_that_prefixes_another_is_not_a_seat() {
        let members = vec!["alice2:phone".to_string()];
        assert_eq!(typing_audience(&members, "alice"), None);
    }
}
