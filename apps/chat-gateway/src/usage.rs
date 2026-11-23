//! Distinct people per Paris day, per platform category and per app version, counted with no id
//! stored (`docs/wiki/usage-dashboard.md`).
//!
//! **WHERE THE FACT IS KNOWN.** This process holds, for every socket, the AUTHENTICATED account,
//! the platform its build declared ([`crate::census::ClientKind`]) and - at the upgrade only - the
//! request's `User-Agent`. The category is derived there ([`category`]) and the user agent dropped;
//! the account id is added to HyperLogLogs, which estimate how many distinct values were added and
//! cannot give one back.
//!
//! **AT MOST ONCE PER PARIS HOUR PER SOCKET.** [`SocketUsage`] remembers the hour it last counted, so
//! a pong every 15 s costs nothing more; a socket that lives across midnight is counted on the new
//! day at its first refresh after it. A Paris hour always starts on a UTC hour (both offsets are
//! whole hours), so the UTC hour index is the hour slot.
//!
//! **THE CLOCK IS THE CALLER'S** (an instant in Unix seconds), so every rule here is a pure function
//! a test drives; the Paris rule is pinned by `libs/contracts/usage-dashboard.json`, which the
//! NestJS services' `Intl` implementation reads too.

use chrono::{DateTime, Datelike, Duration, NaiveDate, TimeZone, Timelike, Utc};
use redis::aio::MultiplexedConnection;
use std::sync::atomic::{AtomicI64, Ordering};

/// The seven buckets a person is counted in (six decided by the owner, plus `other` for a build that
/// declared nothing). The same list, in the same order, is `categories` in the contract file, which
/// the social-service fold reads its keys by; [`category`] answers only these (pinned by a test).
#[cfg(test)]
const CATEGORIES: [&str; 7] = [
    "app_android",
    "app_ios",
    "app_desktop",
    "web_android",
    "web_ios",
    "web_desktop",
    "other",
];
/// Prefix of every key of the dashboard (the contract's `keyPrefix`).
pub const KEY_PREFIX: &str = "usage:";
/// A day's keys live 40 days: a calendar month is folded from its days' keys, and the fold
/// (social-service) gets a few days of slack after the month ends.
pub const DAY_KEY_TTL_SECS: u64 = 40 * 24 * 60 * 60;
/// An hour's key lives 30 days: the week-by-hour map reads the 28 days before today.
pub const HOUR_KEY_TTL_SECS: u64 = 30 * 24 * 60 * 60;
/// Distinct versions given their own key in one day; past it, a version is counted as `other`.
pub const MAX_VERSIONS_PER_DAY: usize = 32;

/// The platform category of a socket, from the platform its build declared and, for the web only,
/// the request's `User-Agent`. Only the returned name is kept; the user agent is never stored.
///
/// An iPad whose Safari asks for the desktop site sends a Mac user agent and is `web_desktop`:
/// nothing in the request tells it apart.
pub fn category(platform: &str, user_agent: Option<&str>) -> &'static str {
    match platform {
        "android" => "app_android",
        "ios" => "app_ios",
        "macos" | "windows" | "linux" => "app_desktop",
        "web" => match user_agent {
            Some(ua) if ua.contains("Android") => "web_android",
            Some(ua) if ua.contains("iPhone") || ua.contains("iPad") || ua.contains("iPod") => {
                "web_ios"
            }
            Some(_) => "web_desktop",
            // A browser always sends one: a web socket without it is not a browser we can place.
            None => "other",
        },
        _ => "other",
    }
}

/// The Paris calendar day and hour of an instant.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParisSlot {
    /// `YYYY-MM-DD`.
    pub day: String,
    /// 0..=23, Paris wall clock.
    pub hour: u32,
}

/// 01:00 UTC on the last Sunday of `month` (March or October: both have 31 days).
fn last_sunday_0100_utc(year: i32, month: u32) -> Option<DateTime<Utc>> {
    let last = NaiveDate::from_ymd_opt(year, month, 31)?;
    let back = last.weekday().num_days_from_sunday() as i64;
    let sunday = last - Duration::days(back);
    Some(Utc.from_utc_datetime(&sunday.and_hms_opt(1, 0, 0)?))
}

/// The Paris day and hour of `unix_secs`, by the EU summer-time rule (Directive 2000/84/EC): UTC+2
/// from the last Sunday of March 01:00 UTC to the last Sunday of October 01:00 UTC, UTC+1 otherwise.
/// `None` only for an instant chrono cannot represent.
pub fn paris_slot(unix_secs: i64) -> Option<ParisSlot> {
    let utc = DateTime::<Utc>::from_timestamp(unix_secs, 0)?;
    let summer_start = last_sunday_0100_utc(utc.year(), 3)?;
    let summer_end = last_sunday_0100_utc(utc.year(), 10)?;
    let offset_hours = if utc >= summer_start && utc < summer_end {
        2
    } else {
        1
    };
    let local = utc + Duration::hours(offset_hours);
    Some(ParisSlot {
        day: local.format("%Y-%m-%d").to_string(),
        hour: local.hour(),
    })
}

/// What one socket counts as, and the hour it last counted in.
#[derive(Debug)]
pub struct SocketUsage {
    user_id: String,
    category: &'static str,
    version: String,
    /// The UTC hour index (`unix_secs / 3600`) last counted; `i64::MIN` before the first.
    last_hour: AtomicI64,
}

impl SocketUsage {
    /// `version` is the census's bounded version ([`crate::census::ClientKind::from_query`]).
    pub fn new(user_id: String, category: &'static str, version: String) -> Self {
        SocketUsage {
            user_id,
            category,
            version,
            last_hour: AtomicI64::new(i64::MIN),
        }
    }

    /// The hour index to count at `unix_secs`, or `None` when this socket already counted in it.
    /// Claims the hour: a second call in the same hour answers `None`.
    pub fn claim(&self, unix_secs: i64) -> Option<i64> {
        let hour = unix_secs.div_euclid(3600);
        let previous = self.last_hour.swap(hour, Ordering::Relaxed);
        (previous != hour).then_some(hour)
    }

    /// Hands a claimed hour back after the write failed, so the next refresh tries again.
    pub fn release(&self, hour: i64) {
        let _ =
            self.last_hour
                .compare_exchange(hour, i64::MIN, Ordering::Relaxed, Ordering::Relaxed);
    }
}

/// The keys one count touches, in the order [`NOTE_PERSON`] reads them.
fn person_keys(slot: &ParisSlot, category: &str, version: &str) -> [String; 6] {
    let day = format!("{KEY_PREFIX}people:{}", slot.day);
    [
        day.clone(),
        format!("{day}:cat:{category}"),
        format!("{day}:versions"),
        format!("{day}:ver:{version}"),
        format!("{day}:ver:other"),
        format!("{KEY_PREFIX}people:h:{}T{:02}", slot.day, slot.hour),
    ]
}

/// Adds one account to the day's, the category's, the version's and the hour's HyperLogLogs, and
/// gives each key its expiry in the same call, so a key never exists without one. A version beyond
/// the day's first `ARGV[5]` is counted under `other` (the `versions` set bounds the keys a
/// client can mint). Answers 1 when the person was new to the day's total, else 0 (logged only).
const NOTE_PERSON: &str = r#"
local user = ARGV[1]
local version = ARGV[2]
local day_ttl = tonumber(ARGV[3])
local hour_ttl = tonumber(ARGV[4])
local max_versions = tonumber(ARGV[5])
local version_key = KEYS[4]
if redis.call('SISMEMBER', KEYS[3], version) == 0 then
  if redis.call('SCARD', KEYS[3]) >= max_versions then
    version = 'other'
    version_key = KEYS[5]
  end
end
redis.call('SADD', KEYS[3], version)
redis.call('EXPIRE', KEYS[3], day_ttl)
local fresh = redis.call('PFADD', KEYS[1], user)
redis.call('EXPIRE', KEYS[1], day_ttl)
redis.call('PFADD', KEYS[2], user)
redis.call('EXPIRE', KEYS[2], day_ttl)
redis.call('PFADD', version_key, user)
redis.call('EXPIRE', version_key, day_ttl)
redis.call('PFADD', KEYS[6], user)
redis.call('EXPIRE', KEYS[6], hour_ttl)
return fresh
"#;

/// Writes one count for `usage` at `slot` (one script call, [`NOTE_PERSON`]).
async fn write_person(
    con: &mut MultiplexedConnection,
    usage: &SocketUsage,
    slot: &ParisSlot,
) -> redis::RedisResult<i64> {
    let keys = person_keys(slot, usage.category, &usage.version);
    let script = redis::Script::new(NOTE_PERSON);
    let mut invocation = script.prepare_invoke();
    for key in &keys {
        invocation.key(key);
    }
    invocation
        .arg(&usage.user_id)
        .arg(&usage.version)
        .arg(DAY_KEY_TTL_SECS)
        .arg(HOUR_KEY_TTL_SECS)
        .arg(MAX_VERSIONS_PER_DAY)
        .invoke_async(con)
        .await
}

/// Counts this socket's person at `unix_secs` if it has not been counted in that Paris hour yet.
/// Called beside every presence write; a failure is logged and the hour handed back, never
/// propagated - it costs the dashboard one count, and the next refresh retries it.
pub async fn note_person(con: &mut MultiplexedConnection, usage: &SocketUsage, unix_secs: i64) {
    let Some(hour) = usage.claim(unix_secs) else {
        return;
    };
    let Some(slot) = paris_slot(unix_secs) else {
        tracing::error!("[usage] instant {unix_secs} has no Paris day - not counted");
        return;
    };
    match write_person(con, usage, &slot).await {
        // No account id: the dashboard names nobody, and neither does its log.
        Ok(fresh) => tracing::debug!(
            "[usage] counted a {} socket in {} {:02}h (new to the day: {})",
            usage.category,
            slot.day,
            slot.hour,
            fresh == 1
        ),
        Err(e) => {
            usage.release(hour);
            tracing::warn!(
                "[usage] a {} socket was NOT counted in {} {:02}h - retried at its next refresh: {}",
                usage.category,
                slot.day,
                slot.hour,
                e
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn contract() -> serde_json::Value {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../libs/contracts/usage-dashboard.json"
        );
        let text = std::fs::read_to_string(path).expect("the usage-dashboard contract");
        serde_json::from_str(&text).expect("valid JSON")
    }

    fn secs(iso: &str) -> i64 {
        DateTime::parse_from_rfc3339(iso)
            .expect("an RFC 3339 instant")
            .timestamp()
    }

    #[test]
    fn the_constants_are_the_contracts() {
        let c = contract();
        let listed: Vec<&str> = c["categories"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(listed, CATEGORIES);
        assert_eq!(c["keyPrefix"].as_str(), Some(KEY_PREFIX));
        assert_eq!(c["dayKeyTtlSecs"].as_u64(), Some(DAY_KEY_TTL_SECS));
        assert_eq!(c["hourKeyTtlSecs"].as_u64(), Some(HOUR_KEY_TTL_SECS));
        assert_eq!(
            c["maxVersionsPerDay"].as_u64(),
            Some(MAX_VERSIONS_PER_DAY as u64)
        );
    }

    #[test]
    fn the_paris_day_and_hour_agree_with_the_contract_on_every_edge() {
        for case in contract()["parisTime"].as_array().unwrap() {
            let instant = case["instant"].as_str().unwrap();
            let slot = paris_slot(secs(instant)).expect("a representable instant");
            assert_eq!(
                slot,
                ParisSlot {
                    day: case["day"].as_str().unwrap().to_string(),
                    hour: case["hour"].as_u64().unwrap() as u32,
                },
                "{instant}"
            );
        }
    }

    #[test]
    fn every_category_comes_from_the_declared_platform_and_the_web_user_agent() {
        for case in contract()["userAgents"].as_array().unwrap() {
            let platform = case["platform"].as_str().unwrap();
            let ua = case["userAgent"].as_str();
            assert_eq!(
                category(platform, ua),
                case["category"].as_str().unwrap(),
                "{platform} / {ua:?}"
            );
        }
    }

    #[test]
    fn every_category_derived_is_one_of_the_seven() {
        for platform in crate::census::PLATFORMS
            .iter()
            .chain(&[crate::census::OTHER, crate::census::UNKNOWN])
        {
            for ua in [None, Some("Android"), Some("iPhone"), Some("Windows")] {
                assert!(CATEGORIES.contains(&category(platform, ua)));
            }
        }
    }

    #[test]
    fn a_socket_counts_once_per_hour_and_again_in_the_next() {
        let usage = SocketUsage::new("u".into(), "web_desktop", "1.8.0".into());
        let t = secs("2026-11-23T10:00:05Z");
        assert_eq!(usage.claim(t), Some(t / 3600));
        assert_eq!(usage.claim(t + 15), None, "a pong in the same hour");
        assert_eq!(usage.claim(t + 3594), None, "the hour's last second");
        assert_eq!(usage.claim(t + 3595), Some(t / 3600 + 1), "the next hour");
    }

    #[test]
    fn a_released_hour_is_claimed_again() {
        let usage = SocketUsage::new("u".into(), "app_ios", "1.8.0".into());
        let t = secs("2026-11-23T10:00:00Z");
        let hour = usage.claim(t).unwrap();
        usage.release(hour);
        assert_eq!(usage.claim(t + 15), Some(hour));
    }

    #[test]
    fn a_socket_across_midnight_counts_on_the_new_day() {
        let usage = SocketUsage::new("u".into(), "app_android", "1.8.0".into());
        assert!(usage.claim(secs("2026-11-22T22:59:30Z")).is_some());
        let after = secs("2026-11-22T23:00:10Z");
        assert!(usage.claim(after).is_some());
        assert_eq!(paris_slot(after).unwrap().day, "2026-11-23");
    }

    #[test]
    fn the_keys_name_the_day_the_category_the_version_and_the_hour_and_no_one() {
        let slot = ParisSlot {
            day: "2026-11-23".into(),
            hour: 7,
        };
        let keys = person_keys(&slot, "web_ios", "1.8.0");
        assert_eq!(
            keys,
            [
                "usage:people:2026-11-23",
                "usage:people:2026-11-23:cat:web_ios",
                "usage:people:2026-11-23:versions",
                "usage:people:2026-11-23:ver:1.8.0",
                "usage:people:2026-11-23:ver:other",
                "usage:people:h:2026-11-23T07",
            ]
        );
    }
}

/// The script against a REAL Redis (gated like `census::redis_it`): the bound on versions and the
/// expiries are properties of the script, which no fake can judge. The test days are in the year
/// 2999, so no key collides with a real one.
#[cfg(test)]
mod redis_it {
    use super::*;

    async fn redis() -> Option<MultiplexedConnection> {
        let Ok(url) = std::env::var("GATEWAY_IT_REDIS_URL") else {
            assert!(
                std::env::var("CI").is_err(),
                "GATEWAY_IT_REDIS_URL is unset under CI - the usage counter would go untested"
            );
            eprintln!(
                "GATEWAY_IT_REDIS_URL unset - the Redis half of the usage counter is not run"
            );
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

    /// A day nobody else writes: one per test run.
    fn test_slot() -> ParisSlot {
        let n = uuid::Uuid::new_v4().as_u128() % 28 + 1;
        ParisSlot {
            day: format!(
                "2999-{:02}-{:02}",
                (uuid::Uuid::new_v4().as_u128() % 12) + 1,
                n
            ),
            hour: 9,
        }
    }

    async fn pfcount(con: &mut MultiplexedConnection, key: &str) -> i64 {
        redis::cmd("PFCOUNT")
            .arg(key)
            .query_async(con)
            .await
            .unwrap()
    }

    async fn ttl(con: &mut MultiplexedConnection, key: &str) -> i64 {
        redis::cmd("TTL").arg(key).query_async(con).await.unwrap()
    }

    async fn clean(con: &mut MultiplexedConnection, slot: &ParisSlot) {
        let mut keys: Vec<String> = Vec::new();
        for v in (0..40)
            .map(|i| format!("v{i}"))
            .chain(["other".to_string()])
        {
            keys.extend(person_keys(slot, "web_desktop", &v));
            keys.extend(person_keys(slot, "app_ios", &v));
        }
        let _: () = redis::cmd("DEL").arg(&keys).query_async(con).await.unwrap();
    }

    #[tokio::test]
    async fn one_person_on_two_devices_is_one_person_and_every_key_expires() {
        let Some(mut con) = redis().await else { return };
        let slot = test_slot();
        clean(&mut con, &slot).await;
        let phone = SocketUsage::new("alice".into(), "app_ios", "v1".into());
        let laptop = SocketUsage::new("alice".into(), "web_desktop", "v1".into());
        let bob = SocketUsage::new("bob".into(), "web_desktop", "v1".into());
        for u in [&phone, &laptop, &bob] {
            write_person(&mut con, u, &slot).await.unwrap();
        }
        let keys = person_keys(&slot, "web_desktop", "v1");
        assert_eq!(pfcount(&mut con, &keys[0]).await, 2, "the day: two people");
        assert_eq!(pfcount(&mut con, &keys[1]).await, 2, "web_desktop: two");
        let ios = person_keys(&slot, "app_ios", "v1");
        assert_eq!(pfcount(&mut con, &ios[1]).await, 1, "app_ios: one");
        assert_eq!(pfcount(&mut con, &keys[3]).await, 2, "v1: two");
        assert_eq!(pfcount(&mut con, &keys[5]).await, 2, "the hour: two");
        for key in &keys {
            if key.ends_with(":ver:other") {
                continue;
            }
            let left = ttl(&mut con, key).await;
            assert!(left > 0, "{key} has no expiry");
        }
        assert!(ttl(&mut con, &keys[5]).await <= HOUR_KEY_TTL_SECS as i64);
        assert!(ttl(&mut con, &keys[0]).await > HOUR_KEY_TTL_SECS as i64);
        clean(&mut con, &slot).await;
    }

    #[tokio::test]
    async fn a_version_past_the_days_bound_is_counted_as_other() {
        let Some(mut con) = redis().await else { return };
        let slot = test_slot();
        clean(&mut con, &slot).await;
        for i in 0..(MAX_VERSIONS_PER_DAY + 3) {
            let u = SocketUsage::new(format!("p{i}"), "web_desktop", format!("v{i}"));
            write_person(&mut con, &u, &slot).await.unwrap();
        }
        let keys = person_keys(&slot, "web_desktop", "v0");
        let versions: usize = redis::cmd("SCARD")
            .arg(&keys[2])
            .query_async(&mut con)
            .await
            .unwrap();
        assert_eq!(
            versions,
            MAX_VERSIONS_PER_DAY + 1,
            "32 versions and `other`"
        );
        assert_eq!(
            pfcount(&mut con, &keys[4]).await,
            3,
            "three people under other"
        );
        let past = person_keys(&slot, "web_desktop", &format!("v{}", MAX_VERSIONS_PER_DAY));
        assert_eq!(pfcount(&mut con, &past[3]).await, 0, "no key for v32");
        // A version already listed keeps its own key whatever the bound.
        let again = SocketUsage::new("late".into(), "web_desktop", "v0".into());
        write_person(&mut con, &again, &slot).await.unwrap();
        assert_eq!(pfcount(&mut con, &keys[3]).await, 2);
        clean(&mut con, &slot).await;
    }
}
