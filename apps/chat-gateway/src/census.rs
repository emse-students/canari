//! The anonymous census of who is connected, and its 24-hour series
//! (`docs/wiki/services/chat-gateway.md#the-anonymous-census-and-its-24-hour-series-2026-11-02`).
//!
//! **AGGREGATE, NEVER PER PERSON.** A census holds counts - connected devices and connected
//! users - broken down by the platform and the app version a socket declared. No user id, device id
//! or address reaches a sample, the history, or the admin routes that serve them; the identities
//! this module reads (the `user:online:*` keys) are read only to be counted and are never copied.
//!
//! WHERE THE FACTS LIVE, and why a replica never counts for itself:
//!
//! - what a device declared (platform, version) is a SHARED key, `monitor:client:{userId}:{deviceId}`,
//!   written next to the presence refresh with the presence TTL, and deliberately outside `user:*`
//!   (the presence scans match that namespace);
//! - the census is derived from the SHARED presence keys, never from a process's own socket map. A
//!   rolling deploy runs two gateways and a device may hold a session on each; counting per process
//!   and adding would count it twice, while the keys name it once;
//! - the series is ONE sorted set, `monitor:presence:samples`, scored by the minute a sample
//!   describes, one member per minute. Every replica samples, and the write is idempotent per
//!   minute - the first replica to write a minute wins, the others find it taken - so the number of
//!   replicas changes nothing and no election, lock or leader exists. TIME COMES FROM REDIS, never
//!   from a replica's own clock: the write script reads `TIME`, trims against it, and REFUSES a
//!   minute more than one interval away from it (the refusal is logged naming the skew), so a
//!   replica whose clock is wrong can neither wipe real history nor plant future samples nor take a
//!   minute's slot from a correct one. Its own clock only decides WHEN it tries; a skewed replica
//!   leaves its minutes to the others.
//! - **a cell of fewer than [`HISTORY_MIN_CELL`] devices is never kept in the series**: it would
//!   identify the person behind it, whose connections an admin could then read to the minute. See
//!   [`aggregate`].
//!
//! A minute nobody sampled (every gateway restarting, Redis down) has NO member: the admin page draws
//! it as a gap, and nothing here interpolates one.

use redis::aio::MultiplexedConnection;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use crate::state::AppState;

/// Platforms a client may declare; anything else is recorded as [`OTHER`], so a hostile or buggy
/// client cannot mint a new series.
pub const PLATFORMS: [&str; 6] = ["web", "android", "ios", "macos", "windows", "linux"];
/// What a platform or version outside the bounds is recorded as.
pub const OTHER: &str = "other";
/// What a client that declared nothing (a build older than this feature) is recorded as.
pub const UNKNOWN: &str = "unknown";
/// Longest version string kept; a longer one is [`OTHER`].
const MAX_VERSION_LEN: usize = 32;
/// Most distinct versions one sample names; the rarest beyond it merge into [`OTHER`]. Bounds a
/// sample's size whatever a client declares.
pub const MAX_VERSIONS_PER_SAMPLE: usize = 32;

/// The fewest devices a (platform, version) cell may hold in the 24-hour series. A cell of one device
/// names a person in effect (their connections readable to the minute), so smaller cells are merged
/// by [`aggregate`] before a sample is written. The LIVE census keeps every cell (minimum 1).
pub const HISTORY_MIN_CELL: u64 = 3;

/// One sample per this many seconds.
pub const SAMPLE_INTERVAL_SECS: i64 = 60;
/// How much history is kept, in seconds: 24 hours.
pub const RETENTION_SECS: i64 = 24 * 60 * 60;
/// The sorted set holding the series.
pub const SAMPLES_KEY: &str = "monitor:presence:samples";
/// Prefix of the shared keys holding what a device declared.
const CLIENT_KEY_PREFIX: &str = "monitor:client:";

/// What one socket declared about the code behind it. Bounded: see [`PLATFORMS`], [`OTHER`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClientKind {
    pub platform: String,
    pub version: String,
}

impl ClientKind {
    /// Reads the `platform=` and `app_version=` query values a socket declared. A missing value is
    /// [`UNKNOWN`] (an older build), an out-of-bounds one is [`OTHER`]; build metadata (`+...`) is
    /// dropped, as the client's own version gate drops it.
    pub fn from_query(platform: Option<&str>, version: Option<&str>) -> Self {
        let platform = match platform.map(str::trim).filter(|p| !p.is_empty()) {
            None => UNKNOWN.to_string(),
            Some(p) if PLATFORMS.contains(&p) => p.to_string(),
            Some(_) => OTHER.to_string(),
        };
        let version = match version.map(str::trim).filter(|v| !v.is_empty()) {
            None => UNKNOWN.to_string(),
            Some(v) => {
                let core = v.split('+').next().unwrap_or("");
                let well_formed = !core.is_empty()
                    && core.len() <= MAX_VERSION_LEN
                    && core
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
                if well_formed {
                    core.to_string()
                } else {
                    OTHER.to_string()
                }
            }
        };
        ClientKind { platform, version }
    }

    /// The stored form, `platform|version` (neither part can hold a `|`).
    fn encode(&self) -> String {
        format!("{}|{}", self.platform, self.version)
    }

    /// Reads the stored form back; a missing or malformed value is [`UNKNOWN`] on both axes.
    fn decode(stored: Option<&str>) -> Self {
        match stored.and_then(|s| s.split_once('|')) {
            Some((platform, version)) if !platform.is_empty() && !version.is_empty() => {
                ClientKind {
                    platform: platform.to_string(),
                    version: version.to_string(),
                }
            }
            _ => ClientKind {
                platform: UNKNOWN.to_string(),
                version: UNKNOWN.to_string(),
            },
        }
    }
}

/// One cell of the breakdown: how many devices (and distinct users) run `version` on `platform`.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Group {
    pub platform: String,
    pub version: String,
    pub devices: u64,
    pub users: u64,
}

/// Counts of who is connected right now. `users` is DISTINCT across the whole population, so it is
/// not the sum of the groups' users (one person on two platforms is one user, two devices).
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Census {
    pub devices: u64,
    pub users: u64,
    pub groups: Vec<Group>,
}

/// One minute of the series: a [`Census`] and the minute it describes (Unix seconds, a multiple of
/// [`SAMPLE_INTERVAL_SECS`]).
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Sample {
    pub t: i64,
    #[serde(flatten)]
    pub census: Census,
}

/// Counts a population. `devices` holds ONE entry per connected device - `(user id, declaration)` -
/// which is what the shared presence keys give and a per-process map does not. The ids are used to
/// count distinct users and are not kept.
///
/// `min_cell` is the fewest devices a (platform, version) cell may hold: a smaller one is merged
/// into `other`, BY PLATFORM FIRST (the version is dissolved: `(ios, 1.5.4)` of 1 device joins
/// `(ios, other)`), then BY VERSION (a platform's remaining cell still under the minimum joins
/// `(other, other)`, the platform dissolved too). Totals never change - only how finely they are
/// split. The live census passes 1 (no merge); the series passes [`HISTORY_MIN_CELL`].
///
/// The output is deterministic: groups sorted by platform, then devices descending, then version.
pub fn aggregate(devices: &[(String, ClientKind)], min_cell: u64) -> Census {
    let mut per_version: HashMap<&str, u64> = HashMap::new();
    for (_, kind) in devices {
        *per_version.entry(kind.version.as_str()).or_default() += 1;
    }
    let mut ranked: Vec<(&str, u64)> = per_version.into_iter().collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
    let kept: HashSet<&str> = ranked
        .iter()
        .take(MAX_VERSIONS_PER_SAMPLE)
        .map(|(v, _)| *v)
        .collect();

    type Cell = (u64, HashSet<String>);
    let mut cells: BTreeMap<(String, String), Cell> = BTreeMap::new();
    let mut everyone: HashSet<&str> = HashSet::new();
    for (user, kind) in devices {
        let version = if kept.contains(kind.version.as_str()) {
            kind.version.clone()
        } else {
            OTHER.to_string()
        };
        let cell = cells
            .entry((kind.platform.clone(), version))
            .or_insert_with(|| (0, HashSet::new()));
        cell.0 += 1;
        cell.1.insert(user.clone());
        everyone.insert(user.as_str());
    }

    // Merge the small cells: by platform first (dissolve the version), then by version (dissolve the
    // platform). Each pass reads the result of the one before it.
    let fold = |cells: &mut BTreeMap<(String, String), Cell>, dissolve_platform: bool| {
        let small: Vec<(String, String)> = cells
            .iter()
            .filter(|((platform, version), (n, _))| {
                *n < min_cell
                    && if dissolve_platform {
                        platform != OTHER
                    } else {
                        version != OTHER
                    }
            })
            .map(|(k, _)| k.clone())
            .collect();
        for key in small {
            let Some((n, users)) = cells.remove(&key) else {
                continue;
            };
            let target = if dissolve_platform {
                (OTHER.to_string(), OTHER.to_string())
            } else {
                (key.0.clone(), OTHER.to_string())
            };
            let into = cells.entry(target).or_insert_with(|| (0, HashSet::new()));
            into.0 += n;
            into.1.extend(users);
        }
    };
    if min_cell > 1 {
        fold(&mut cells, false);
        fold(&mut cells, true);
    }

    let mut groups: Vec<Group> = cells
        .into_iter()
        .map(|((platform, version), (devices, users))| Group {
            platform,
            version,
            devices,
            users: users.len() as u64,
        })
        .collect();
    groups.sort_by(|a, b| {
        a.platform
            .cmp(&b.platform)
            .then_with(|| b.devices.cmp(&a.devices))
            .then_with(|| a.version.cmp(&b.version))
    });
    Census {
        devices: devices.len() as u64,
        users: everyone.len() as u64,
        groups,
    }
}

/// The shared key a device's declaration lives under, for `conn_key` = `"{userId}:{deviceId}"`.
pub fn client_key(conn_key: &str) -> String {
    format!("{CLIENT_KEY_PREFIX}{conn_key}")
}

/// Record what a device declared, with `ttl_secs` (the presence TTL: the declaration lives exactly
/// as long as the presence it describes keeps being refreshed). Last session wins - two tabs of one
/// device run one build.
pub async fn note_client(
    con: &mut MultiplexedConnection,
    conn_key: &str,
    client: &ClientKind,
    ttl_secs: u64,
) -> redis::RedisResult<()> {
    redis::cmd("SET")
        .arg(client_key(conn_key))
        .arg(client.encode())
        .arg("EX")
        .arg(ttl_secs)
        .query_async::<()>(con)
        .await
}

/// Every connected `(userId, deviceId)`, from the shared presence keys: ONE entry per device, on
/// whichever gateway process holds it. Uses SCAN, never KEYS.
pub async fn list_online(
    con: &mut MultiplexedConnection,
) -> redis::RedisResult<Vec<(String, String)>> {
    let mut online = Vec::new();
    let mut seen = HashSet::new();
    let mut cursor: u64 = 0;
    loop {
        let (next, keys): (u64, Vec<String>) = redis::cmd("SCAN")
            .arg(cursor)
            .arg("MATCH")
            .arg("user:online:*:*")
            .arg("COUNT")
            .arg(500u64)
            .query_async(con)
            .await?;
        for key in keys {
            // user:online:{userId}:{deviceId}; splitn(4) keeps a device id that holds a ':'.
            let parts: Vec<&str> = key.splitn(4, ':').collect();
            if parts.len() == 4 && seen.insert(key.clone()) {
                online.push((parts[2].to_string(), parts[3].to_string()));
            }
        }
        cursor = next;
        if cursor == 0 {
            return Ok(online);
        }
    }
}

/// What each of `devices` declared, in order; a device with no declaration is [`UNKNOWN`].
pub async fn declared_kinds(
    con: &mut MultiplexedConnection,
    devices: &[(String, String)],
) -> redis::RedisResult<Vec<ClientKind>> {
    let mut kinds = Vec::with_capacity(devices.len());
    for chunk in devices.chunks(200) {
        let mut cmd = redis::cmd("MGET");
        for (user, device) in chunk {
            cmd.arg(client_key(&format!("{user}:{device}")));
        }
        let stored: Vec<Option<String>> = cmd.query_async(con).await?;
        kinds.extend(stored.iter().map(|s| ClientKind::decode(s.as_deref())));
    }
    Ok(kinds)
}

/// The census of everybody connected right now, on every gateway process, with cells of fewer than
/// `min_cell` devices merged (see [`aggregate`]): 1 for the live view, [`HISTORY_MIN_CELL`] for a
/// sample that will be kept.
pub async fn read_census(
    con: &mut MultiplexedConnection,
    min_cell: u64,
) -> redis::RedisResult<Census> {
    let online = list_online(con).await?;
    let kinds = declared_kinds(con, &online).await?;
    let population: Vec<(String, ClientKind)> = online
        .into_iter()
        .zip(kinds)
        .map(|((user, _device), kind)| (user, kind))
        .collect();
    Ok(aggregate(&population, min_cell))
}

/// Redis's own clock, in Unix seconds: the ONE clock the series is written and read against.
pub async fn redis_now(con: &mut MultiplexedConnection) -> redis::RedisResult<i64> {
    let (secs, _micros): (i64, i64) = redis::cmd("TIME").query_async(con).await?;
    Ok(secs)
}

/// Writes the sample of the minute `t` unless a replica already did, and trims what is older than
/// [`RETENTION_SECS`] - against REDIS's `TIME`, never against `t`. One script, so the check and the
/// write cannot interleave.
///
/// A `t` more than one interval away from Redis's clock is REFUSED, and nothing is written or
/// trimmed: a replica whose clock is ahead would otherwise trim real history relative to a future
/// minute, plant samples the read would serve, and hold minute slots the correct replicas then find
/// taken. Returns `{status, redis_now}`: status 1 = written, 0 = the minute was taken, -1 = refused.
/// KEYS: the series. ARGV: minute, payload, retention, interval.
const RECORD_SAMPLE: &str = r"
local t = tonumber(ARGV[1])
local keep = tonumber(ARGV[3])
local step = tonumber(ARGV[4])
if not t or not keep or keep < 1 or not step or step < 1 then
  return redis.error_reply('ERR census: a sample needs a minute, a positive retention and a positive interval')
end
local now = tonumber(redis.call('TIME')[1])
if math.abs(t - now) > step then
  return {-1, now}
end
local status = 0
if redis.call('ZCOUNT', KEYS[1], t, t) == 0 then
  redis.call('ZADD', KEYS[1], t, ARGV[2])
  status = 1
end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - keep)
redis.call('EXPIRE', KEYS[1], keep + 3600)
return {status, now}
";

/// What [`record_sample`] did with a minute.
#[derive(Debug, PartialEq, Eq)]
pub enum SampleOutcome {
    /// This call wrote the minute.
    Wrote,
    /// Another replica had already written it.
    Taken,
    /// The minute is further than one interval from Redis's clock: this replica's clock is off by
    /// `skew` seconds (positive = ahead of Redis). Nothing was written or trimmed.
    Skewed { skew: i64 },
}

/// Whether the series `key` already holds the minute `t`. Asked BEFORE the census is read: a taken
/// minute costs one `ZCOUNT`, not a scan of every presence key.
pub async fn minute_taken(
    con: &mut MultiplexedConnection,
    key: &str,
    t: i64,
) -> redis::RedisResult<bool> {
    let n: i64 = redis::cmd("ZCOUNT")
        .arg(key)
        .arg(t)
        .arg(t)
        .query_async(con)
        .await?;
    Ok(n > 0)
}

/// Record `census` as the sample of the minute `t` in the series `key`; see [`RECORD_SAMPLE`].
pub async fn record_sample(
    con: &mut MultiplexedConnection,
    key: &str,
    t: i64,
    census: &Census,
) -> redis::RedisResult<SampleOutcome> {
    let payload = serde_json::to_string(&Sample {
        t,
        census: census.clone(),
    })
    .map_err(|e| {
        redis::RedisError::from((
            redis::ErrorKind::Client,
            "census sample is not serialisable",
            e.to_string(),
        ))
    })?;
    let (status, now): (i64, i64) = redis::Script::new(RECORD_SAMPLE)
        .key(key)
        .arg(t)
        .arg(payload)
        .arg(RETENTION_SECS)
        .arg(SAMPLE_INTERVAL_SECS)
        .invoke_async(con)
        .await?;
    Ok(match status {
        1 => SampleOutcome::Wrote,
        0 => SampleOutcome::Taken,
        _ => SampleOutcome::Skewed { skew: t - now },
    })
}

/// Every sample of the series `key` in the window `(now - RETENTION_SECS, now]`, oldest first, where
/// `now` is REDIS's clock ([`redis_now`]): nothing scored in the future is ever served. A member that
/// does not parse is skipped and logged: it can only be a foreign write, and a gap is the honest
/// rendering of a minute nobody can read.
pub async fn read_series(
    con: &mut MultiplexedConnection,
    key: &str,
    now: i64,
) -> redis::RedisResult<Vec<Sample>> {
    let members: Vec<String> = redis::cmd("ZRANGEBYSCORE")
        .arg(key)
        .arg(format!("({}", now - RETENTION_SECS))
        .arg(now)
        .query_async(con)
        .await?;
    Ok(members
        .iter()
        .filter_map(|m| match serde_json::from_str::<Sample>(m) {
            Ok(sample) => Some(sample),
            Err(e) => {
                tracing::warn!(
                    "[census] an unreadable member of {} was skipped: {}",
                    key,
                    e
                );
                None
            }
        })
        .collect())
}

/// Take and record the sample of the minute containing `now` (this replica's clock - which only
/// decides WHEN to try; Redis decides whether the minute is acceptable).
async fn sample_once(state: &AppState, now: i64) {
    let bucket = now - now.rem_euclid(SAMPLE_INTERVAL_SECS);
    let mut con = match state.redis_client.get_multiplexed_async_connection().await {
        Ok(con) => con,
        Err(e) => {
            tracing::warn!(
                "[census] Redis unreachable - minute {} left as a gap: {}",
                bucket,
                e
            );
            return;
        }
    };
    match minute_taken(&mut con, SAMPLES_KEY, bucket).await {
        Ok(true) => {
            tracing::debug!(
                "[census] minute {} already taken by another replica - no scan",
                bucket
            );
            return;
        }
        Ok(false) => {}
        Err(e) => {
            tracing::warn!(
                "[census] the series read failed - minute {} left as a gap: {}",
                bucket,
                e
            );
            return;
        }
    }
    let census = match read_census(&mut con, HISTORY_MIN_CELL).await {
        Ok(census) => census,
        Err(e) => {
            tracing::warn!(
                "[census] the census read failed - minute {} left as a gap: {}",
                bucket,
                e
            );
            return;
        }
    };
    match record_sample(&mut con, SAMPLES_KEY, bucket, &census).await {
        Ok(SampleOutcome::Skewed { skew }) => tracing::warn!(
            "[census] this replica's clock is {} s {} Redis's - minute {} REFUSED, nothing written",
            skew.abs(),
            if skew > 0 { "ahead of" } else { "behind" },
            bucket
        ),
        Ok(outcome) => tracing::debug!(
            "[census] minute {}: {} devices, {} users ({:?})",
            bucket,
            census.devices,
            census.users,
            outcome
        ),
        Err(e) => tracing::warn!(
            "[census] the sample write failed - minute {} left as a gap: {}",
            bucket,
            e
        ),
    }
}

/// Start the sampler: at every minute boundary, take a sample. Every replica runs it; see the module
/// docs for why that is safe.
pub fn spawn_sampler(state: Arc<AppState>) {
    tokio::spawn(async move {
        loop {
            let now = chrono::Utc::now().timestamp();
            let wait = SAMPLE_INTERVAL_SECS - now.rem_euclid(SAMPLE_INTERVAL_SECS);
            tokio::time::sleep(Duration::from_secs(wait as u64)).await;
            sample_once(&state, chrono::Utc::now().timestamp()).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kind(platform: &str, version: &str) -> ClientKind {
        ClientKind::from_query(Some(platform), Some(version))
    }

    fn device(user: &str, platform: &str, version: &str) -> (String, ClientKind) {
        (user.to_string(), kind(platform, version))
    }

    #[test]
    fn a_declaration_is_bounded() {
        assert_eq!(kind("ios", "1.5.4+77").version, "1.5.4");
        assert_eq!(kind("ios", "1.6.3-alpha.2").version, "1.6.3-alpha.2");
        assert_eq!(kind("toaster", "1.0.0").platform, OTHER);
        assert_eq!(kind("web", "../../etc").version, OTHER);
        assert_eq!(kind("web", &"9".repeat(40)).version, OTHER);
        let silent = ClientKind::from_query(None, Some("  "));
        assert_eq!(
            (silent.platform.as_str(), silent.version.as_str()),
            (UNKNOWN, UNKNOWN)
        );
    }

    #[test]
    fn the_stored_form_round_trips_and_a_missing_one_is_unknown() {
        let k = kind("android", "1.5.4");
        assert_eq!(ClientKind::decode(Some(&k.encode())), k);
        assert_eq!(
            ClientKind::decode(None),
            ClientKind::decode(Some("garbage"))
        );
        assert_eq!(ClientKind::decode(None).platform, UNKNOWN);
    }

    #[test]
    fn devices_and_distinct_users_are_counted_by_platform_and_version() {
        let census = aggregate(
            &[
                device("alice", "android", "1.5.4"),
                device("alice", "web", "1.5.4"),
                device("bob", "android", "1.5.4"),
                device("bob", "android", "1.5.3"),
                device("carol", "ios", "1.5.4"),
            ],
            1,
        );
        assert_eq!(census.devices, 5);
        // alice owns two devices and bob two: three people, not five.
        assert_eq!(census.users, 3);
        let cell = |p: &str, v: &str| {
            census
                .groups
                .iter()
                .find(|g| g.platform == p && g.version == v)
                .map(|g| (g.devices, g.users))
        };
        assert_eq!(cell("android", "1.5.4"), Some((2, 2)));
        assert_eq!(cell("android", "1.5.3"), Some((1, 1)));
        assert_eq!(cell("web", "1.5.4"), Some((1, 1)));
        assert_eq!(cell("ios", "1.5.4"), Some((1, 1)));
        assert_eq!(census.groups.len(), 4);
    }

    #[test]
    fn an_empty_population_is_an_empty_census() {
        assert_eq!(
            aggregate(&[], 1),
            Census {
                devices: 0,
                users: 0,
                groups: vec![]
            }
        );
    }

    #[test]
    fn the_rarest_versions_beyond_the_cap_merge_into_other() {
        let mut devices = Vec::new();
        for i in 0..(MAX_VERSIONS_PER_SAMPLE + 5) {
            devices.push(device(&format!("u{i}"), "web", &format!("1.0.{i}")));
        }
        let census = aggregate(&devices, 1);
        let versions: HashSet<&str> = census.groups.iter().map(|g| g.version.as_str()).collect();
        assert_eq!(versions.len(), MAX_VERSIONS_PER_SAMPLE + 1);
        assert!(versions.contains(OTHER));
        assert_eq!(census.devices, (MAX_VERSIONS_PER_SAMPLE + 5) as u64);
    }

    #[test]
    fn a_census_names_nobody() {
        // THE PRIVACY PIN: whatever the population's ids are, no serialised sample contains one.
        let census = aggregate(
            &[
                device("user-id-aaaa", "web", "1.5.4"),
                device("user-id-bbbb", "android", "1.5.4"),
            ],
            HISTORY_MIN_CELL,
        );
        let json = serde_json::to_string(&Sample { t: 60, census }).unwrap();
        assert!(!json.contains("user-id"));
        assert!(!json.contains("userId") && !json.contains("deviceId"));
    }

    #[test]
    fn a_sample_round_trips_through_json() {
        let sample = Sample {
            t: 120,
            census: aggregate(&[device("a", "web", "1.5.4")], 1),
        };
        let back: Sample = serde_json::from_str(&serde_json::to_string(&sample).unwrap()).unwrap();
        assert_eq!(back, sample);
    }

    fn cell_of(census: &Census, p: &str, v: &str) -> Option<(u64, u64)> {
        census
            .groups
            .iter()
            .find(|g| g.platform == p && g.version == v)
            .map(|g| (g.devices, g.users))
    }

    #[test]
    fn a_small_cell_is_merged_by_platform_first_then_by_version() {
        let mut devices = Vec::new();
        // android 1.5.4: 3 devices (kept). android 1.5.3: 1 and android 1.5.2: 1 - together 2, still
        // under 3. ios 1.5.4: 1. web 1.5.4: 3 (kept), web 1.5.3: 2 -> (web, other) = 2, under 3.
        for i in 0..3 {
            devices.push(device(&format!("a{i}"), "android", "1.5.4"));
            devices.push(device(&format!("w{i}"), "web", "1.5.4"));
        }
        devices.push(device("s1", "android", "1.5.3"));
        devices.push(device("s2", "android", "1.5.2"));
        devices.push(device("s3", "ios", "1.5.4"));
        devices.push(device("s4", "web", "1.5.3"));
        devices.push(device("s5", "web", "1.5.3"));

        let census = aggregate(&devices, HISTORY_MIN_CELL);

        // The totals never move.
        assert_eq!(census.devices, 11);
        assert_eq!(census.users, 11);
        assert_eq!(cell_of(&census, "android", "1.5.4"), Some((3, 3)));
        assert_eq!(cell_of(&census, "web", "1.5.4"), Some((3, 3)));
        // Pass 1 folded the versions of each small cell into (platform, other); pass 2 found
        // android-other (2), web-other (2) and ios-other (1) still under the minimum and dissolved
        // the platforms too.
        assert_eq!(cell_of(&census, "other", "other"), Some((5, 5)));
        assert_eq!(census.groups.len(), 3);
        // No remaining cell is under the minimum, except the last residue, which names no platform
        // and no version.
        assert!(
            census
                .groups
                .iter()
                .all(|g| g.devices >= HISTORY_MIN_CELL
                    || (g.platform == OTHER && g.version == OTHER))
        );
    }

    #[test]
    fn a_platform_cell_that_reaches_the_minimum_after_the_first_pass_keeps_its_platform() {
        let census = aggregate(
            &[
                device("a", "ios", "1.0.0"),
                device("b", "ios", "1.0.1"),
                device("c", "ios", "1.0.2"),
            ],
            HISTORY_MIN_CELL,
        );
        // Three single-device cells fold into (ios, other) = 3: the platform survives.
        assert_eq!(census.groups.len(), 1);
        assert_eq!(cell_of(&census, "ios", "other"), Some((3, 3)));
    }

    #[test]
    fn merged_cells_count_their_distinct_users_once() {
        let census = aggregate(
            &[
                device("same", "ios", "1.0.0"),
                device("same", "android", "1.0.0"),
                device("other-person", "linux", "1.0.0"),
            ],
            HISTORY_MIN_CELL,
        );
        assert_eq!(cell_of(&census, "other", "other"), Some((3, 2)));
        assert_eq!(census.users, 2);
    }

    #[test]
    fn the_live_census_keeps_every_cell() {
        let census = aggregate(&[device("a", "ios", "1.0.0")], 1);
        assert_eq!(cell_of(&census, "ios", "1.0.0"), Some((1, 1)));
    }
}

/// The series and the client key against a REAL Redis (gated like `addressing::redis_it`): the
/// idempotence per minute and the retention are properties of a script and a sorted set, which no
/// fake can judge.
#[cfg(test)]
mod redis_it {
    use super::*;

    async fn redis() -> Option<MultiplexedConnection> {
        let Ok(url) = std::env::var("GATEWAY_IT_REDIS_URL") else {
            assert!(
                std::env::var("CI").is_err(),
                "GATEWAY_IT_REDIS_URL is unset under CI - the census series would go untested"
            );
            eprintln!("GATEWAY_IT_REDIS_URL unset - the Redis half of the census is not run here");
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

    fn series() -> String {
        format!("it:monitor:{}", uuid::Uuid::new_v4())
    }

    fn census(devices: u64) -> Census {
        Census {
            devices,
            users: devices,
            groups: vec![],
        }
    }

    /// The minute the script will accept right now: Redis's own clock, floored.
    async fn this_minute(con: &mut MultiplexedConnection) -> i64 {
        let now = redis_now(con).await.unwrap();
        now - now.rem_euclid(SAMPLE_INTERVAL_SECS)
    }

    async fn plant(con: &mut MultiplexedConnection, key: &str, t: i64, devices: u64) {
        let payload = serde_json::to_string(&Sample {
            t,
            census: census(devices),
        })
        .unwrap();
        redis::cmd("ZADD")
            .arg(key)
            .arg(t)
            .arg(payload)
            .query_async::<()>(con)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn two_replicas_sampling_the_same_minute_write_it_once() {
        let Some(mut con) = redis().await else { return };
        let key = series();
        let t = this_minute(&mut con).await;
        assert_eq!(
            record_sample(&mut con, &key, t, &census(3)).await.unwrap(),
            SampleOutcome::Wrote
        );
        // The second replica finds the minute taken, and the first replica's value stands.
        assert_eq!(
            record_sample(&mut con, &key, t, &census(9)).await.unwrap(),
            SampleOutcome::Taken
        );
        assert!(minute_taken(&mut con, &key, t).await.unwrap());
        let now = redis_now(&mut con).await.unwrap();
        let got = read_series(&mut con, &key, now).await.unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].census.devices, 3);
    }

    #[tokio::test]
    async fn a_minute_nobody_sampled_is_absent_not_filled() {
        let Some(mut con) = redis().await else { return };
        let key = series();
        let t = this_minute(&mut con).await;
        plant(&mut con, &key, t - 600, 1).await;
        plant(&mut con, &key, t - 540, 1).await;
        record_sample(&mut con, &key, t, &census(1)).await.unwrap();
        let now = redis_now(&mut con).await.unwrap();
        let got = read_series(&mut con, &key, now).await.unwrap();
        assert_eq!(
            got.iter().map(|s| s.t).collect::<Vec<_>>(),
            vec![t - 600, t - 540, t]
        );
        assert!(!minute_taken(&mut con, &key, t - 60).await.unwrap());
    }

    #[tokio::test]
    async fn what_is_older_than_24_hours_is_deleted_and_the_key_expires() {
        let Some(mut con) = redis().await else { return };
        let key = series();
        let t = this_minute(&mut con).await;
        plant(&mut con, &key, t - RETENTION_SECS - 600, 1).await;
        plant(&mut con, &key, t - RETENTION_SECS + 600, 2).await;
        record_sample(&mut con, &key, t, &census(3)).await.unwrap();
        let now = redis_now(&mut con).await.unwrap();
        let got = read_series(&mut con, &key, now).await.unwrap();
        // The sample inside the window is kept; the one older than 24 h was trimmed by the write.
        assert_eq!(
            got.iter().map(|s| s.census.devices).collect::<Vec<_>>(),
            vec![2, 3]
        );
        let ttl: i64 = redis::cmd("TTL")
            .arg(&key)
            .query_async(&mut con)
            .await
            .unwrap();
        assert!(ttl > 0 && ttl <= RETENTION_SECS + 3600);
    }

    /// A replica whose clock is two hours ahead must not trim real history, must not plant a sample
    /// the read would serve, and must not take a slot from a correct replica.
    #[tokio::test]
    async fn a_write_skewed_ahead_neither_trims_nor_appears() {
        let Some(mut con) = redis().await else { return };
        let key = series();
        let t = this_minute(&mut con).await;
        // History a correct replica wrote, including a sample 23 h old that a skewed trim (relative
        // to +2 h) would wipe.
        plant(&mut con, &key, t - 23 * 3600, 5).await;
        plant(&mut con, &key, t - 60, 6).await;

        let ahead = t + 2 * 3600;
        let outcome = record_sample(&mut con, &key, ahead, &census(99))
            .await
            .unwrap();
        assert!(
            matches!(outcome, SampleOutcome::Skewed { skew } if (7100..=7260).contains(&skew)),
            "{outcome:?}"
        );
        // A replica BEHIND by two hours is refused the same way.
        let behind = record_sample(&mut con, &key, t - 2 * 3600, &census(99))
            .await
            .unwrap();
        assert!(matches!(behind, SampleOutcome::Skewed { skew } if skew < 0));

        assert!(!minute_taken(&mut con, &key, ahead).await.unwrap());
        let now = redis_now(&mut con).await.unwrap();
        let got = read_series(&mut con, &key, now).await.unwrap();
        assert_eq!(
            got.iter().map(|s| s.census.devices).collect::<Vec<_>>(),
            vec![5, 6],
            "nothing was trimmed and nothing was planted"
        );
        // And the correct replica still gets its slot.
        assert_eq!(
            record_sample(&mut con, &key, t, &census(7)).await.unwrap(),
            SampleOutcome::Wrote
        );

        // Even a future sample that DID get in (a foreign write) is never served: the read is
        // bounded to Redis's now.
        plant(&mut con, &key, now + 3600, 99).await;
        let got = read_series(&mut con, &key, now).await.unwrap();
        assert!(got.iter().all(|s| s.census.devices != 99));
    }

    #[tokio::test]
    async fn a_device_counts_once_whatever_gateway_holds_it() {
        let Some(mut con) = redis().await else { return };
        let user = format!("it-{}", uuid::Uuid::new_v4());
        let conn_key = format!("{user}:dev1");
        // Two gateway processes each refresh the SAME shared keys for the same device.
        for _replica in 0..2 {
            redis::cmd("SET")
                .arg(format!("user:online:{conn_key}"))
                .arg("sessions-1")
                .arg("EX")
                .arg(60)
                .query_async::<()>(&mut con)
                .await
                .unwrap();
            note_client(&mut con, &conn_key, &kind_for_it(), 60)
                .await
                .unwrap();
        }
        let online: Vec<_> = list_online(&mut con)
            .await
            .unwrap()
            .into_iter()
            .filter(|(u, _)| *u == user)
            .collect();
        assert_eq!(
            online.len(),
            1,
            "the device is one key, however many gateways refresh it"
        );
        let kinds = declared_kinds(&mut con, &online).await.unwrap();
        assert_eq!(kinds, vec![kind_for_it()]);
    }

    fn kind_for_it() -> ClientKind {
        ClientKind::from_query(Some("android"), Some("1.5.4"))
    }
}
