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
//!   presence scans match): field `{instance}:{conn_id}`, value [`ADDRESSED_HISTORY_CAPABILITY`] or
//!   [`UNDECLARED`] - and NOTHING ELSE, ever: every chat-delivery that has shipped compares this
//!   value WHOLE, so a new capability gets its own hash rather than a new spelling here.
//!   Each field is written WITH its expiry in one command (`HSETEX`, Redis 8), refreshed by its own
//!   session only, and removed when that session ends. The expiry decides LIVENESS (how long a
//!   crashed process's field lingers), never safety: a lingering undeclared field only keeps the
//!   device unaddressable, a lingering declared one changes nothing.
//! - `addressing:join-ask:{userId}:{deviceId}`: the SAME fields, written in the same script with the
//!   same expiry, valued [`JOIN_ASK_CAPABILITY`] or [`UNDECLARED`]. chat-delivery publishes a join-ask
//!   frame to a device only when every field of the sessions hash has its twin here valued the
//!   capability - so a session recorded by an older gateway (no twin) counts as not declaring it -
//!   and the edge filter keeps the frame from any local session that did not. Kept apart so neither a
//!   reader older than it nor a gateway older than it ever meets a value it does not know, in either
//!   deploy direction.
//! - `addressing:left:{userId}:{deviceId}`: the sessions that LEFT, each for one TTL. A field name is
//!   never reused (its process id is fresh per process, its connection id per connection), so the
//!   name IS the session's generation token: a refresh already in flight when its session left finds
//!   the name here and writes nothing - a left session is never resurrected.
//! - the presence key `user:online:{userId}:{deviceId}` holds [`PRESENCE_SESSIONS`]. An older
//!   gateway writes `true` and records no field, and this gateway never overwrites nor deletes that
//!   `true`, so it survives exactly as long as the older gateway's session keeps refreshing it - the
//!   only trace chat-delivery can read of a session it cannot see the declaration of.
//!
//! The presence key goes when the LAST field goes - asked inside the leave script, of the shared
//! hash, so a session on another process keeps the device online and a leave in flight cannot
//! delete a presence a later session wrote.
//!
//! chat-delivery addresses a conversation frame to a device only when the presence value is
//! [`PRESENCE_SESSIONS`] and every field is the capability, and re-checks it in the same script as
//! its PUBLISH. Between that check and the frame's
//! arrival a new session may connect, so this gateway also filters at its EDGE
//! ([`deliverable_sessions`]): an addressed frame never reaches a session here that did not declare.

use redis::aio::MultiplexedConnection;
use std::collections::HashMap;

/// The capability a socket declares (`caps=` on `/api/ws`) when the code behind it refuses an
/// ADDRESSED conversation frame that is not a solicited history answer (rule 5). The same literal is
/// `ADDRESSED_HISTORY_CAPABILITY` in chat-delivery and in the client.
pub const ADDRESSED_HISTORY_CAPABILITY: &str = "addressed-history-1";

/// The capability a socket declares when the code behind it routes the invitation-link ask frames
/// (`group.join_ask`, `group.join_ask.settled`). chat-delivery publishes those only to a device ALL of
/// whose sessions declared it, and this gateway delivers a frame naming it (`requiresCapability`)
/// only to a session that did - so a client that predates them never meets a frame it cannot route.
/// The same literal is `JOIN_ASK_CAPABILITY` in chat-delivery and in the client.
pub const JOIN_ASK_CAPABILITY: &str = "join-ask-1";

/// Every capability this gateway records, each in its own hash.
pub const KNOWN_CAPABILITIES: [&str; 2] = [ADDRESSED_HISTORY_CAPABILITY, JOIN_ASK_CAPABILITY];

/// A session field's value when its socket declared none of [`KNOWN_CAPABILITIES`].
pub const UNDECLARED: &str = "-";

/// What ONE session declared on its socket, among [`KNOWN_CAPABILITIES`]. A name this gateway does
/// not know is not recorded: nothing here could honour it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SessionCaps {
    pub addressed_history: bool,
    pub join_ask: bool,
}

impl SessionCaps {
    /// Reads a `caps=` query value (comma-separated, spaces tolerated).
    pub fn from_query(caps: Option<&str>) -> Self {
        let named =
            |cap: &str| caps.is_some_and(|c| c.split(',').any(|declared| declared.trim() == cap));
        SessionCaps {
            addressed_history: named(ADDRESSED_HISTORY_CAPABILITY),
            join_ask: named(JOIN_ASK_CAPABILITY),
        }
    }

    /// Whether this session declared `capability`.
    pub fn holds(&self, capability: &str) -> bool {
        match capability {
            ADDRESSED_HISTORY_CAPABILITY => self.addressed_history,
            JOIN_ASK_CAPABILITY => self.join_ask,
            _ => false,
        }
    }

    /// The session's value in `capability`'s hash: the capability, or [`UNDECLARED`]. One value per
    /// hash, so every reader compares it whole - the history hash's values are byte-identical to what
    /// every gateway before the join-ask frames wrote.
    pub fn value_for(&self, capability: &'static str) -> &'static str {
        if self.holds(capability) {
            capability
        } else {
            UNDECLARED
        }
    }
}

/// The presence value this gateway writes: "every session of mine is a field of the sessions hash".
/// The same literal is `PRESENCE_SESSIONS` in chat-delivery.
pub const PRESENCE_SESSIONS: &str = "sessions-1";

/// The presence value every OLDER gateway writes, and which this one never overwrites nor deletes.
pub const PRESENCE_OLDER_GATEWAY: &str = "true";

/// The device's sessions hash, for `conn_key` = `"{userId}:{deviceId}"`.
pub fn sessions_key(conn_key: &str) -> String {
    format!("addressing:sessions:{}", conn_key)
}

/// The device's join-ask hash (the sessions hash's twin), for `conn_key` = `"{userId}:{deviceId}"`.
pub fn join_ask_key(conn_key: &str) -> String {
    format!("addressing:join-ask:{}", conn_key)
}

/// One session's field: unique across gateway processes because `instance` is per process.
pub fn session_field(instance: &str, conn_id: u64) -> String {
    format!("{}:{}", instance, conn_id)
}

/// The capability a frame from chat-delivery needs its receiving session to have declared, or
/// `None` for a frame every session takes. An ADDRESSED conversation frame needs
/// [`ADDRESSED_HISTORY_CAPABILITY`]; a control frame names its own in `requiresCapability`.
///
/// `Err` for a control frame naming a capability this gateway does not know: no session could have
/// declared it, so the frame reaches none, and the caller says so.
pub fn required_capability(
    frame: &serde_json::Value,
    is_control: bool,
) -> Result<Option<&'static str>, String> {
    if !is_control {
        let addressed = frame
            .get("addressed")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        return Ok(addressed.then_some(ADDRESSED_HISTORY_CAPABILITY));
    }
    match frame.get("requiresCapability") {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(serde_json::Value::String(named)) => KNOWN_CAPABILITIES
            .iter()
            .copied()
            .find(|cap| cap == named)
            .map(Some)
            .ok_or_else(|| format!("unknown capability \"{}\"", named)),
        Some(other) => Err(format!("requiresCapability is not a string: {}", other)),
    }
}

/// THE EDGE FILTER. Splits a device's local sessions (`conn_ids`) into those a frame may reach and
/// those it must not: every one when the frame needs nothing, only the sessions that declared
/// `required` otherwise. A session with no recorded declaration counts as declaring nothing.
/// Returns `(deliver, refused)`.
pub fn deliverable_sessions(
    required: Option<&str>,
    conn_ids: impl IntoIterator<Item = u64>,
    declared: &HashMap<u64, SessionCaps>,
) -> (Vec<u64>, Vec<u64>) {
    conn_ids.into_iter().partition(|id| match required {
        None => true,
        Some(cap) => declared.get(id).is_some_and(|caps| caps.holds(cap)),
    })
}

/// Records one session's declaration and refreshes the device's presence, atomically.
///
/// KEYS: presence, sessions, left, join-ask. ARGV: field, history value, ttl, sessions marker, older
/// marker, history capability, undeclared, join-ask value, join-ask capability. Each value is its
/// hash's capability or the undeclared marker. Everything is VALIDATED before the first write, so an
/// error leaves nothing behind; each field and its expiry are one command (`HSETEX`). A session that
/// left (its field is in the left hash) is never rewritten: returns 0. Otherwise both fields, then
/// the presence value - unless an older gateway's `true` is there, which is left to its own
/// session - and 1.
const WRITE_SESSION: &str = r"
local ttl = tonumber(ARGV[3])
if ARGV[1] == '' or not ttl or ttl < 1 or ttl % 1 ~= 0 then
  return redis.error_reply('ERR addressing: a session needs a name and a whole positive ttl')
end
if ARGV[2] ~= ARGV[6] and ARGV[2] ~= ARGV[7] then
  return redis.error_reply('ERR addressing: a session declares the capability or nothing')
end
if ARGV[8] ~= ARGV[9] and ARGV[8] ~= ARGV[7] then
  return redis.error_reply('ERR addressing: a session declares the capability or nothing')
end
if redis.call('HEXISTS', KEYS[3], ARGV[1]) == 1 then return 0 end
redis.call('HSETEX', KEYS[2], 'EX', ttl, 'FIELDS', 1, ARGV[1], ARGV[2])
redis.call('HSETEX', KEYS[4], 'EX', ttl, 'FIELDS', 1, ARGV[1], ARGV[8])
if redis.call('GET', KEYS[1]) ~= ARGV[5] then
  redis.call('SET', KEYS[1], ARGV[4], 'EX', ttl)
end
return 1
";

/// Retires one session and, when no session of the device is left on ANY process, its presence.
///
/// KEYS: presence, sessions, left, join-ask. ARGV: field (empty = retire nobody, only re-ask the
/// presence), ttl, older marker. The field is recorded as LEFT before it is removed from both
/// hashes, so no refresh can bring it back. The presence goes only when the sessions hash holds no
/// field after that - and never an older gateway's `true`, which belongs to a session still
/// refreshing it.
const LEAVE_SESSION: &str = r"
local ttl = tonumber(ARGV[2])
if not ttl or ttl < 1 or ttl % 1 ~= 0 then
  return redis.error_reply('ERR addressing: a whole positive ttl is required')
end
if ARGV[1] ~= '' then
  redis.call('HSETEX', KEYS[3], 'EX', ttl, 'FIELDS', 1, ARGV[1], '1')
  redis.call('HDEL', KEYS[2], ARGV[1])
  redis.call('HDEL', KEYS[4], ARGV[1])
end
if #redis.call('HKEYS', KEYS[2]) == 0 and redis.call('GET', KEYS[1]) ~= ARGV[3] then
  redis.call('DEL', KEYS[1])
end
return 1
";

/// The device's left-sessions hash, for `conn_key` = `"{userId}:{deviceId}"`.
pub fn left_key(conn_key: &str) -> String {
    format!("addressing:left:{}", conn_key)
}

/// Write (or refresh) one session's field and the device's presence key, with `ttl_secs` on both.
/// `Ok(false)` when the session has already left - the refresh was in flight and wrote nothing.
pub async fn write_session(
    con: &mut MultiplexedConnection,
    conn_key: &str,
    field: &str,
    declared: SessionCaps,
    ttl_secs: u64,
) -> redis::RedisResult<bool> {
    let written: i64 = redis::Script::new(WRITE_SESSION)
        .key(format!("user:online:{}", conn_key))
        .key(sessions_key(conn_key))
        .key(left_key(conn_key))
        .key(join_ask_key(conn_key))
        .arg(field)
        .arg(declared.value_for(ADDRESSED_HISTORY_CAPABILITY))
        .arg(ttl_secs)
        .arg(PRESENCE_SESSIONS)
        .arg(PRESENCE_OLDER_GATEWAY)
        .arg(ADDRESSED_HISTORY_CAPABILITY)
        .arg(UNDECLARED)
        .arg(declared.value_for(JOIN_ASK_CAPABILITY))
        .arg(JOIN_ASK_CAPABILITY)
        .invoke_async(con)
        .await?;
    Ok(written == 1)
}

/// Retire one session (`field` = `None` to retire nobody and only re-ask whether the device still
/// holds a session, as when the pub/sub loop finds every local sender dead), removing the device's
/// presence when no session of it is left on any process.
pub async fn leave_session(
    con: &mut MultiplexedConnection,
    conn_key: &str,
    field: Option<&str>,
    ttl_secs: u64,
) -> redis::RedisResult<()> {
    redis::Script::new(LEAVE_SESSION)
        .key(format!("user:online:{}", conn_key))
        .key(sessions_key(conn_key))
        .key(left_key(conn_key))
        .key(join_ask_key(conn_key))
        .arg(field.unwrap_or(""))
        .arg(ttl_secs)
        .arg(PRESENCE_OLDER_GATEWAY)
        .invoke_async::<i64>(con)
        .await
        .map(|_| ())
}

/// The two scripts against a REAL Redis - their whole point is atomicity and expiry, which no fake
/// can judge. Gated on `GATEWAY_IT_REDIS_URL`, set by CI's `test-rust` job against the production
/// digest; under CI a missing URL FAILS rather than skips:
///
/// ```text
/// docker run -d --rm -p 127.0.0.1:46379:6379 redis:8.10-alpine
/// GATEWAY_IT_REDIS_URL=redis://127.0.0.1:46379 cargo test addressing
/// ```
///
/// Each test uses its own device key, so it never touches a key anything else reads.
#[cfg(test)]
mod redis_it {
    use super::*;

    const HISTORY: SessionCaps = SessionCaps {
        addressed_history: true,
        join_ask: false,
    };
    const NONE: SessionCaps = SessionCaps {
        addressed_history: false,
        join_ask: false,
    };

    /// Review of #2442: a session declaring BOTH capabilities leaves the history value byte-identical
    /// to what every gateway before it wrote - an older chat-delivery compares it whole - and records
    /// join-ask in the twin hash, under the same field.
    #[tokio::test]
    async fn join_ask_is_recorded_beside_the_history_value_never_inside_it() {
        let Some(mut con) = redis().await else { return };
        let key = device();
        let both = SessionCaps {
            addressed_history: true,
            join_ask: true,
        };

        assert!(
            write_session(&mut con, &key, "p:1", both, 90)
                .await
                .unwrap()
        );
        write_session(&mut con, &key, "p:2", HISTORY, 90)
            .await
            .unwrap();

        let history = fields(&mut con, &key).await;
        assert_eq!(history["p:1"], ADDRESSED_HISTORY_CAPABILITY);
        assert_eq!(history["p:2"], ADDRESSED_HISTORY_CAPABILITY);
        let join_ask = join_ask_fields(&mut con, &key).await;
        assert_eq!(join_ask["p:1"], JOIN_ASK_CAPABILITY);
        assert_eq!(join_ask["p:2"], UNDECLARED);

        leave_session(&mut con, &key, Some("p:1"), 90)
            .await
            .unwrap();
        assert!(!join_ask_fields(&mut con, &key).await.contains_key("p:1"));
    }

    /// The script refuses a value that is neither its hash's capability nor the undeclared marker,
    /// and writes nothing.
    #[tokio::test]
    async fn a_value_naming_another_capability_is_refused() {
        let Some(mut con) = redis().await else { return };
        let key = device();
        for (history, join_ask) in [
            ("addressed-history-1,join-ask-1", UNDECLARED),
            (UNDECLARED, "nonsense-9"),
        ] {
            let refused: redis::RedisResult<i64> = redis::Script::new(WRITE_SESSION)
                .key(format!("user:online:{}", key))
                .key(sessions_key(&key))
                .key(left_key(&key))
                .key(join_ask_key(&key))
                .arg("p:1")
                .arg(history)
                .arg(90)
                .arg(PRESENCE_SESSIONS)
                .arg(PRESENCE_OLDER_GATEWAY)
                .arg(ADDRESSED_HISTORY_CAPABILITY)
                .arg(UNDECLARED)
                .arg(join_ask)
                .arg(JOIN_ASK_CAPABILITY)
                .invoke_async(&mut con)
                .await;
            assert!(refused.is_err());
        }

        assert!(fields(&mut con, &key).await.is_empty());
        assert!(join_ask_fields(&mut con, &key).await.is_empty());
        assert_eq!(presence(&mut con, &key).await, None);
    }

    async fn join_ask_fields(
        con: &mut MultiplexedConnection,
        key: &str,
    ) -> HashMap<String, String> {
        redis::cmd("HGETALL")
            .arg(join_ask_key(key))
            .query_async(con)
            .await
            .unwrap()
    }

    async fn redis() -> Option<MultiplexedConnection> {
        let Ok(url) = std::env::var("GATEWAY_IT_REDIS_URL") else {
            assert!(
                std::env::var("CI").is_err(),
                "GATEWAY_IT_REDIS_URL is unset under CI - the presence scripts would go untested"
            );
            eprintln!("GATEWAY_IT_REDIS_URL unset - the Redis half of addressing is not run here");
            return None;
        };
        let client = redis::Client::open(url).expect("GATEWAY_IT_REDIS_URL");
        Some(
            client
                .get_multiplexed_async_connection()
                .await
                .expect("Redis reachable"),
        )
    }

    fn device() -> String {
        format!("it-{}:d1", uuid::Uuid::new_v4())
    }

    async fn presence(con: &mut MultiplexedConnection, key: &str) -> Option<String> {
        redis::cmd("GET")
            .arg(format!("user:online:{}", key))
            .query_async(con)
            .await
            .unwrap()
    }

    async fn fields(con: &mut MultiplexedConnection, key: &str) -> HashMap<String, String> {
        redis::cmd("HGETALL")
            .arg(sessions_key(key))
            .query_async(con)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn a_session_is_written_with_its_expiry_and_the_presence_marker() {
        let Some(mut con) = redis().await else { return };
        let key = device();

        assert!(
            write_session(&mut con, &key, "p:1", HISTORY, 90)
                .await
                .unwrap()
        );

        assert_eq!(
            presence(&mut con, &key).await.as_deref(),
            Some(PRESENCE_SESSIONS)
        );
        assert_eq!(
            fields(&mut con, &key).await["p:1"],
            ADDRESSED_HISTORY_CAPABILITY
        );
        let ttl: Vec<i64> = redis::cmd("HTTL")
            .arg(sessions_key(&key))
            .arg("FIELDS")
            .arg(1)
            .arg("p:1")
            .query_async(&mut con)
            .await
            .unwrap();
        assert!(
            ttl[0] > 0 && ttl[0] <= 90,
            "the field carries its own expiry: {:?}",
            ttl
        );
    }

    #[tokio::test]
    async fn an_older_gateways_true_is_never_overwritten_nor_deleted() {
        let Some(mut con) = redis().await else { return };
        let key = device();
        let _: () = redis::cmd("SET")
            .arg(format!("user:online:{}", key))
            .arg(PRESENCE_OLDER_GATEWAY)
            .query_async(&mut con)
            .await
            .unwrap();

        write_session(&mut con, &key, "p:1", HISTORY, 90)
            .await
            .unwrap();
        assert_eq!(presence(&mut con, &key).await.as_deref(), Some("true"));

        leave_session(&mut con, &key, Some("p:1"), 90)
            .await
            .unwrap();
        assert_eq!(presence(&mut con, &key).await.as_deref(), Some("true"));
    }

    /// Review of #2270: the presence goes with the LAST session of the device on ANY process, asked
    /// of the shared hash inside the script - not of one process's local map.
    #[tokio::test]
    async fn the_presence_goes_only_with_the_last_session_on_any_process() {
        let Some(mut con) = redis().await else { return };
        let key = device();
        write_session(&mut con, &key, "a:1", HISTORY, 90)
            .await
            .unwrap();
        write_session(&mut con, &key, "b:1", NONE, 90)
            .await
            .unwrap();

        leave_session(&mut con, &key, Some("a:1"), 90)
            .await
            .unwrap();
        assert_eq!(
            presence(&mut con, &key).await.as_deref(),
            Some(PRESENCE_SESSIONS)
        );
        // A process that only re-asks (every local sender dead) removes nothing while one is left.
        leave_session(&mut con, &key, None, 90).await.unwrap();
        assert_eq!(
            presence(&mut con, &key).await.as_deref(),
            Some(PRESENCE_SESSIONS)
        );

        leave_session(&mut con, &key, Some("b:1"), 90)
            .await
            .unwrap();
        assert_eq!(presence(&mut con, &key).await, None);
        assert!(fields(&mut con, &key).await.is_empty());
    }

    /// Review of #2270: a refresh already in flight when its session left must not bring it back.
    #[tokio::test]
    async fn a_session_that_left_is_never_resurrected_by_a_late_refresh() {
        let Some(mut con) = redis().await else { return };
        let key = device();
        write_session(&mut con, &key, "p:1", NONE, 90)
            .await
            .unwrap();
        leave_session(&mut con, &key, Some("p:1"), 90)
            .await
            .unwrap();

        assert!(
            !write_session(&mut con, &key, "p:1", NONE, 90)
                .await
                .unwrap()
        );

        assert!(fields(&mut con, &key).await.is_empty());
        assert_eq!(presence(&mut con, &key).await, None);
    }

    /// A script that fails must leave NOTHING: everything is validated before the first write.
    #[tokio::test]
    async fn a_refused_write_leaves_nothing_behind() {
        let Some(mut con) = redis().await else { return };
        let key = device();

        assert!(
            write_session(&mut con, &key, "", HISTORY, 90)
                .await
                .is_err()
        );
        assert!(
            write_session(&mut con, &key, "p:1", HISTORY, 0)
                .await
                .is_err()
        );

        assert!(fields(&mut con, &key).await.is_empty());
        assert_eq!(presence(&mut con, &key).await, None);
    }

    /// Many sessions joining and leaving at once: each script runs alone, so whatever the
    /// interleaving the device ends with no field and no presence.
    #[tokio::test]
    async fn concurrent_sessions_end_with_nothing_left() {
        let Some(con) = redis().await else { return };
        let key = device();
        let mut tasks = Vec::new();
        for i in 0..40 {
            let mut c = con.clone();
            let key = key.clone();
            tasks.push(tokio::spawn(async move {
                let field = format!("p:{}", i);
                write_session(
                    &mut c,
                    &key,
                    &field,
                    if i % 2 == 0 { HISTORY } else { NONE },
                    90,
                )
                .await
                .unwrap();
                leave_session(&mut c, &key, Some(&field), 90).await.unwrap();
            }));
        }
        for t in tasks {
            t.await.unwrap();
        }
        let mut con = con;
        assert!(fields(&mut con, &key).await.is_empty());
        assert_eq!(presence(&mut con, &key).await, None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_capabilities_are_read_from_the_caps_query_value() {
        let history = SessionCaps::from_query(Some("addressed-history-1"));
        assert!(history.addressed_history && !history.join_ask);
        let both = SessionCaps::from_query(Some("join-ask-1, other, addressed-history-1"));
        assert!(both.addressed_history && both.join_ask);
        assert_eq!(
            SessionCaps::from_query(Some("addressed-history-2")),
            SessionCaps::default()
        );
        assert_eq!(SessionCaps::from_query(None), SessionCaps::default());
    }

    /// Each hash holds ONE value per session, compared whole by every reader: the capability or the
    /// undeclared marker, whatever else the socket declared.
    #[test]
    fn a_sessions_value_in_each_hash_is_that_capability_or_nothing() {
        let both = SessionCaps::from_query(Some("join-ask-1,addressed-history-1"));
        assert_eq!(
            both.value_for(ADDRESSED_HISTORY_CAPABILITY),
            ADDRESSED_HISTORY_CAPABILITY
        );
        assert_eq!(both.value_for(JOIN_ASK_CAPABILITY), JOIN_ASK_CAPABILITY);
        let history = SessionCaps::from_query(Some("addressed-history-1"));
        assert_eq!(history.value_for(JOIN_ASK_CAPABILITY), UNDECLARED);
        assert_eq!(
            SessionCaps::default().value_for(ADDRESSED_HISTORY_CAPABILITY),
            UNDECLARED
        );
    }

    #[test]
    fn the_join_ask_hash_is_keyed_per_device_outside_the_presence_namespace() {
        assert_eq!(join_ask_key("u1:d1"), "addressing:join-ask:u1:d1");
    }

    #[test]
    fn a_frame_names_the_capability_it_needs() {
        let addressed = serde_json::json!({ "addressed": true });
        let ordinary = serde_json::json!({ "addressed": false });
        let ask = serde_json::json!({ "requiresCapability": "join-ask-1" });
        let plain_control = serde_json::json!({});
        let unknown = serde_json::json!({ "requiresCapability": "nonsense-9" });

        assert_eq!(
            required_capability(&addressed, false),
            Ok(Some(ADDRESSED_HISTORY_CAPABILITY))
        );
        assert_eq!(required_capability(&ordinary, false), Ok(None));
        assert_eq!(
            required_capability(&ask, true),
            Ok(Some(JOIN_ASK_CAPABILITY))
        );
        assert_eq!(required_capability(&plain_control, true), Ok(None));
        assert!(required_capability(&unknown, true).is_err());
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
        let declared = sessions();

        let (deliver, refused) =
            deliverable_sessions(Some(ADDRESSED_HISTORY_CAPABILITY), [1, 2, 3, 4], &declared);

        assert_eq!(deliver, vec![1, 2]);
        assert_eq!(refused, vec![3, 4]);
    }

    /// A join-ask frame never reaches a session whose code predates it: there it would reach no
    /// handler and print an accusation for a frame nothing was wrong with.
    #[test]
    fn a_join_ask_frame_reaches_only_the_sessions_that_declared_it() {
        let declared = sessions();

        let (deliver, refused) =
            deliverable_sessions(Some(JOIN_ASK_CAPABILITY), [1, 2, 3, 4], &declared);

        assert_eq!(deliver, vec![2]);
        assert_eq!(refused, vec![1, 3, 4]);
    }

    #[test]
    fn an_ordinary_frame_reaches_every_session() {
        let declared = sessions();

        let (deliver, refused) = deliverable_sessions(None, [1, 2, 3, 4], &declared);

        assert_eq!(deliver, vec![1, 2, 3, 4]);
        assert!(refused.is_empty());
    }

    /// 1: history only (an older client), 2: both, 3: nothing, 4: no recorded declaration.
    fn sessions() -> HashMap<u64, SessionCaps> {
        HashMap::from([
            (1, SessionCaps::from_query(Some("addressed-history-1"))),
            (
                2,
                SessionCaps::from_query(Some("addressed-history-1,join-ask-1")),
            ),
            (3, SessionCaps::default()),
        ])
    }
}
