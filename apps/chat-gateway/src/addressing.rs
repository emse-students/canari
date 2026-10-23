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
//!   Each field is written WITH its expiry in one command (`HSETEX`, Redis 8), refreshed by its own
//!   session only, and removed when that session ends. The expiry decides LIVENESS (how long a
//!   crashed process's field lingers), never safety: a lingering undeclared field only keeps the
//!   device unaddressable, a lingering declared one changes nothing.
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

/// Records one session's declaration and refreshes the device's presence, atomically.
///
/// KEYS: presence, sessions, left. ARGV: field, value, ttl, sessions marker, older marker,
/// capability, undeclared. Everything is VALIDATED before the first write, so an error leaves
/// nothing behind; the field and its expiry are one command (`HSETEX`). A session that left (its
/// field is in the left hash) is never rewritten: returns 0. Otherwise the field, then the presence
/// value - unless an older gateway's `true` is there, which is left to its own session - and 1.
const WRITE_SESSION: &str = r"
local ttl = tonumber(ARGV[3])
if ARGV[1] == '' or not ttl or ttl < 1 or ttl % 1 ~= 0 then
  return redis.error_reply('ERR addressing: a session needs a name and a whole positive ttl')
end
if ARGV[2] ~= ARGV[6] and ARGV[2] ~= ARGV[7] then
  return redis.error_reply('ERR addressing: a session declares the capability or nothing')
end
if redis.call('HEXISTS', KEYS[3], ARGV[1]) == 1 then return 0 end
redis.call('HSETEX', KEYS[2], 'EX', ttl, 'FIELDS', 1, ARGV[1], ARGV[2])
if redis.call('GET', KEYS[1]) ~= ARGV[5] then
  redis.call('SET', KEYS[1], ARGV[4], 'EX', ttl)
end
return 1
";

/// Retires one session and, when no session of the device is left on ANY process, its presence.
///
/// KEYS: presence, sessions, left. ARGV: field (empty = retire nobody, only re-ask the presence),
/// ttl, older marker. The field is recorded as LEFT before it is removed, so no refresh can bring it
/// back. The presence goes only when the hash holds no field after that - and never an older
/// gateway's `true`, which belongs to a session still refreshing it.
const LEAVE_SESSION: &str = r"
local ttl = tonumber(ARGV[2])
if not ttl or ttl < 1 or ttl % 1 ~= 0 then
  return redis.error_reply('ERR addressing: a whole positive ttl is required')
end
if ARGV[1] ~= '' then
  redis.call('HSETEX', KEYS[3], 'EX', ttl, 'FIELDS', 1, ARGV[1], '1')
  redis.call('HDEL', KEYS[2], ARGV[1])
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
    declared: bool,
    ttl_secs: u64,
) -> redis::RedisResult<bool> {
    let written: i64 = redis::Script::new(WRITE_SESSION)
        .key(format!("user:online:{}", conn_key))
        .key(sessions_key(conn_key))
        .key(left_key(conn_key))
        .arg(field)
        .arg(session_value(declared))
        .arg(ttl_secs)
        .arg(PRESENCE_SESSIONS)
        .arg(PRESENCE_OLDER_GATEWAY)
        .arg(ADDRESSED_HISTORY_CAPABILITY)
        .arg(UNDECLARED)
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
            write_session(&mut con, &key, "p:1", true, 90)
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

        write_session(&mut con, &key, "p:1", true, 90)
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
        write_session(&mut con, &key, "a:1", true, 90)
            .await
            .unwrap();
        write_session(&mut con, &key, "b:1", false, 90)
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
        write_session(&mut con, &key, "p:1", false, 90)
            .await
            .unwrap();
        leave_session(&mut con, &key, Some("p:1"), 90)
            .await
            .unwrap();

        assert!(
            !write_session(&mut con, &key, "p:1", false, 90)
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

        assert!(write_session(&mut con, &key, "", true, 90).await.is_err());
        assert!(write_session(&mut con, &key, "p:1", true, 0).await.is_err());

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
                write_session(&mut c, &key, &field, i % 2 == 0, 90)
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
