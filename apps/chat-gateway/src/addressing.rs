//! Which sessions of a device may receive an ADDRESSED conversation frame
//! (`docs/wiki/protocols/history-answer-addressing.md`, rule 6).
//!
//! MLS encrypts a history answer for the whole group, so addressing it to one device is a routing
//! control only. A session whose code predates rule 5 would apply such a frame as an ordinary one,
//! so the device is addressable only while EVERY one of its sessions declared
//! [`ADDRESSED_HISTORY_CAPABILITY`] - and those sessions may sit on several gateway processes (a
//! deploy overlap), so the fact is kept in the SHARED store, one field per session:
//!
//! - `addressing:sessions:{userId}:{deviceId}` (a hash, deliberately outside `user:*`, which the
//!   presence scans match): field `{instance}:{conn_id}`, value the capability or [`UNDECLARED`].
//!   Each field carries its own expiry ([`crate::handlers::PRESENCE_TTL_SECS`]), refreshed by its
//!   own session only, and is removed when that session ends. The expiry decides LIVENESS (how long
//!   a crashed process's field lingers), never safety: a lingering undeclared field only keeps the
//!   device unaddressable, a lingering declared one changes nothing.
//! - the presence key `user:online:{userId}:{deviceId}` holds [`PRESENCE_SESSIONS`]. An older
//!   gateway writes `true` and records no field, and this gateway never overwrites nor deletes that
//!   `true`, so it survives exactly as long as the older gateway's session keeps refreshing it - the
//!   only trace chat-delivery can read of a session it cannot see the declaration of.
//!
//! chat-delivery addresses a conversation frame to a device only when the presence value is
//! [`PRESENCE_SESSIONS`] and every field is the capability. Between that check and the frame's
//! arrival a new session may connect, so this gateway also filters at its EDGE
//! ([`addressed_recipients`]): an addressed frame never reaches a session here that did not declare.

use redis::aio::MultiplexedConnection;
use std::collections::HashMap;

/// The capability a socket declares (`caps=` on `/api/ws`) when the code behind it refuses an
/// ADDRESSED conversation frame that is not a solicited history answer (rule 5). The same literal is
/// `ADDRESSED_HISTORY_CAPABILITY` in chat-delivery and in the client.
pub const ADDRESSED_HISTORY_CAPABILITY: &str = "addressed-history-1";

/// A session field's value when its socket did not declare [`ADDRESSED_HISTORY_CAPABILITY`].
pub const UNDECLARED: &str = "-";

/// The presence value this gateway writes: "every session of mine is a field of the sessions hash".
/// The same literal is `PRESENCE_SESSIONS` in chat-delivery.
pub const PRESENCE_SESSIONS: &str = "sessions-1";

/// The presence value every OLDER gateway writes, and which this one never overwrites nor deletes.
pub const PRESENCE_OLDER_GATEWAY: &str = "true";

/// Whether a `caps=` query value declares [`ADDRESSED_HISTORY_CAPABILITY`].
pub fn declares_addressed_history(caps: Option<&str>) -> bool {
    caps.is_some_and(|c| {
        c.split(',')
            .any(|cap| cap.trim() == ADDRESSED_HISTORY_CAPABILITY)
    })
}

/// The device's sessions hash, for `conn_key` = `"{userId}:{deviceId}"`.
pub fn sessions_key(conn_key: &str) -> String {
    format!("addressing:sessions:{}", conn_key)
}

/// One session's field: unique across gateway processes because `instance` is per process.
pub fn session_field(instance: &str, conn_id: u64) -> String {
    format!("{}:{}", instance, conn_id)
}

/// What a session's field holds.
pub fn session_value(declared: bool) -> &'static str {
    if declared {
        ADDRESSED_HISTORY_CAPABILITY
    } else {
        UNDECLARED
    }
}

/// THE EDGE FILTER. Splits a device's local sessions (`conn_ids`) into those a frame may reach and
/// those it must not: every one for an ordinary frame, only the sessions that declared
/// [`ADDRESSED_HISTORY_CAPABILITY`] for an addressed one. A session with no recorded declaration
/// counts as not declaring. Returns `(deliver, refused)`.
pub fn addressed_recipients(
    addressed: bool,
    conn_ids: impl IntoIterator<Item = u64>,
    declared: &HashMap<u64, bool>,
) -> (Vec<u64>, Vec<u64>) {
    conn_ids
        .into_iter()
        .partition(|id| !addressed || declared.get(id).copied().unwrap_or(false))
}

/// Records one session's declaration and refreshes the device's presence, atomically: the field
/// first (so no reader sees the presence value without this session's field), then the presence
/// value - unless an older gateway's `true` is there, which is left to its own session.
const WRITE_SESSION: &str = r"
redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
redis.call('HEXPIRE', KEYS[2], ARGV[3], 'FIELDS', 1, ARGV[1])
if redis.call('GET', KEYS[1]) ~= ARGV[5] then
  redis.call('SET', KEYS[1], ARGV[4], 'EX', ARGV[3])
end
return 1
";

/// Removes one session's field and, when `last` is 1, the device's presence - unless it is an older
/// gateway's `true`, which belongs to a session still refreshing it.
const LEAVE_SESSION: &str = r"
redis.call('HDEL', KEYS[2], ARGV[1])
if ARGV[2] == '1' and redis.call('GET', KEYS[1]) ~= ARGV[3] then
  redis.call('DEL', KEYS[1])
end
return 1
";

/// Write (or refresh) one session's field and the device's presence key, with `ttl_secs` on both.
pub async fn write_session(
    con: &mut MultiplexedConnection,
    conn_key: &str,
    field: &str,
    declared: bool,
    ttl_secs: u64,
) -> redis::RedisResult<()> {
    redis::Script::new(WRITE_SESSION)
        .key(format!("user:online:{}", conn_key))
        .key(sessions_key(conn_key))
        .arg(field)
        .arg(session_value(declared))
        .arg(ttl_secs)
        .arg(PRESENCE_SESSIONS)
        .arg(PRESENCE_OLDER_GATEWAY)
        .invoke_async::<()>(con)
        .await
}

/// Remove one session's field (`field` = `None` when only the presence is to go, as when the
/// pub/sub loop finds every sender of the device dead) and, when `last`, the device's presence key.
pub async fn leave_session(
    con: &mut MultiplexedConnection,
    conn_key: &str,
    field: Option<&str>,
    last: bool,
) -> redis::RedisResult<()> {
    redis::Script::new(LEAVE_SESSION)
        .key(format!("user:online:{}", conn_key))
        .key(sessions_key(conn_key))
        // HDEL of a field that is not there is a no-op; the empty name is never a session's.
        .arg(field.unwrap_or(""))
        .arg(if last { "1" } else { "0" })
        .arg(PRESENCE_OLDER_GATEWAY)
        .invoke_async::<()>(con)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_capability_is_read_from_the_caps_query_value() {
        assert!(declares_addressed_history(Some("addressed-history-1")));
        assert!(declares_addressed_history(Some(
            "other, addressed-history-1"
        )));
        assert!(!declares_addressed_history(Some("addressed-history-2")));
        assert!(!declares_addressed_history(None));
    }

    /// The hash must stay out of `user:*`: presence.rs and social-service SCAN `user:online:*`, and
    /// chat-delivery reads this exact key.
    #[test]
    fn the_sessions_hash_is_keyed_per_device_outside_the_presence_namespace() {
        assert_eq!(sessions_key("u1:d1"), "addressing:sessions:u1:d1");
        assert!(!sessions_key("u1:d1").starts_with("user:"));
    }

    /// Two gateway processes both count connections from 0: the field must still be unique.
    #[test]
    fn two_processes_never_share_a_session_field() {
        assert_ne!(session_field("a", 1), session_field("b", 1));
        assert_eq!(session_value(true), ADDRESSED_HISTORY_CAPABILITY);
        assert_eq!(session_value(false), UNDECLARED);
    }

    /// The value written must never be the older gateways' one, or chat-delivery could not tell a
    /// device an older gateway also serves.
    #[test]
    fn the_presence_value_is_distinct_from_the_older_gateways_one() {
        assert_ne!(PRESENCE_SESSIONS, PRESENCE_OLDER_GATEWAY);
    }

    /// Review P3 of #2270: chat-delivery checks the device before publishing, and a session may
    /// connect after - an addressed frame must still never reach it here.
    #[test]
    fn an_addressed_frame_reaches_only_the_sessions_that_declared() {
        let declared = HashMap::from([(1, true), (2, false)]);

        let (deliver, refused) = addressed_recipients(true, [1, 2, 3], &declared);

        assert_eq!(deliver, vec![1]);
        assert_eq!(refused, vec![2, 3]);
    }

    #[test]
    fn an_ordinary_frame_reaches_every_session() {
        let declared = HashMap::from([(1, true), (2, false)]);

        let (deliver, refused) = addressed_recipients(false, [1, 2, 3], &declared);

        assert_eq!(deliver, vec![1, 2, 3]);
        assert!(refused.is_empty());
    }
}
