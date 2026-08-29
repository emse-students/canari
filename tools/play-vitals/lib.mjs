/**
 * Shared access to the two Google Play APIs this repo reads.
 *
 * WHY a hand-rolled JWT rather than `google-auth-library`: this is a read-only watch run from a
 * laptop and from CI, and a service-account assertion is forty lines of `node:crypto`. Adding a
 * dependency tree to sign one JWT would be the larger surface.
 *
 * The key is a SECRET and Canari is a PUBLIC repository, so it is never read from inside the work
 * tree. It lives beside the harness state at `../canari-harness/`, which `git clean -xdf` cannot
 * reach and where nothing can be committed by accident.
 */

import { createSign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

/** The Play package this repo publishes. Matches `identifier` in `tauri.conf.json`. */
export const PKG = 'fr.emse.canari';

/** Where the service-account JSON lives. `PLAY_SA_KEY` overrides it (CI has its own path). */
export const KEY_PATH =
  process.env.PLAY_SA_KEY ??
  new URL('../../../canari-harness/play-console-sa.json', import.meta.url).pathname.replace(
    /^\/(?=[A-Za-z]:)/,
    ''
  );

/** Android vitals, anomalies and error reports. */
export const REPORTING = 'https://playdeveloperreporting.googleapis.com/v1beta1';
/** Tracks, releases, reviews. */
export const PUBLISHER = 'https://androidpublisher.googleapis.com/androidpublisher/v3';

const SCOPES = [
  'https://www.googleapis.com/auth/playdeveloperreporting',
  'https://www.googleapis.com/auth/androidpublisher',
].join(' ');

const b64url = (value) =>
  Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

/** @type {{ value: string, expiresAt: number } | null} */
let cachedToken = null;

/**
 * Mint (or reuse) an OAuth access token for the service account.
 *
 * @returns {Promise<string>} a bearer token valid for at least another minute
 * @throws if the key file is missing or Google refuses the assertion
 */
export async function token() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 60) return cachedToken.value;

  if (!existsSync(KEY_PATH)) {
    throw new Error(
      `Play service-account key not found at ${KEY_PATH}. Set PLAY_SA_KEY to its location.`
    );
  }
  const key = JSON.parse(readFileSync(KEY_PATH, 'utf8'));
  const claim = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({
    iss: key.client_email,
    scope: SCOPES,
    aud: key.token_uri,
    exp: now + 3600,
    iat: now,
  })}`;
  const signature = createSign('RSA-SHA256').update(claim).end().sign(key.private_key, 'base64url');

  const response = await fetch(key.token_uri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${claim}.${signature}`,
    }),
  });
  const parsed = await response.json();
  if (!response.ok) {
    throw new Error(`token endpoint returned ${response.status}: ${JSON.stringify(parsed)}`);
  }
  cachedToken = { value: parsed.access_token, expiresAt: now + 3600 };
  return cachedToken.value;
}

/**
 * Call a Play API endpoint.
 *
 * Returns the status alongside the body rather than throwing on a non-2xx: several endpoints
 * answer 403 for a reason the caller must READ (the API disabled in the GCP project, versus the
 * service account missing a Play Console permission) and those two need different fixes.
 *
 * @param {string} url absolute endpoint URL
 * @param {RequestInit} [init] fetch options; `authorization` is supplied here
 * @returns {Promise<{ status: number, ok: boolean, body: unknown }>}
 */
export async function api(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${await token()}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { unparsed: text.slice(0, 500) };
  }
  return { status: response.status, ok: response.ok, body };
}

/**
 * The vitals metric sets this app can read, with the metric and dimension names the API actually
 * accepts. Verified 2026-08-29 by sending a deliberate bogus metric and reading the enumeration the
 * API answers with - guessing these costs a 400 per mistake.
 *
 * `slowRenderingRateMetricSet` is deliberately absent: it answers 403 "only accessible to games".
 */
export const METRIC_SETS = [
  {
    set: 'crashRateMetricSet',
    metrics: ['crashRate', 'userPerceivedCrashRate', 'distinctUsers'],
    required: [],
  },
  {
    set: 'anrRateMetricSet',
    metrics: ['anrRate', 'userPerceivedAnrRate', 'distinctUsers'],
    required: [],
  },
  {
    set: 'errorCountMetricSet',
    metrics: ['errorReportCount', 'distinctUsers'],
    required: ['reportType'],
  },
  {
    set: 'excessiveWakeupRateMetricSet',
    metrics: ['excessiveWakeupRate', 'distinctUsers'],
    required: [],
  },
  {
    set: 'stuckBackgroundWakelockRateMetricSet',
    metrics: ['stuckBgWakelockRate', 'distinctUsers'],
    required: [],
  },
  {
    set: 'slowStartRateMetricSet',
    metrics: ['slowStartRate', 'distinctUsers'],
    required: ['startType'],
  },
  { set: 'lmkRateMetricSet', metrics: ['userPerceivedLmkRate', 'distinctUsers'], required: [] },
  // The two Play measures ENFORCED from Feb 2027. Both carry P50..P99 and an `appState`
  // dimension, which is how the thresholds are phrased (foreground vs backgrounded vs cached).
  {
    set: 'anonRssAndSwapMemoryUsageMetricSet',
    metrics: ['anonRssAndSwapMemoryUsageP90', 'distinctUsers'],
    required: [],
  },
  {
    set: 'bitmapMemoryUsageMetricSet',
    metrics: ['bitmapMemoryUsageP90', 'distinctUsers'],
    required: [],
  },
];

/**
 * The latest date a metric set has data for, as a `google.type.Date`.
 *
 * Every query MUST be clamped to this: an `endTime` even one day past it is a hard 400, and the
 * freshness differs PER SET (error counts run days ahead of crash rates). `hours` is stripped
 * because DAILY aggregation rejects a start or end time that carries one.
 *
 * @param {string} set metric set id, e.g. `crashRateMetricSet`
 * @param {'DAILY'|'HOURLY'} [period]
 * @returns {Promise<{year:number,month:number,day:number,timeZone:object}|null>} null if the set
 *   reports no freshness for that period, which means it has never had data
 */
export async function freshness(set, period = 'DAILY') {
  const response = await api(`${REPORTING}/apps/${PKG}/${set}`);
  if (!response.ok) {
    console.error(`  ! freshness(${set}) -> ${response.status} ${JSON.stringify(response.body)}`);
    return null;
  }
  const entry = response.body?.freshnessInfo?.freshnesses?.find(
    (f) => f.aggregationPeriod === period
  );
  if (!entry) return null;
  const { year, month, day, timeZone } = entry.latestEndTime;
  return { year, month, day, timeZone };
}

/**
 * Shift a `google.type.Date` back by whole days, keeping its time zone.
 *
 * @param {{year:number,month:number,day:number,timeZone:object}} date
 * @param {number} days
 */
export function dayMinus(date, days) {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day));
  shifted.setUTCDate(shifted.getUTCDate() - days);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    timeZone: date.timeZone,
  };
}

/**
 * Query one vitals metric set over the `days` ending at its own freshness.
 *
 * @param {{set:string,metrics:string[],required:string[]}} spec one entry of {@link METRIC_SETS}
 * @param {number} [days] window length, ending at freshness
 * @param {string[]} [extraDimensions] added to the set's required dimensions
 * @returns {Promise<{set:string,rows:object[],end:object|null,note?:string}>} `rows` is empty both
 *   when nothing went wrong and nothing happened, and when Play withheld the data for having too
 *   few users - `note` carries that distinction where the API states it
 */
export async function queryMetricSet(spec, days = 27, extraDimensions = []) {
  const end = await freshness(spec.set);
  if (!end)
    return { set: spec.set, rows: [], end: null, note: 'no DAILY freshness - never had data' };

  const response = await api(`${REPORTING}/apps/${PKG}/${spec.set}:query`, {
    method: 'POST',
    body: JSON.stringify({
      timelineSpec: { aggregationPeriod: 'DAILY', startTime: dayMinus(end, days), endTime: end },
      metrics: spec.metrics,
      dimensions: [...spec.required, ...extraDimensions],
      pageSize: 1000,
    }),
  });
  if (!response.ok) {
    return {
      set: spec.set,
      rows: [],
      end,
      note: `HTTP ${response.status}: ${response.body?.error?.message ?? ''}`,
    };
  }
  return { set: spec.set, rows: response.body?.rows ?? [], end };
}

/**
 * Build the `interval.*` query parameters `errorIssues:search` and `errorReports:search` expect.
 *
 * These two endpoints take a `TimeInterval` of full DateTimes, NOT the `google.type.Date` the
 * metric sets take, and they reject a named time zone (`America/Los_Angeles` -> "Unsupported
 * timezone"). Leaving the zone unset means UTC, which both accept.
 *
 * @param {Date} start
 * @param {Date} end
 */
export function intervalParams(start, end) {
  const part = (prefix, d) => ({
    [`${prefix}.year`]: `${d.getUTCFullYear()}`,
    [`${prefix}.month`]: `${d.getUTCMonth() + 1}`,
    [`${prefix}.day`]: `${d.getUTCDate()}`,
    [`${prefix}.hours`]: `${d.getUTCHours()}`,
  });
  return { ...part('interval.startTime', start), ...part('interval.endTime', end) };
}

/**
 * The clustered crash/ANR issues Play saw in a window, newest data first.
 *
 * @param {Date} start
 * @param {Date} end
 * @param {number} [pageSize]
 * @returns {Promise<object[]>}
 */
export async function searchErrorIssues(start, end, pageSize = 50) {
  const params = new URLSearchParams({
    ...intervalParams(start, end),
    pageSize: `${pageSize}`,
  });
  const response = await api(`${REPORTING}/apps/${PKG}/errorIssues:search?${params}`);
  if (!response.ok) {
    console.error(`  ! errorIssues:search -> ${response.status} ${JSON.stringify(response.body)}`);
    return [];
  }
  return response.body?.errorIssues ?? [];
}

/**
 * Individual reports - the ones carrying a stack trace - for one issue.
 *
 * @param {string} issueId the bare id, as it appears at the end of an issue `name`
 * @param {Date} start
 * @param {Date} end
 * @param {number} [pageSize]
 * @returns {Promise<object[]>}
 */
export async function searchErrorReports(issueId, start, end, pageSize = 3) {
  const params = new URLSearchParams({
    ...intervalParams(start, end),
    filter: `errorIssueId = "${issueId}"`,
    pageSize: `${pageSize}`,
  });
  const response = await api(`${REPORTING}/apps/${PKG}/errorReports:search?${params}`);
  if (!response.ok) {
    console.error(`  ! errorReports:search(${issueId}) -> ${response.status}`);
    return [];
  }
  return response.body?.errorReports ?? [];
}

/**
 * What each track currently carries on Play.
 *
 * Reading tracks requires an "edit", which is Play's transaction handle; it is deleted again here
 * rather than committed, so this stays a read. An abandoned edit changes nothing and expires.
 *
 * @returns {Promise<object[]>} one entry per track
 */
export async function tracks() {
  const base = `${PUBLISHER}/applications/${PKG}`;
  const opened = await api(`${base}/edits`, { method: 'POST', body: '{}' });
  if (!opened.ok) {
    console.error(`  ! edits.insert -> ${opened.status} ${JSON.stringify(opened.body)}`);
    return [];
  }
  try {
    const listed = await api(`${base}/edits/${opened.body.id}/tracks`);
    if (!listed.ok) {
      console.error(`  ! edits.tracks -> ${listed.status}`);
      return [];
    }
    return listed.body?.tracks ?? [];
  } finally {
    await api(`${base}/edits/${opened.body.id}`, { method: 'DELETE' });
  }
}
