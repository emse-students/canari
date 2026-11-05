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
//! - **every (platform, version) cell is kept, even a cell of one device** (owner, 2026-11-05: *"je
//!   veux chaque version, chaque plateforme"*). What bounds the series is the platform allowlist, the
//!   version grammar and [`MAX_VERSIONS_PER_SAMPLE`], never a minimum cell size. No id ever reaches a
//!   sample (`a_census_names_nobody`).
//! - a SECOND, coarser series (`monitor:presence:samples:5m`, one MAX per five minutes, 30 days)
//!   serves the 7-day and 30-day windows. See [`record_coarse`] and [`Window`].
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

/// One sample per this many seconds.
pub const SAMPLE_INTERVAL_SECS: i64 = 60;
/// How much history is kept, in seconds: 24 hours.
pub const RETENTION_SECS: i64 = 24 * 60 * 60;
/// The sorted set holding the series.
pub const SAMPLES_KEY: &str = "monitor:presence:samples";
/// The sorted set holding the coarse series (one member per [`COARSE_INTERVAL_SECS`], the MAX of
/// the minutes inside it).
pub const COARSE_KEY: &str = "monitor:presence:samples:5m";
/// One coarse bucket spans this many seconds: 5 minutes.
pub const COARSE_INTERVAL_SECS: i64 = 300;
/// How long the coarse series is kept: 30 days.
pub const COARSE_RETENTION_SECS: i64 = 30 * 24 * 60 * 60;
/// Most (platform, version) cells a stored point (a minute or a coarse bucket) keeps; the smallest beyond it fold into
/// `(other, other)`. Bounds a bucket's size (and so Redis's) whatever clients declare.
pub const MAX_GROUPS_PER_POINT: usize = 64;
/// The 30-day window is served rolled up to this many seconds (30 minutes), so no window ever
/// answers more than 2016 points.
pub const MONTH_INTERVAL_SECS: i64 = 1800;
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
/// EVERY (platform, version) cell is kept, down to a cell of one device (owner, 2026-11-05): the
/// only bound is [`MAX_VERSIONS_PER_SAMPLE`], the rarest versions beyond it merging into `other`.
///
/// The output is deterministic: groups sorted by platform, then devices descending, then version.
pub fn aggregate(devices: &[(String, ClientKind)]) -> Census {
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

    let mut groups: Vec<Group> = cells
        .into_iter()
        .map(|((platform, version), (devices, users))| Group {
            platform,
            version,
            devices,
            users: users.len() as u64,
        })
        .collect();
    sort_groups(&mut groups);
    Census {
        devices: devices.len() as u64,
        users: everyone.len() as u64,
        groups,
    }
}

/// The canonical order of a census's groups: platform, then devices descending, then version.
fn sort_groups(groups: &mut [Group]) {
    groups.sort_by(|a, b| {
        a.platform
            .cmp(&b.platform)
            .then_with(|| b.devices.cmp(&a.devices))
            .then_with(|| a.version.cmp(&b.version))
    });
}

/// Folds `other` into `into` by taking the MAXIMUM of every count, cell by cell (totals included),
/// then bounds the groups to `max_groups`. A max is idempotent and order-free, so a replica that
/// applies the same minute twice, or two minutes in any order, lands on the same bucket - and it
/// answers the question a capacity reader asks: how many were connected AT MOST in this period.
/// Cells peak at different minutes, so the cells' maxima need not add up to the total's maximum.
pub fn merge_max(into: &mut Census, other: &Census, max_groups: usize) {
    into.devices = into.devices.max(other.devices);
    into.users = into.users.max(other.users);
    let mut cells: BTreeMap<(String, String), (u64, u64)> = BTreeMap::new();
    for g in into.groups.iter().chain(other.groups.iter()) {
        let cell = cells
            .entry((g.platform.clone(), g.version.clone()))
            .or_insert((0, 0));
        cell.0 = cell.0.max(g.devices);
        cell.1 = cell.1.max(g.users);
    }
    let groups = cells
        .into_iter()
        .map(|((platform, version), (devices, users))| Group {
            platform,
            version,
            devices,
            users,
        })
        .collect();
    into.groups = bound_groups(groups, max_groups);
}

/// Keeps at most `max` cells: the largest ones stay, the rest (and any existing `(other, other)`)
/// are summed into one `(other, other)` cell - an upper bound, which is the safe side of a cap.
fn bound_groups(mut groups: Vec<Group>, max: usize) -> Vec<Group> {
    if groups.len() <= max {
        sort_groups(&mut groups);
        return groups;
    }
    let (mut residue, mut rest): (Vec<Group>, Vec<Group>) = groups
        .drain(..)
        .partition(|g| g.platform == OTHER && g.version == OTHER);
    rest.sort_by(|a, b| {
        b.devices
            .cmp(&a.devices)
            .then_with(|| a.platform.cmp(&b.platform))
            .then_with(|| a.version.cmp(&b.version))
    });
    let overflow = rest.split_off(max.saturating_sub(1).min(rest.len()));
    let mut folded = residue.pop().unwrap_or(Group {
        platform: OTHER.to_string(),
        version: OTHER.to_string(),
        devices: 0,
        users: 0,
    });
    for g in overflow {
        folded.devices += g.devices;
        folded.users += g.users;
    }
    rest.push(folded);
    sort_groups(&mut rest);
    rest
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

/// The census of everybody connected right now, on every gateway process (see [`aggregate`]): the
/// live view and the sample that will be kept are the same census.
pub async fn read_census(con: &mut MultiplexedConnection) -> redis::RedisResult<Census> {
    let online = list_online(con).await?;
    let kinds = declared_kinds(con, &online).await?;
    let population: Vec<(String, ClientKind)> = online
        .into_iter()
        .zip(kinds)
        .map(|((user, _device), kind)| (user, kind))
        .collect();
    Ok(aggregate(&population))
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

/// Every sample of the series `key` in the window `(now - window_secs, now]`, oldest first, where
/// `now` is REDIS's clock ([`redis_now`]): nothing scored in the future is ever served. A member that
/// does not parse is skipped and logged: it can only be a foreign write, and a gap is the honest
/// rendering of a minute nobody can read.
pub async fn read_series(
    con: &mut MultiplexedConnection,
    key: &str,
    now: i64,
    window_secs: i64,
) -> redis::RedisResult<Vec<Sample>> {
    let members: Vec<String> = redis::cmd("ZRANGEBYSCORE")
        .arg(key)
        .arg(format!("({}", now - window_secs))
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

/// A history window an admin may ask for. A CLOSED set, parsed from the query: anything else is
/// refused by the route, so a request can never ask for an unbounded read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Window {
    /// 24 hours at one sample per minute (the fine series).
    Day,
    /// 7 days at one point per 5 minutes (the coarse series as stored).
    Week,
    /// 30 days at one point per 30 minutes (the coarse series, rolled up by max).
    Month,
}

impl Window {
    /// Parses the `window` query value: `24h`, `7d` or `30d`; `None` for anything else.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "24h" => Some(Window::Day),
            "7d" => Some(Window::Week),
            "30d" => Some(Window::Month),
            _ => None,
        }
    }

    /// How far back the window reaches, in seconds.
    pub fn secs(self) -> i64 {
        match self {
            Window::Day => RETENTION_SECS,
            Window::Week => 7 * 24 * 60 * 60,
            Window::Month => COARSE_RETENTION_SECS,
        }
    }

    /// The spacing of the points the route answers, in seconds.
    pub fn interval_secs(self) -> i64 {
        match self {
            Window::Day => SAMPLE_INTERVAL_SECS,
            Window::Week => COARSE_INTERVAL_SECS,
            Window::Month => MONTH_INTERVAL_SECS,
        }
    }
}

/// Rolls `samples` (oldest first) up to buckets of `step` seconds, each the MAX of the samples
/// inside it ([`merge_max`]). A bucket nobody sampled has no entry: a gap stays a gap.
pub fn rollup_max(samples: Vec<Sample>, step: i64) -> Vec<Sample> {
    let mut out: BTreeMap<i64, Census> = BTreeMap::new();
    for sample in samples {
        let bucket = sample.t - sample.t.rem_euclid(step);
        match out.get_mut(&bucket) {
            Some(into) => merge_max(into, &sample.census, MAX_GROUPS_PER_POINT),
            None => {
                out.insert(bucket, sample.census);
            }
        }
    }
    out.into_iter()
        .map(|(t, census)| Sample { t, census })
        .collect()
}

/// Reads the samples of `window` as the route answers them: the fine series for a day, the coarse one
/// for a week, the coarse one rolled up for a month. `now` is Redis's clock.
pub async fn read_window(
    con: &mut MultiplexedConnection,
    fine_key: &str,
    coarse_key: &str,
    now: i64,
    window: Window,
) -> redis::RedisResult<Vec<Sample>> {
    match window {
        Window::Day => read_series(con, fine_key, now, window.secs()).await,
        Window::Week => read_series(con, coarse_key, now, window.secs()).await,
        Window::Month => {
            let coarse = read_series(con, coarse_key, now, window.secs()).await?;
            Ok(rollup_max(coarse, MONTH_INTERVAL_SECS))
        }
    }
}

/// Compare-and-swap of one coarse bucket, and the trim of the coarse series against REDIS's clock.
/// KEYS: the coarse series. ARGV: bucket score, the member this caller read ('' if none), the member
/// to write, retention. Returns 1 when written, 0 when another replica changed the bucket first (the
/// caller re-reads and merges again).
const RECORD_COARSE: &str = r"
local score = tonumber(ARGV[1])
local keep = tonumber(ARGV[4])
if not score or not keep or keep < 1 then
  return redis.error_reply('ERR census: a coarse bucket needs a score and a positive retention')
end
local current = redis.call('ZRANGEBYSCORE', KEYS[1], score, score)
local seen = ARGV[2]
if (seen == '' and #current > 0) or (seen ~= '' and current[1] ~= seen) then
  return 0
end
redis.call('ZREMRANGEBYSCORE', KEYS[1], score, score)
redis.call('ZADD', KEYS[1], score, ARGV[3])
local now = tonumber(redis.call('TIME')[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - keep)
redis.call('EXPIRE', KEYS[1], keep + 3600)
return 1
";

/// How many times [`record_coarse`] re-reads a bucket another replica changed under it.
const COARSE_CAS_ATTEMPTS: usize = 5;

/// Folds the census of minute `t` into its 5-minute bucket of the coarse series `key` (the MAX of
/// every count, see [`merge_max`]). Idempotent - applying a minute twice changes nothing - and safe
/// across replicas through a compare-and-swap, so no lock or leader exists. Returns whether the
/// bucket was written; `false` after [`COARSE_CAS_ATTEMPTS`] lost races (logged by the caller as a
/// bucket that missed one minute, never a wrong count: a max only ever under-reads by a minute).
pub async fn record_coarse(
    con: &mut MultiplexedConnection,
    key: &str,
    t: i64,
    census: &Census,
) -> redis::RedisResult<bool> {
    let bucket = t - t.rem_euclid(COARSE_INTERVAL_SECS);
    for attempt in 1..=COARSE_CAS_ATTEMPTS {
        let current: Vec<String> = redis::cmd("ZRANGEBYSCORE")
            .arg(key)
            .arg(bucket)
            .arg(bucket)
            .query_async(con)
            .await?;
        let seen = current.first().cloned().unwrap_or_default();
        let mut merged = Sample {
            t: bucket,
            census: census.clone(),
        };
        merged.census.groups = bound_groups(merged.census.groups, MAX_GROUPS_PER_POINT);
        if !seen.is_empty() {
            match serde_json::from_str::<Sample>(&seen) {
                Ok(existing) => {
                    let mut base = existing.census;
                    merge_max(&mut base, census, MAX_GROUPS_PER_POINT);
                    merged.census = base;
                }
                Err(e) => tracing::warn!(
                    "[census] an unreadable coarse member of {} is replaced by this minute: {}",
                    key,
                    e
                ),
            }
        }
        let payload = serde_json::to_string(&merged).map_err(|e| {
            redis::RedisError::from((
                redis::ErrorKind::Client,
                "coarse sample is not serialisable",
                e.to_string(),
            ))
        })?;
        let written: i64 = redis::Script::new(RECORD_COARSE)
            .key(key)
            .arg(bucket)
            .arg(seen)
            .arg(payload)
            .arg(COARSE_RETENTION_SECS)
            .invoke_async(con)
            .await?;
        if written == 1 {
            return Ok(true);
        }
        tracing::debug!(
            "[census] coarse bucket {} changed under attempt {} - merging again",
            bucket,
            attempt
        );
    }
    Ok(false)
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
    match minute_taken(&mut con, &state.census_key, bucket).await {
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
    // A skewed replica is told so BEFORE it scans: the script would refuse its minute anyway.
    match redis_now(&mut con).await {
        Ok(redis) if (bucket - redis).abs() > SAMPLE_INTERVAL_SECS => {
            tracing::warn!(
                "[census] this replica's clock is {} s {} Redis's - minute {} REFUSED before the scan",
                (bucket - redis).abs(),
                if bucket > redis { "ahead of" } else { "behind" },
                bucket
            );
            return;
        }
        Ok(_) => {}
        Err(e) => {
            tracing::warn!(
                "[census] Redis time unreadable - minute {} left as a gap: {}",
                bucket,
                e
            );
            return;
        }
    }
    let census = match read_census(&mut con).await {
        Ok(mut census) => {
            // The stored point is bounded; the live view (a single instant) is not.
            census.groups = bound_groups(census.groups, MAX_GROUPS_PER_POINT);
            census
        }
        Err(e) => {
            tracing::warn!(
                "[census] the census read failed - minute {} left as a gap: {}",
                bucket,
                e
            );
            return;
        }
    };
    match record_sample(&mut con, &state.census_key, bucket, &census).await {
        Ok(SampleOutcome::Skewed { skew }) => tracing::warn!(
            "[census] this replica's clock is {} s {} Redis's - minute {} REFUSED, nothing written",
            skew.abs(),
            if skew > 0 { "ahead of" } else { "behind" },
            bucket
        ),
        Ok(outcome) => {
            tracing::debug!(
                "[census] minute {}: {} devices, {} users ({:?})",
                bucket,
                census.devices,
                census.users,
                outcome
            );
            // Only the replica that WROTE the minute folds it into the coarse series: the others
            // found it taken and have nothing new to add.
            if outcome == SampleOutcome::Wrote {
                match record_coarse(&mut con, &state.census_coarse_key, bucket, &census).await {
                    Ok(true) => {}
                    Ok(false) => tracing::warn!(
                        "[census] coarse bucket of minute {} lost {} races - this minute is missing from the 7/30-day series",
                        bucket,
                        COARSE_CAS_ATTEMPTS
                    ),
                    Err(e) => tracing::warn!(
                        "[census] the coarse write failed - minute {} is missing from the 7/30-day series: {}",
                        bucket,
                        e
                    ),
                }
            }
        }
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
        let census = aggregate(&[
            device("alice", "android", "1.5.4"),
            device("alice", "web", "1.5.4"),
            device("bob", "android", "1.5.4"),
            device("bob", "android", "1.5.3"),
            device("carol", "ios", "1.5.4"),
        ]);
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
            aggregate(&[]),
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
        let census = aggregate(&devices);
        let versions: HashSet<&str> = census.groups.iter().map(|g| g.version.as_str()).collect();
        assert_eq!(versions.len(), MAX_VERSIONS_PER_SAMPLE + 1);
        assert!(versions.contains(OTHER));
        assert_eq!(census.devices, (MAX_VERSIONS_PER_SAMPLE + 5) as u64);
    }

    #[test]
    fn a_census_names_nobody() {
        // THE PRIVACY PIN: whatever the population's ids are, no serialised sample contains one.
        let census = aggregate(&[
            device("user-id-aaaa", "web", "1.5.4"),
            device("user-id-bbbb", "android", "1.5.4"),
        ]);
        let json = serde_json::to_string(&Sample { t: 60, census }).unwrap();
        assert!(!json.contains("user-id"));
        assert!(!json.contains("userId") && !json.contains("deviceId"));
    }

    #[test]
    fn a_sample_round_trips_through_json() {
        let sample = Sample {
            t: 120,
            census: aggregate(&[device("a", "web", "1.5.4")]),
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
    fn a_cell_of_one_person_is_kept_whole() {
        // Owner, 2026-11-05: every (platform, version) gets its own series, even for one person.
        let census = aggregate(&[
            device("solo", "ios", "1.0.0"),
            device("a", "android", "1.0.0"),
            device("b", "android", "1.0.1"),
        ]);
        assert_eq!(cell_of(&census, "ios", "1.0.0"), Some((1, 1)));
        assert_eq!(cell_of(&census, "android", "1.0.0"), Some((1, 1)));
        assert_eq!(cell_of(&census, "android", "1.0.1"), Some((1, 1)));
        assert_eq!(cell_of(&census, OTHER, OTHER), None);
        assert_eq!(census.groups.len(), 3);
    }

    fn census_of(devices: u64, users: u64, cells: &[(&str, &str, u64)]) -> Census {
        Census {
            devices,
            users,
            groups: cells
                .iter()
                .map(|(p, v, n)| Group {
                    platform: p.to_string(),
                    version: v.to_string(),
                    devices: *n,
                    users: *n,
                })
                .collect(),
        }
    }

    #[test]
    fn merge_max_takes_the_peak_of_every_cell_and_is_idempotent() {
        let mut bucket = census_of(3, 3, &[("web", "1.0.0", 2), ("ios", "1.0.0", 1)]);
        let later = census_of(2, 2, &[("web", "1.0.0", 1), ("android", "1.0.0", 1)]);
        merge_max(&mut bucket, &later, 64);
        assert_eq!(bucket.devices, 3);
        assert_eq!(cell_of(&bucket, "web", "1.0.0"), Some((2, 2)));
        assert_eq!(cell_of(&bucket, "ios", "1.0.0"), Some((1, 1)));
        assert_eq!(cell_of(&bucket, "android", "1.0.0"), Some((1, 1)));
        let once = bucket.clone();
        merge_max(&mut bucket, &later, 64);
        assert_eq!(bucket, once, "applying a minute twice changes nothing");
    }

    #[test]
    fn a_bucket_beyond_the_group_cap_folds_its_smallest_cells_into_other() {
        let cells: Vec<(String, u64)> = (0..10).map(|i| (format!("1.0.{i}"), 10 - i)).collect();
        let census = census_of(
            55,
            55,
            &cells
                .iter()
                .map(|(v, n)| ("web", v.as_str(), *n))
                .collect::<Vec<_>>(),
        );
        let bounded = bound_groups(census.groups, 4);
        assert_eq!(bounded.len(), 4);
        // The three biggest stay; the seven others (7+6+..+1 = 28) are summed.
        assert_eq!(
            cell_of(
                &Census {
                    devices: 0,
                    users: 0,
                    groups: bounded.clone()
                },
                OTHER,
                OTHER
            ),
            Some((28, 28))
        );
        assert!(bounded.iter().any(|g| g.version == "1.0.0"));
    }

    #[test]
    fn a_window_is_a_closed_set() {
        assert_eq!(Window::parse("24h"), Some(Window::Day));
        assert_eq!(Window::parse("7d"), Some(Window::Week));
        assert_eq!(Window::parse("30d"), Some(Window::Month));
        for bad in ["", "1y", "9999d", "-1", "24H", "30d "] {
            assert_eq!(Window::parse(bad), None, "{bad:?}");
        }
        // No window ever answers more than 2016 points.
        for w in [Window::Day, Window::Week, Window::Month] {
            assert!(w.secs() / w.interval_secs() <= 2016);
        }
    }

    #[test]
    fn a_rollup_takes_the_max_and_leaves_a_gap_empty() {
        let sample = |t: i64, n: u64| Sample {
            t,
            census: census_of(n, n, &[("web", "1.0.0", n)]),
        };
        let rolled = rollup_max(
            vec![
                sample(0, 1),
                sample(300, 4),
                sample(600, 2),
                // 3600 is a different half hour: the half hours between hold nothing.
                sample(3600, 7),
            ],
            1800,
        );
        assert_eq!(
            rolled
                .iter()
                .map(|s| (s.t, s.census.devices))
                .collect::<Vec<_>>(),
            vec![(0, 4), (3600, 7)]
        );
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
        let got = read_series(&mut con, &key, now, RETENTION_SECS)
            .await
            .unwrap();
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
        let got = read_series(&mut con, &key, now, RETENTION_SECS)
            .await
            .unwrap();
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
        let got = read_series(&mut con, &key, now, RETENTION_SECS)
            .await
            .unwrap();
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
        let got = read_series(&mut con, &key, now, RETENTION_SECS)
            .await
            .unwrap();
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
        let got = read_series(&mut con, &key, now, RETENTION_SECS)
            .await
            .unwrap();
        assert!(got.iter().all(|s| s.census.devices != 99));
    }

    fn with_cells(devices: u64, cells: &[(&str, &str, u64)]) -> Census {
        Census {
            devices,
            users: devices,
            groups: cells
                .iter()
                .map(|(p, v, n)| Group {
                    platform: p.to_string(),
                    version: v.to_string(),
                    devices: *n,
                    users: *n,
                })
                .collect(),
        }
    }

    #[tokio::test]
    async fn the_coarse_bucket_keeps_the_peak_of_its_minutes_and_replays_are_harmless() {
        let Some(mut con) = redis().await else { return };
        let key = series();
        let t = this_minute(&mut con).await;
        let bucket = t - t.rem_euclid(COARSE_INTERVAL_SECS);
        let low = with_cells(2, &[("web", "1.0.0", 2)]);
        let high = with_cells(5, &[("web", "1.0.0", 3), ("ios", "1.0.0", 2)]);
        assert!(record_coarse(&mut con, &key, bucket, &high).await.unwrap());
        // A later, quieter minute of the same bucket, applied twice (two replicas, a replay).
        for _ in 0..2 {
            assert!(
                record_coarse(&mut con, &key, bucket + 60, &low)
                    .await
                    .unwrap()
            );
        }
        let now = redis_now(&mut con).await.unwrap();
        let got = read_series(&mut con, &key, now + 1, COARSE_RETENTION_SECS)
            .await
            .unwrap();
        assert_eq!(got.len(), 1, "one member per 5 minutes");
        assert_eq!(got[0].t, bucket);
        assert_eq!(got[0].census.devices, 5);
        assert_eq!(cell_of_census(&got[0].census, "web", "1.0.0"), Some(3));
        assert_eq!(cell_of_census(&got[0].census, "ios", "1.0.0"), Some(2));
        let ttl: i64 = redis::cmd("TTL")
            .arg(&key)
            .query_async(&mut con)
            .await
            .unwrap();
        assert!(ttl > 0 && ttl <= COARSE_RETENTION_SECS + 3600);
    }

    fn cell_of_census(census: &Census, p: &str, v: &str) -> Option<u64> {
        census
            .groups
            .iter()
            .find(|g| g.platform == p && g.version == v)
            .map(|g| g.devices)
    }

    #[tokio::test]
    async fn the_coarse_series_trims_what_is_older_than_30_days() {
        let Some(mut con) = redis().await else { return };
        let key = series();
        let t = this_minute(&mut con).await;
        let old = t - COARSE_RETENTION_SECS - 3600;
        let old = old - old.rem_euclid(COARSE_INTERVAL_SECS);
        plant(&mut con, &key, old, 9).await;
        assert!(record_coarse(&mut con, &key, t, &census(1)).await.unwrap());
        let members: i64 = redis::cmd("ZCARD")
            .arg(&key)
            .query_async(&mut con)
            .await
            .unwrap();
        assert_eq!(members, 1, "the 30-day-old bucket was trimmed by the write");
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
