#!/usr/bin/env node
/**
 * THE DEVICE CENSUS - every device the platform knows, with its runtime, OS, app version, owner,
 * routing reach and push reachability.
 *
 *   node devices.mjs                     the whole estate, ids redacted
 *   node devices.mjs --unpushable        only the devices a push SHOULD reach and cannot
 *   node devices.mjs --runtime tauri     one runtime (`tauri`, `web`, `legacy`)
 *   node devices.mjs --os android        one OS (matches `deviceOs`, case-insensitive)
 *   node devices.mjs --user '#c080cb'    every device of one owner, by its redacted tag
 *   node devices.mjs --stale 30          only devices silent for 30+ days
 *   node devices.mjs --json              one NDJSON record per device, for a runner to assert on
 *   node devices.mjs --full              real device ids, user ids and device names - see REDACTION
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT A LOG RULE. `[PUSH_SEND] No push token for user=X device=Y`
 * fires once per send, forever, for every device that cannot be pushed to. That line is a fine
 * accusation and a terrible measurement: it says "this one send had nowhere to go" and can never
 * say how many devices are in that state, nor whether the number is growing. A population question
 * is answered by a `GROUP BY`, not by counting log lines - and the durable rule is explicit that a
 * predicate which named the last incident must be re-measured against the population it will
 * actually run on. This is that measurement, made cheap enough to repeat.
 *
 * WHAT IT JOINS, AND WHY NO SINGLE TABLE CAN ANSWER. Nothing on the server records what a device
 * IS in one place:
 *   - `key_package`  is published at ENROLMENT and carries `deviceOs`, `deviceAppVersion` and
 *                    `deviceName`. It is the only table that describes a device, and it has a row
 *                    for every device that ever completed enrolment.
 *   - `push_token`   carries `platform`, but ONLY for a device whose registration SUCCEEDED - so it
 *                    is absent exactly when the question "what is this thing" matters most. That is
 *                    the shape of the underlying defect, not of this tool.
 *   - `dm_device_group_memberships` says who the delivery service will ROUTE to. `status='active'`
 *                    is a live destination and anything else is not; counting rows without reading
 *                    that column measures something other than reachability.
 *
 * THE HARD-WON PART IS THE PUSH PREDICATE, WHICH TAKES BOTH DESCRIPTIVE COLUMNS. It was written
 * wrong twice before it was measured, once in each direction:
 *   - `deviceOs` ALONE says `ios` for Safari on an iPhone. Measured 2026-08-24: 73 devices are
 *     `web`+`ios` and 62 are `web`+`android`, none holding a token and none that could - a browser
 *     receives no FCM. Trusting the OS alone reports 135 phantom defects.
 *   - THE ID PREFIX ALONE says `tauri` for Android, iOS and the desktop AppImage alike
 *     (`BaseMlsService.generateDeviceId` knows only `web` and `tauri`), and the desktop build never
 *     registers a token by design - `PushNotificationService` resolves no platform from a
 *     non-mobile user agent and returns before registering.
 * So the prefix gives the RUNTIME, `deviceOs` gives the OS, and a push is expected only where a
 * native runtime meets a mobile OS. Either column alone turns a deliberate no-op into a defect or
 * hides a real one among 135 of them.
 *
 * REDACTION IS ON BY DEFAULT, AND IT IS NOT DECORATION. A device id is
 * `<runtime>-<userId>-<base36 timestamp>-<random>`: it EMBEDS the user id, so trimming the tail
 * hides nothing. `deviceName` is worse - it is whatever the phone calls itself, frequently a
 * person's name. This repository is public and campaign notes quote tool output, so the default
 * prints a short stable digest of the owner (enough to see that eight devices belong to ONE person,
 * which is usually the finding) plus the non-identifying install tail. `--full` exists for
 * operating on a named device and ITS OUTPUT MUST NEVER BE COMMITTED.
 */
import { createHash } from 'node:crypto';
import { psql } from './ssh.mjs';

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

/** Fetches and classifies the whole estate. */
export function census(today) {
  return psql(CENSUS_SQL)
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => parseRow(l, today));
}

// --- CLI -------------------------------------------------------------------------------------
// Guarded so the pure exports above can be driven by `devices-selftest.mjs` without touching prod.
const invokedDirectly =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const arg = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null);
  const full = argv.includes('--full');
  const json = argv.includes('--json');
  const unpushableOnly = argv.includes('--unpushable');
  const osFilter = arg('--os');
  const runtimeFilter = arg('--runtime');
  const userFilter = arg('--user');
  const staleFilter = arg('--stale') ? Number(arg('--stale')) : null;
  // The census date is taken ONCE and passed down, so every `staleDays` in one report shares one
  // reference instant - a per-row `new Date()` would drift across a slow query.
  const today = new Date().toISOString().slice(0, 10);

  const rows = census(today);
  const shown = rows
    .filter((r) => (unpushableOnly ? r.unpushable : true))
    .filter((r) => (osFilter ? new RegExp(osFilter, 'i').test(r.os) : true))
    .filter((r) => (runtimeFilter ? r.runtime === runtimeFilter : true))
    .filter((r) => (userFilter ? userTag(r.userId) === userFilter || r.userId === userFilter : true))
    .filter((r) => (staleFilter === null ? true : (r.staleDays ?? Infinity) >= staleFilter));

  if (json) {
    for (const r of shown) {
      console.log(
        JSON.stringify(
          full ? r : { ...r, deviceId: installTag(r.deviceId), userId: userTag(r.userId), name: '' }
        )
      );
    }
  } else {
    const cols = [
      ['user', (r) => (full ? r.userId : userTag(r.userId))],
      ['install', (r) => (full ? r.deviceId : installTag(r.deviceId))],
      ['runtime', (r) => r.runtime],
      ['os', (r) => r.os || '?'],
      ['version', (r) => r.ver || '?'],
      ...(full ? [['name', (r) => r.name || '']] : []),
      ['kp', (r) => String(r.packages)],
      [
        'groups',
        (r) =>
          r.activeGroups === r.allGroups
            ? String(r.activeGroups)
            : `${r.activeGroups}/${r.allGroups}`,
      ],
      ['push', (r) => (r.hasToken ? r.pushPlatform : r.pushExpected ? 'NONE' : '-')],
      ['first', (r) => r.firstSeen || '?'],
      ['last', (r) => r.lastSeen || '?'],
      ['idle', (r) => (r.staleDays === null ? '?' : `${r.staleDays}d`)],
    ];
    const table = [cols.map(([h]) => h), ...shown.map((r) => cols.map(([, f]) => f(r)))];
    const width = cols.map((_, i) => Math.max(...table.map((row) => row[i].length)));
    for (const [i, row] of table.entries()) {
      console.log(
        row
          .map((c, j) => c.padEnd(width[j]))
          .join('  ')
          .trimEnd()
      );
      if (i === 0) console.log(width.map((w) => '-'.repeat(w)).join('  '));
    }

    // THE SUMMARY IS THE POINT, NOT A FOOTER. The per-device table is what you read once you know
    // something is wrong; these counts are what tell you whether it is.
    const s = summarize(rows);
    console.log(
      `\n${s.devices} devices, ${s.pushExpected} native mobile, ${s.unpushable} of them routed with NO push token.`
    );
    console.log(
      `${s.routedUsers} user(s) routed to on mobile; ${s.enrolledUnrouted} native mobile devices enrolled but in no active group (never routed to, so not a reachability problem).`
    );
    console.log(
      s.strandedUsers === 0
        ? 'Every user routed to on mobile has at least one device push can reach.'
        : `${s.strandedUsers} user(s) routed to on mobile have NO pushable device at all - those people receive no notifications.`
    );
    if (full) console.log('\n--full output names real devices and people: do not commit it.');
  }
}
