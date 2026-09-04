/**
 * THE PURE HALF OF THE DEVICE CENSUS - the SQL text, and every function that turns one of its rows
 * into a fact. No database, no `SITE`, no machine.
 *
 * IT IS SPLIT OUT FOR ONE REASON, AND IT IS THE REASON `native-residue.mjs`, `servable.mjs`,
 * `usability.mjs` and `marker.mjs` are each split out too: `devices-selftest.mjs` is in the CI gate,
 * CI runs on a fresh checkout, and `names.mjs` is gitignored because it holds real display names in
 * a PUBLIC repository. Reaching it - here through `estate.mjs`, which needs `SITE` to know WHICH
 * database to ask - makes the self-test die with `ERR_MODULE_NOT_FOUND` before it asserts anything.
 * `gate-selftest.mjs` caught exactly that on 2026-09-04 and names the fix in its own error message.
 *
 * **Deciding what a row MEANS needs no machine.** Parsing, tagging, classifying and summarising are
 * the part with the interesting mistakes in it - the push predicate alone was wrong twice, in
 * opposite directions - so they are the part that has to stay testable with nothing installed.
 * `devices.mjs` keeps everything that TALKS to the estate and re-exports these, so no runner and no
 * import line changed.
 */
import { createHash } from 'node:crypto';

/**
 * ONE QUERY, BECAUSE THE ANSWER IS A JOIN AND A JOIN IS NOT A LOOP.
 *
 * The device set is the UNION of the two tables that can name a device, never either alone:
 * `key_package` by itself misses a device still being routed to whose packages were consumed or
 * reaped, and the routing table by itself misses an enrolled device that never joined a group.
 * Reporting either subset as "every device" is precisely the failure this tool exists to prevent,
 * so it reports the union and lets the columns show which side each row came from - a device with
 * `kp=0` was never described, one with `groups=0` is described but unrouted.
 *
 * `key_package` is AGGREGATED rather than joined row-per-row. A device republishes key packages
 * throughout its life, so a straight join multiplies every device by its package count and inflates
 * the census silently - a census that over-counts is worse than none. `max()` over the descriptive
 * columns takes the latest self-report, `min(createdAt)` is when the device first appeared and
 * `max(createdAt)` when it last re-keyed, which is the closest thing to liveness that a table
 * written BY the device can offer.
 */
export const CENSUS_SQL = `
WITH dev AS (
  SELECT DISTINCT "deviceId", "userId" FROM key_package
  UNION
  SELECT DISTINCT "deviceId", "userId" FROM dm_device_group_memberships
), kp AS (
  SELECT "deviceId",
         max("deviceOs") AS os,
         max("deviceAppVersion") AS ver,
         max("deviceName") AS name,
         count(*) AS packages,
         min("createdAt") AS first_seen,
         max("createdAt") AS last_seen
  FROM key_package GROUP BY 1
), rt AS (
  SELECT "deviceId",
         count(DISTINCT "groupId") FILTER (WHERE status = 'active') AS active_groups,
         count(DISTINCT "groupId") AS all_groups
  FROM dm_device_group_memberships GROUP BY 1
), pt AS (
  SELECT "deviceId", max(platform) AS platform, max("updatedAt") AS token_seen
  FROM push_token GROUP BY 1
)
SELECT d."deviceId", d."userId",
       COALESCE(kp.os, ''), COALESCE(kp.ver, ''), COALESCE(kp.name, ''), COALESCE(kp.packages, 0),
       COALESCE(rt.active_groups, 0), COALESCE(rt.all_groups, 0),
       COALESCE(pt.platform, ''),
       COALESCE(to_char(kp.first_seen, 'YYYY-MM-DD'), ''),
       COALESCE(to_char(kp.last_seen, 'YYYY-MM-DD'), ''),
       COALESCE(to_char(pt.token_seen, 'YYYY-MM-DD'), '')
FROM dev d
LEFT JOIN kp ON kp."deviceId" = d."deviceId"
LEFT JOIN rt ON rt."deviceId" = d."deviceId"
LEFT JOIN pt ON pt."deviceId" = d."deviceId"
ORDER BY kp.last_seen DESC NULLS LAST, d."deviceId"
`
  .replace(/\s+/g, ' ')
  .trim();

/** Number of `|`-separated fields `CENSUS_SQL` returns, asserted per row so a schema drift is loud. */
const FIELD_COUNT = 12;

/** Short stable digest of a user id: groups one person's devices without naming them. */
export const userTag = (userId) => `#${createHash('sha256').update(userId).digest('hex').slice(0, 6)}`;

/**
 * The runtime that minted a device id, from its prefix.
 *
 * `legacy` IS A REAL ANSWER AND NOT A FALLBACK. Two production device ids match neither prefix
 * (`8969fe8c-...`, `7248a9eb-...`, measured 2026-08-24): they predate
 * `generateDeviceId`'s `<runtime>-<userId>-...` shape. Reading such an id as `web` because it is
 * not `tauri-` would silently assert a runtime nobody recorded, so it gets its own name - and since
 * push is expected only from a KNOWN native runtime, a `legacy` row is never counted as a defect.
 */
export function runtimeOf(deviceId) {
  if (deviceId.startsWith('tauri-')) return 'tauri';
  if (deviceId.startsWith('web-')) return 'web';
  return 'legacy';
}

/**
 * The install-identifying tail of a device id: the `<base36 timestamp>-<random>` that
 * `generateDeviceId` appends after the user id. Two installs of one account differ here and nowhere
 * else, which is exactly what the census needs to show while naming nobody.
 */
export function installTag(deviceId) {
  const parts = deviceId.split('-');
  return parts.length >= 2 ? parts.slice(-2).join('-') : deviceId;
}

/**
 * Turns one `|`-separated census row into a classified record.
 *
 * @param line one line of `psql -tA` output
 * @param today `YYYY-MM-DD`, injected rather than read from the clock so the derived `staleDays` is
 *        reproducible - the campaign's standing rule against asserting a wall clock.
 */
export function parseRow(line, today) {
  const f = line.split('|');
  if (f.length !== FIELD_COUNT) {
    throw new Error(`census: expected ${FIELD_COUNT} fields, got ${f.length} - schema drift?`);
  }
  const [
    deviceId,
    userId,
    os,
    ver,
    name,
    packages,
    activeGroups,
    allGroups,
    pushPlatform,
    firstSeen,
    lastSeen,
    tokenSeen,
  ] = f;
  const runtime = runtimeOf(deviceId);
  const mobileOs = /android|ios|ipad|iphone/i.test(os);
  const hasToken = pushPlatform !== '';
  // Push is expected only where a NATIVE runtime meets a MOBILE OS - see the predicate note in the
  // header for the two ways getting this from one column alone goes wrong.
  const pushExpected = runtime === 'tauri' && mobileOs;
  const active = Number(activeGroups);
  return {
    deviceId,
    userId,
    runtime,
    os,
    ver,
    name,
    packages: Number(packages),
    activeGroups: active,
    allGroups: Number(allGroups),
    pushPlatform,
    firstSeen,
    lastSeen,
    tokenSeen,
    mobileOs,
    hasToken,
    pushExpected,
    // ROUTED IS THE HALF THAT MAKES IT MATTER. A device in no active group is not a person missing
    // notifications, it is a row nothing will ever send to.
    routed: active > 0,
    unpushable: pushExpected && !hasToken && active > 0,
    staleDays: lastSeen ? daysBetween(lastSeen, today) : null,
  };
}

/** Whole days from `from` to `to`, both `YYYY-MM-DD`. */
export function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

/**
 * The counts that say whether the estate is healthy, over already-classified rows.
 *
 * `stranded` IS COUNTED OVER ROUTED DEVICES ONLY, and the first draft of this got it wrong: it
 * counted every owner whose mobile devices lacked a token and announced 95 people receiving no
 * notifications. Most of those hold one key package, no app version and zero groups - a first launch
 * that enrolled and never joined a conversation. Folding those in inflated the finding by an order
 * of magnitude, which is the very mistake this tool was written to stop making by hand.
 */
export function summarize(rows) {
  const expected = rows.filter((r) => r.pushExpected);
  const byUser = new Map();
  for (const r of expected.filter((r) => r.routed)) {
    const g = byUser.get(r.userId) ?? { pushable: 0, dead: 0 };
    if (r.hasToken) g.pushable++;
    else g.dead++;
    byUser.set(r.userId, g);
  }
  return {
    devices: rows.length,
    pushExpected: expected.length,
    unpushable: rows.filter((r) => r.unpushable).length,
    routedUsers: byUser.size,
    strandedUsers: [...byUser.values()].filter((g) => g.pushable === 0 && g.dead > 0).length,
    enrolledUnrouted: expected.filter((r) => !r.routed).length,
  };
}
