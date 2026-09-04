#!/usr/bin/env node
/**
 * THE DEVICE CENSUS - every device the platform knows, with its runtime, OS, app version, owner,
 * routing reach and push reachability.
 *
 *   bun devices.mjs                     the whole estate, ids redacted
 *   bun devices.mjs --unpushable        only the devices a push SHOULD reach and cannot
 *   bun devices.mjs --runtime tauri     one runtime (`tauri`, `web`, `legacy`)
 *   bun devices.mjs --os android        one OS (matches `deviceOs`, case-insensitive)
 *   bun devices.mjs --user '#c080cb'    every device of one owner, by its redacted tag
 *   bun devices.mjs --stale 30          only devices silent for 30+ days
 *   bun devices.mjs --json              one NDJSON record per device, for a runner to assert on
 *   bun devices.mjs --full              real device ids, user ids and device names - see REDACTION
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
import { psql } from './estate.mjs';

// The pure half lives next door so the CI gate can import it with no machine; see its header.
export { CENSUS_SQL, daysBetween, installTag, parseRow, runtimeOf, summarize, userTag } from './device-census.mjs';
import { CENSUS_SQL, installTag, parseRow, summarize, userTag } from './device-census.mjs';

/**
 * Whether the server has any record that this device REGISTERED, which on this schema means an
 * `auth_sessions` row and nothing else - there is no device-registry table.
 *
 * WHY THIS IS NOT `hasKeyPackage()`, AND WHY BOTH EXIST. A session is written by the OIDC callback; a
 * KeyPackage is written by `POST /api/mls/register-device`. They are two different requests, so the
 * PAIR is a diagnosis and neither half is one: session and KeyPackage means enrolled; session and NO
 * KeyPackage means the registration was REFUSED, and the server logged why. On 2026-08-28 that pair
 * separated "a wiped profile never publishes" from the truth - a 400 from the per-user device cap.
 */
export function isRegistered(deviceId) {
  return (
    psql(`SELECT count(*) FROM auth_sessions WHERE "deviceId" = '${deviceId}'`).trim() !== '0'
  );
}

/**
 * Whether this device has a published KeyPackage, which is what makes it ADDRESSABLE: the server
 * refuses to activate a membership without one (`[MEMBERSHIP_ACTIVE] REFUSED reason=no_key_package`),
 * so every HEAL row rests on this fact and not on the session.
 */
export function hasKeyPackage(deviceId) {
  return psql(`SELECT count(*) FROM key_package WHERE "deviceId" = '${deviceId}'`).trim() !== '0';
}

/**
 * The server's per-user device cap, mirrored from `apps/chat-delivery-service/src/retention.constants.ts`.
 *
 * MIRRORED AND NOT IMPORTED because this rig does not build the server, and mirrored WITH ITS WINDOW
 * because the server counts `key_package` rows created inside `RETENTION_WINDOW_MS` - a count of all
 * rows would be a different number and would refuse runs the server would have accepted.
 */
export const MAX_DEVICES_PER_USER = 15;
const RETENTION_WINDOW_DAYS = 90;

/**
 * How many devices this account currently spends against the cap above.
 *
 * WHY A PRECONDITION AND NOT A CONSEQUENCE. `register-device` answers a full account with a 400 whose
 * body never reaches a log this rig reads, and the client's only trace is
 * `[KP] Publication failed ... welcome_request deferred` - a line that says "later" about something
 * that will never happen. Every HEAL-NEW row mints a device and abandons it, so a rung of sixteen
 * rows walks into the cap by construction: on 2026-08-28 the campaign's own debris filled all fifteen
 * slots and five rows reported that a wiped profile does not publish, which was never true
 * (durable-rules.md: never learn by failing what a fact could have told you).
 */
export function enrolledDeviceCount(userId) {
  return Number(
    psql(
      `SELECT count(DISTINCT "deviceId") FROM key_package WHERE "userId" = '${userId}'` +
        ` AND "createdAt" >= now() - interval '${RETENTION_WINDOW_DAYS} days'`
    ).trim()
  );
}

/**
 * When this device was REVOKED, or null if it never was.
 *
 * WHY THIS AND NOT THE CENSUS DISAPPEARING: `revoked_device` is the row the DELETE endpoint writes on
 * purpose to record the decision, so it is the only column that is evidence for the question "was
 * this device revoked". The device leaving the census is a CONSEQUENCE - the same purge deletes its
 * KeyPackages and memberships - and a consequence cannot distinguish "the revocation landed" from
 * "the device had nothing to purge in the first place". Both are read, and they are reported
 * separately (durable-rules.md: a column is only evidence for the question it was written to answer).
 */
export function revokedAt(deviceId) {
  const at = psql(
    `SELECT COALESCE(MAX("revokedAt")::text, '') FROM revoked_device WHERE "deviceId" = '${deviceId}'`
  ).trim();
  return at === '' ? null : at;
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
