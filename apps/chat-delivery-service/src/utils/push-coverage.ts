import type { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { activeRevocationCutoff } from './revocation';

/**
 * PUSH COVERAGE - whether a phone that RAN holds the push registration it needs, asked per build.
 *
 * THE QUESTION THE ROW ANSWERS, AND THE ONE IT DOES NOT. A `push_token` row says "this device
 * registered once and nothing deleted it since" - a sticky fact, so counting rows per build compares
 * a build's devices with their own past: on production, 2026-11-15, every one of 209 devices on a
 * build older than `1.6.12` held a row and 25 of 65 on `1.6.12` held none, and the old builds' zero
 * proved only that their rows were written before. The question here is "did this build register
 * after it ran", and the evidence written for it is `key_package.createdAt`: `register-device` resets
 * it at every unlock and every key-package renewal, and the push registration follows it within the
 * four-minute ladder (`PushNotificationService.ts`). A native device whose key package is older than
 * {@link PUSH_REGISTRATION_GRACE_MS} and younger than {@link PUSH_COVERAGE_WINDOW_MS}, with a live
 * session and no row, ran and did not register.
 *
 * Two readers, one population: the daily count ({@link reportPushCoverage}) and the per-device line
 * `register-device` prints ({@link pushPresenceLine}), which carries what the device says its last
 * registration came to - the evidence separating a client that never sent one from a row the server
 * deleted after it.
 */

/** How long after `register-device` the registration may still be running: the ladder, rounded up. */
export const PUSH_REGISTRATION_GRACE_MS = 10 * 60 * 1000;

/** How far back a launch counts: one day, the window the incident was measured over. */
export const PUSH_COVERAGE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The platforms a push registration exists on - the server's `PushPlatform`. */
const PUSH_PLATFORMS = ['android', 'ios'] as const;

/**
 * The device-id prefix of an INSTALLED app (`BaseMlsService.platform`: `tauri` for the app, `web` for
 * a browser). A mobile browser reports `android` or `ios` as its OS and can never hold a push token,
 * so the OS alone is not the population a push registration is owed by (2026-11-21: about 93 `web-`
 * devices made the daily alarm mostly false).
 */
export const INSTALLED_APP_DEVICE_PREFIX = 'tauri-';

/** Whether `deviceId` names an installed app - the one test, shared by the SQL and the line. */
export function isInstalledAppDevice(deviceId: string | undefined): boolean {
  return typeof deviceId === 'string' && deviceId.startsWith(INSTALLED_APP_DEVICE_PREFIX);
}

/**
 * The notification states meaning "registered, but the OS will not show it" - see
 * {@link parseNotificationState}.
 */
export const NOTIFICATION_OFF_STATES = ['off', 'not-asked', 'channel-off', 'alerts-off'] as const;

/**
 * Per (platform, build): the native devices that ran inside the window, how many hold no row while
 * their registration did not reach the server (`withoutPush`), and how many hold none because the OS
 * gave them no push token (`noOsToken`: the last outcome they stated, migration 052). The second is
 * a KNOWN state - no Play services, an APNs failure - accused once per process by
 * `[PUSH_UNAVAILABLE]` and not curable by registering again, so it is counted and never accused here.
 * `permissionOff`: devices that DO hold a row but state the OS will not show a notification
 * (`notificationState`, migration 054) - registered and still silent, the case the row cannot show.
 * Only INSTALLED-app devices are counted ({@link INSTALLED_APP_DEVICE_PREFIX}).
 * `$1` window start, `$2` grace cutoff, `$3` ban cutoff, `$4` now (the session liveness instant).
 * `outcomes`: the last outcome each `withoutPush` device stated (`unstated` for a build before the
 * field), so the WARN carries the evidence separating the branches and a reading needs no log access.
 * `auth_sessions."deviceId"` has no index; a daily report does not add one.
 */
export const PUSH_COVERAGE_SQL = `
WITH launched AS (
  SELECT k."userId", k."deviceId", k."deviceOs" AS "os",
         COALESCE(k."deviceAppVersion", 'unstated') AS "build",
         (k."pushOutcome" IS NOT DISTINCT FROM 'no-token') AS "noOsToken",
         COALESCE(k."pushOutcome", 'unstated') AS "outcome",
         COALESCE(k."notificationState" IN (${NOTIFICATION_OFF_STATES.map((p) => `'${p}'`).join(', ')}), false) AS "permissionOff"
    FROM key_package k
   WHERE k."deviceOs" IN (${PUSH_PLATFORMS.map((p) => `'${p}'`).join(', ')})
     AND k."deviceId" LIKE '${INSTALLED_APP_DEVICE_PREFIX}%'
     AND k."createdAt" > $1
     AND k."createdAt" <= $2
     AND NOT EXISTS (SELECT 1 FROM revoked_device r
                      WHERE r."userId" = k."userId" AND r."deviceId" = k."deviceId"
                        AND r."revokedAt" > $3)
     AND EXISTS (SELECT 1 FROM auth_sessions s
                  WHERE s."deviceId" = k."deviceId" AND s."userId" = k."userId"
                    AND s."expiresAt" > $4)
), unheld AS (
  SELECT l.*, NOT EXISTS (SELECT 1 FROM push_token t
                           WHERE t."userId" = l."userId" AND t."deviceId" = l."deviceId") AS "noRow"
    FROM launched l
)
SELECT u."os", u."build", count(*)::int AS "devices",
       count(*) FILTER (WHERE u."noRow" AND NOT u."noOsToken")::int AS "withoutPush",
       count(*) FILTER (WHERE u."noRow" AND u."noOsToken")::int AS "noOsToken",
       count(*) FILTER (WHERE NOT u."noRow" AND u."permissionOff")::int AS "permissionOff",
       array_agg(u."outcome" ORDER BY u."outcome")
         FILTER (WHERE u."noRow" AND NOT u."noOsToken") AS "outcomes"
  FROM unheld u
 GROUP BY u."os", u."build"
 ORDER BY u."os", u."build"`;

/**
 * INFORMATION, NEVER AN ALARM: the members whose only devices that ran in the window are mobile
 * browsers - they cannot be pushed by design, and no install prompt exists to change that. Same
 * liveness and ban rules as {@link PUSH_COVERAGE_SQL}; `$1` window start, `$2` ban cutoff,
 * `$3` now. A member who also holds ANY installed-app device is not counted.
 */
export const PUSH_BROWSER_ONLY_SQL = `
SELECT count(DISTINCT k."userId")::int AS "members"
  FROM key_package k
 WHERE k."deviceOs" IN (${PUSH_PLATFORMS.map((p) => `'${p}'`).join(', ')})
   AND k."deviceId" NOT LIKE '${INSTALLED_APP_DEVICE_PREFIX}%'
   AND k."createdAt" > $1
   AND NOT EXISTS (SELECT 1 FROM revoked_device r
                    WHERE r."userId" = k."userId" AND r."deviceId" = k."deviceId"
                      AND r."revokedAt" > $2)
   AND EXISTS (SELECT 1 FROM auth_sessions s
                WHERE s."deviceId" = k."deviceId" AND s."userId" = k."userId"
                  AND s."expiresAt" > $3)
   AND NOT EXISTS (SELECT 1 FROM key_package a
                    WHERE a."userId" = k."userId"
                      AND a."deviceId" LIKE '${INSTALLED_APP_DEVICE_PREFIX}%')`;

/** One (platform, build) row of the count. */
export interface PushCoverageRow {
  os: string;
  build: string;
  devices: number;
  withoutPush: number;
  noOsToken: number;
  /** Devices HOLDING a push row whose OS will not show the notification (migration 054). */
  permissionOff: number;
  /** The last stated outcome of each `withoutPush` device; null when there is none. */
  outcomes?: string[] | null;
}

/** `a=2 b=1` - how many of `outcomes` stated each term, most first, then by name. */
function tallyOutcomes(outcomes: readonly string[] | null | undefined): string {
  const counts = new Map<string, number>();
  for (const o of outcomes ?? []) counts.set(o, (counts.get(o) ?? 0) + 1);
  return [...counts]
    .sort(([a, n], [b, m]) => m - n || a.localeCompare(b))
    .map(([o, n]) => `${o}=${n}`)
    .join(' ');
}

/** The parameters of {@link PUSH_COVERAGE_SQL}, in order. */
export function pushCoverageParams(now: number = Date.now()): [Date, Date, Date, Date] {
  return [
    new Date(now - PUSH_COVERAGE_WINDOW_MS),
    new Date(now - PUSH_REGISTRATION_GRACE_MS),
    activeRevocationCutoff(now),
    new Date(now),
  ];
}

/** The parameters of {@link PUSH_BROWSER_ONLY_SQL}, in order. */
export function pushBrowserOnlyParams(now: number = Date.now()): [Date, Date, Date] {
  return [new Date(now - PUSH_COVERAGE_WINDOW_MS), activeRevocationCutoff(now), new Date(now)];
}

/**
 * The daily count: ONE plain line for the whole fleet, then one WARN per (platform, build) whose
 * devices ran and did not register. Zero is the steady state - every older build read 0 on
 * 2026-11-15 by this very predicate - so any other number is a device whose notifications are lost,
 * named by the build that lost them. Read-only; every replica prints its own.
 */
export async function reportPushCoverage(
  db: Pick<DataSource, 'query'>,
  logger: Pick<Logger, 'log' | 'warn'>,
  now: number = Date.now()
): Promise<PushCoverageRow[]> {
  const rows = ((await db.query(PUSH_COVERAGE_SQL, pushCoverageParams(now))) ??
    []) as PushCoverageRow[];
  const devices = rows.reduce((n, r) => n + r.devices, 0);
  const without = rows.reduce((n, r) => n + r.withoutPush, 0);
  const noOsToken = rows.reduce((n, r) => n + r.noOsToken, 0);
  const permissionOff = rows.reduce((n, r) => n + (r.permissionOff ?? 0), 0);
  logger.log(
    `[PUSH_COVERAGE] installed-app devices that ran in 24 h: ${devices}, holding no push ` +
      `registration ${PUSH_REGISTRATION_GRACE_MS / 60_000} min after: ${without}, given no push ` +
      `token by their OS (known, [PUSH_UNAVAILABLE]): ${noOsToken}, registered but the OS will ` +
      `not show a notification ([PUSH_PERMISSION_OFF]): ${permissionOff}`
  );
  const browser = ((await db.query(PUSH_BROWSER_ONLY_SQL, pushBrowserOnlyParams(now))) ??
    []) as Array<{ members: number }>;
  logger.log(
    `[PUSH_COVERAGE] members reachable only through a mobile browser in 24 h (information, no ` +
      `push by design): ${browser[0]?.members ?? 0}`
  );
  for (const r of rows) {
    if ((r.permissionOff ?? 0) > 0) {
      logger.warn(
        `[PUSH_PERMISSION_OFF] os=${r.os} build=${r.build} off=${r.permissionOff}/${r.devices} - ` +
          `these devices hold a push registration and state that the OS will not show it: the ` +
          `server delivers and the phone stays silent (permission, app switch or channel)`
      );
    }
    if (r.withoutPush === 0) continue;
    logger.warn(
      `[PUSH_COVERAGE] os=${r.os} build=${r.build} without=${r.withoutPush}/${r.devices} ` +
        `last: ${tallyOutcomes(r.outcomes) || 'unread'} - ` +
        `these devices ran and the server holds no push registration for them: every notification ` +
        `to them is lost (last = what each stated on its last register-device, [PUSH_MISSING])`
    );
  }
  return rows;
}

/**
 * What a device may state as its last registration outcome (`pushOutcome` on `register-device`) -
 * the client's `PushOutcomeRecord`, plus `none` (never started since its sign-out) and `unreadable`.
 * An ALLOWLIST: anything else prints `invalid`, so a client cannot write the line it likes; absent -
 * every build before the field - prints `unstated`.
 */
const PUSH_OUTCOMES: ReadonlySet<string> = new Set([
  'registered',
  'no-token',
  'rejected',
  'secret-not-stored',
  'refused',
  'unauthorized',
  'deferred',
  'no-user',
  'started',
  'in-progress',
  'none',
  'unreadable',
]);

/**
 * The terms an outcome may QUALIFY, and the qualifiers each accepts - an allowlist too. The client
 * names which `unauthorized` branch ended its ladder, and the await a running (`in-progress`) or
 * dead (`started`) registration was parked on: the 2026-11-17 reading found the tokenless `1.6.12`
 * phones had sent no registration and no report, and the bare terms could not say which branch or
 * which await to fix (the client's `UnauthorizedCause` and `RegistrationStage`).
 */
const REGISTRATION_STAGES = ['permission', 'os-token', 'session-token', 'sending'];
const OUTCOME_QUALIFIERS: Readonly<Record<string, ReadonlySet<string>>> = {
  unauthorized: new Set([
    'renewed-refused',
    'session-expired',
    'device-revoked',
    'signing-out',
    'identity-split',
    'other',
  ]),
  'in-progress': new Set(REGISTRATION_STAGES),
  started: new Set(REGISTRATION_STAGES),
};

/** The outcomes with no row that are expected, and what each means - see {@link pushPresenceLine}. */
const EXPECTED_WITHOUT_ROW: Readonly<Record<string, string>> = {
  none: 'first registration of this sign-in, owed now',
  'in-progress': 'the registration of this process is still running',
  'no-token': 'the OS gives this phone no push token (accused by [PUSH_UNAVAILABLE])',
};

/** The stated outcome, normalised by {@link PUSH_OUTCOMES}. */
export function parsePushOutcome(raw: unknown): string {
  if (raw === undefined || raw === null || raw === '') return 'unstated';
  if (typeof raw !== 'string') return 'invalid';
  if (PUSH_OUTCOMES.has(raw)) return raw;
  const [term, qualifier, ...rest] = raw.split(':');
  return rest.length === 0 &&
    qualifier !== undefined &&
    Object.prototype.hasOwnProperty.call(OUTCOME_QUALIFIERS, term) &&
    OUTCOME_QUALIFIERS[term].has(qualifier)
    ? raw
    : 'invalid';
}

/** The unqualified term of a parsed outcome: `in-progress:permission` is an `in-progress`. */
function outcomeTerm(outcome: string): string {
  return outcome.split(':')[0];
}

/**
 * The line `register-device` prints about the device's push registration, or null when there is
 * nothing to say (the row is held, or the device is not a phone).
 *
 * Said at `log`, never accused - the three EXPECTED states:
 * - `none`: nothing since the sign-in; the registration follows this very call;
 * - `in-progress`: this process's ladder is running (an Android permission rationale still open, a
 *   token still coming) - the login starts it before the first `register-device`;
 * - `no-token`: the OS gave this phone no push token, a known state accused once per process by
 *   `[PUSH_UNAVAILABLE]`, which registering again cannot cure.
 *
 * Every other outcome with no row is a phone that ran and holds nothing, at WARN: `registered`
 * accuses a row the SERVER lost after the client wrote it, any failure (and `started`, a previous
 * process that died inside its ladder) the CLIENT's last attempt - opposite causes, which is why the
 * line names the term.
 */
export function pushPresenceLine(args: {
  userId: string;
  deviceId: string;
  deviceOs: string | undefined;
  build: string | undefined;
  held: boolean;
  outcome: string;
}): { level: 'log' | 'warn'; line: string } | null {
  if (args.held) return null;
  if (!PUSH_PLATFORMS.includes(args.deviceOs as (typeof PUSH_PLATFORMS)[number])) return null;
  // A browser reports android or ios and can never hold a push token: not a missing registration.
  if (!isInstalledAppDevice(args.deviceId)) return null;
  const line =
    `[PUSH_MISSING] user=${args.userId} device=${args.deviceId} os=${args.deviceOs} ` +
    `build=${args.build ?? 'unstated'} last=${args.outcome}`;
  const expected = EXPECTED_WITHOUT_ROW[outcomeTerm(args.outcome)];
  if (expected) return { level: 'log', line: `${line} - ${expected}` };
  return {
    level: 'warn',
    line:
      `${line} - ` +
      (args.outcome === 'registered'
        ? 'the device registered and the row is gone: a server-side deletion'
        : 'the device ran and its registration did not reach the server'),
  };
}

/** What the OS says about the app's notification permission - the client's `NotificationPermission`. */
const NOTIFICATION_PERMISSIONS: ReadonlySet<string> = new Set([
  'granted',
  'denied',
  'not-determined',
  'provisional',
  'ephemeral',
]);

/** An Android channel's importance, by name - `absent` is a channel the OS does not hold. */
const CHANNEL_IMPORTANCES: ReadonlySet<string> = new Set([
  'none',
  'min',
  'low',
  'default',
  'high',
  'unspecified',
  'absent',
]);

/** The channels a device may state, in the order they are stored - an allowlist. */
const NOTIFICATION_CHANNELS = ['messages', 'posts'] as const;

/** The normalised notification state of one `register-device`. */
export interface ParsedNotificationState {
  /**
   * `on`, one of {@link NOTIFICATION_OFF_STATES}, `unknown` (nothing stated, or not enough to say)
   * or `invalid` (stated, and not in the allowlist). The last two are stored as NULL: an old client
   * says nothing, and nothing is never read as "granted".
   */
  state: 'on' | (typeof NOTIFICATION_OFF_STATES)[number] | 'unknown' | 'invalid';
  /** `messages=high posts=default`, or null when no channel was stated. */
  channels: string | null;
}

/**
 * Normalises what the client read from the OS (`notificationState` on `register-device`):
 * `{ permission, enabled, alerts?, channels? }`. An ALLOWLIST, like {@link parsePushOutcome}: a
 * client cannot write a value it likes, anything unreadable is `invalid`, absent is `unknown`.
 *
 * The category, most specific cause first: permission `not-determined` is `not-asked`, `denied` or
 * `enabled === false` is `off`, a stated channel at importance `none` is `channel-off`, iOS
 * `alerts === false` is `alerts-off`, else `on`. A permitted device needs a stated boolean `enabled`
 * to be `on` - a missing one is `unknown`, never assumed.
 */
export function parseNotificationState(raw: unknown): ParsedNotificationState {
  const invalid: ParsedNotificationState = { state: 'invalid', channels: null };
  if (raw === undefined || raw === null) return { state: 'unknown', channels: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return invalid;
  const o = raw as Record<string, unknown>;
  if (typeof o.permission !== 'string' || !NOTIFICATION_PERMISSIONS.has(o.permission)) {
    return invalid;
  }
  if (o.enabled !== undefined && typeof o.enabled !== 'boolean') return invalid;
  if (o.alerts !== undefined && typeof o.alerts !== 'boolean') return invalid;
  const stated: string[] = [];
  const importances: string[] = [];
  if (o.channels !== undefined) {
    if (typeof o.channels !== 'object' || o.channels === null || Array.isArray(o.channels)) {
      return invalid;
    }
    const c = o.channels as Record<string, unknown>;
    for (const name of NOTIFICATION_CHANNELS) {
      const v = c[name];
      if (v === undefined) continue;
      if (typeof v !== 'string' || !CHANNEL_IMPORTANCES.has(v)) return invalid;
      stated.push(`${name}=${v}`);
      importances.push(v);
    }
  }
  const channels = stated.length > 0 ? stated.join(' ') : null;
  if (o.permission === 'not-determined') return { state: 'not-asked', channels };
  if (o.permission === 'denied' || o.enabled === false) return { state: 'off', channels };
  if (o.enabled !== true) return { state: 'unknown', channels };
  if (importances.includes('none')) return { state: 'channel-off', channels };
  if (o.alerts === false) return { state: 'alerts-off', channels };
  return { state: 'on', channels };
}
