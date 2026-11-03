/**
 * What a Play crash/ANR cluster MEANS against what this repo already decided about it.
 *
 * Pure functions, no network: `vitals.mjs` fetches, this judges, `classify.test.mjs` proves every
 * verdict on fixtures. Two kinds of record live in `known-issues.json`:
 *
 * - FIXED (no `kind`, the original format): the commit that fixed it and the first versionCode
 *   carrying the fix. Seen at or above that code, it is a REGRESSION.
 * - PLATFORM: a defect in Android or the WebView with no Canari frame, which no change here can fix.
 *   It is NOT a mute: it stays PLATFORM only while the evidence that made it so still holds, and
 *   RE-OPENS - reported as NEW, with the reasons - the moment any of three rules trips
 *   ({@link judgePlatform}). Why the kind exists: tools/play-vitals/README.md#platform-issues.
 */

import { PKG } from './lib.mjs';

/**
 * A backtrace frame line in a Play report: a native `#NN ...` frame (an ANR prefixes it with
 * `native: ` and may omit `pc`) or a Java `at ...` frame.
 * Header lines (`pid: 0, tid: N >>> fr.emse.canari <<<`, thread titles) are NOT frames - every
 * report names the package in its header, so reading the header would find "our" frame in all of
 * them.
 */
const FRAME = /^\s*(?:native:\s+)?#\d+\s|^\s*at\s/;

/**
 * What makes a frame OURS: the app's package (Java frames, and every native frame from the APK,
 * whose path is `/data/app/.../fr.emse.canari-.../split_config.*.apk`), or a symbol of the Rust and
 * Kotlin layers the app ships (wry, tao, tauri, the app library `mines_app_lib`).
 */
const OUR_FRAME = new RegExp(
  `${PKG.replaceAll('.', '\\.')}|\\bwry\\b|\\btao::|\\btauri|mines_app_lib`,
  'i'
);

/** A WebView / Chrome major named anywhere in a report: `Chrome/141.`, `WebView/141.`. */
const WEBVIEW_MAJOR = /\b(?:Chrome|WebView)\/(\d+)\./g;

/** @param {string} text a report body @returns {string[]} its frame lines that are ours */
export function appFrames(text) {
  return (text ?? '')
    .split('\n')
    .filter((line) => FRAME.test(line) && OUR_FRAME.test(line))
    .map((line) => line.trim());
}

/** @param {string} text a report body @returns {number[]} every WebView/Chrome major it names */
export function webViewMajors(text) {
  return [...(text ?? '').matchAll(WEBVIEW_MAJOR)].map((m) => Number(m[1]));
}

/**
 * Whether a PLATFORM record still holds, given what Play reports now.
 *
 * The three rules, each one a fact that made the issue "not ours" and that a new report can break:
 *  1. A report carries an APP FRAME - the crash now passes through our code.
 *  2. A report names a WebView major NEWER than every one recorded - the defect follows the WebView
 *     onto a version nobody looked at (an empty recorded set means the first named one re-opens).
 *  3. A versionCode NEWER than the baseline's reports it at a rate above the baseline. The rate is
 *     reports per 1,000 distinct users of that versionCode. When Play withholds the denominator
 *     (too few users - the state of every rate here as of 2026-11), the rate cannot be shown to be
 *     under the baseline, so ANY report on a newer versionCode re-opens it: an unmeasurable rate is
 *     never read as a low one.
 *
 * @param {object} record the PLATFORM entry of `known-issues.json`
 * @param {{reports: {reportText?: string, appVersion?: {versionCode?: string}}[],
 *          countsByVersion: Map<number, number>, usersByVersion: Map<number, number>}} seen
 *   the issue's reports in the window, its report count per versionCode, and Play's distinct users
 *   per versionCode (absent = withheld)
 * @returns {string[]} the reasons it re-opens; empty while it still holds
 */
export function judgePlatform(record, seen) {
  const reasons = [];

  // A fetch that failed is unmeasured, never "nothing found": the verdict cannot hold on it.
  for (const note of seen.unavailable ?? []) reasons.push(`evidence unavailable: ${note}`);

  for (const report of seen.reports) {
    const ours = appFrames(report.reportText);
    if (ours.length > 0) {
      reasons.push(
        `a report on versionCode ${report.appVersion?.versionCode ?? '?'} carries an app frame: ${ours[0]}`
      );
      break;
    }
  }

  const recorded = record.webViewMajors ?? [];
  const newestRecorded = recorded.length > 0 ? Math.max(...recorded) : -Infinity;
  const named = seen.reports.flatMap((r) => webViewMajors(r.reportText));
  const newer = named.filter((major) => major > newestRecorded);
  if (newer.length > 0) {
    reasons.push(
      `a report names WebView ${Math.max(...newer)}, newer than the recorded ` +
        `${recorded.length > 0 ? recorded.join(', ') : 'set (none recorded)'}`
    );
  }

  const baseline = record.baseline;
  // Independent of every metric query: the issue itself says it was last seen on a newer build.
  const last = seen.lastVersionCode ?? 0;
  if (last > baseline.versionCode && !(seen.usersByVersion.get(last) > 0)) {
    reasons.push(
      `the issue was last seen on versionCode ${last}, newer than the baseline ${baseline.versionCode}, ` +
        'and Play withholds its user count - an unmeasurable rate is not a low one'
    );
  }
  for (const [versionCode, count] of seen.countsByVersion) {
    if (versionCode <= baseline.versionCode || count === 0) continue;
    const users = seen.usersByVersion.get(versionCode);
    if (users === undefined || users === 0) {
      reasons.push(
        `${count} report(s) on versionCode ${versionCode}, newer than the baseline ${baseline.versionCode}, ` +
          'and Play withholds its user count - an unmeasurable rate is not a low one'
      );
      continue;
    }
    const rate = (count * 1000) / users;
    if (baseline.per1kUsers === null || rate > baseline.per1kUsers) {
      reasons.push(
        `versionCode ${versionCode} reports ${rate.toFixed(2)} per 1k users, above the baseline ` +
          `${baseline.per1kUsers ?? '(unmeasured)'} of ${baseline.versionCode}`
      );
    }
  }

  return reasons;
}

/**
 * The verdict for one issue.
 *
 * `KNOWN` and `PLATFORM` are the only verdicts that may be ignored. `KNOWN` is earned only by every
 * report predating the fix; `PLATFORM` only while {@link judgePlatform} finds nothing.
 *
 * @param {object} issue an `errorIssues:search` entry
 * @param {Record<string, object>} known the `issues` map of `known-issues.json`
 * @param {(record: object) => string[]} [platformReasons] judges a PLATFORM record (the caller
 *   binds what Play reported); required when the record is PLATFORM
 * @returns {{verdict: 'NEW'|'KNOWN'|'REGRESSION'|'PLATFORM', record?: object, reopened?: string[]}}
 */
export function classify(issue, known, platformReasons) {
  const id = issue.name?.split('/').pop();
  const record = known[id];
  if (!record) return { verdict: 'NEW' };
  if (record.kind === 'PLATFORM') {
    const reopened = platformReasons(record);
    return reopened.length > 0
      ? { verdict: 'NEW', record, reopened }
      : { verdict: 'PLATFORM', record };
  }
  const lastSeen = Number(issue.lastAppVersion?.versionCode ?? 0);
  if (lastSeen >= record.fixedInVersionCode) return { verdict: 'REGRESSION', record };
  return { verdict: 'KNOWN', record };
}
