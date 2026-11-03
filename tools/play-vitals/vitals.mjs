#!/usr/bin/env node
/**
 * The Android vitals watch: what Play knows about this app that no gate in this repo can see.
 *
 * Every Android gate here proves the app COMPILES and that the shrinker did not crash. None of them
 * runs the app on a user's phone, which is where the three defects Play has reported so far were
 * found. This reads the field.
 *
 * Usage:
 *   bun vitals.mjs               report
 *   bun vitals.mjs --stacks      also pull one stack trace per unresolved issue
 *   bun vitals.mjs --json        raw payloads, for diffing between runs
 *
 * Exit codes: 0 nothing new, 1 a NEW or REGRESSED issue is present, 2 the run itself failed.
 */

import { readFileSync } from 'node:fs';
import { classify, judgePlatform } from './classify.mjs';
import {
  METRIC_SETS,
  PKG,
  PUBLISHER,
  REPORTING,
  api,
  queryMetricSet,
  searchErrorIssues,
  searchErrorReports,
  tracks,
} from './lib.mjs';

const WINDOW_DAYS = 28;
const wantStacks = process.argv.includes('--stacks');
const wantJson = process.argv.includes('--json');

const known = JSON.parse(
  readFileSync(new URL('./known-issues.json', import.meta.url), 'utf8')
).issues;

/** @param {object[]} rows metric-set rows @returns {string} a one-line summary or a stated absence */
function summarise(rows) {
  if (rows.length === 0) return 'no rows - either nothing happened, or too few users to report';
  const last = rows.at(-1);
  const points = (last.metrics ?? [])
    .map((m) => `${m.metric}=${m.decimalValue?.value ?? m.value ?? '?'}`)
    .join(' ');
  return `${rows.length} row(s), latest: ${points}`;
}

/**
 * What Play reports about every PLATFORM issue present, for `judgePlatform` to read: each one's
 * reports in the window, its report count per versionCode, and Play's distinct users per
 * versionCode. Fetched once per run, and only when a PLATFORM issue is present.
 *
 * @param {object[]} issues the `errorIssues:search` entries
 * @param {Date} start
 * @param {Date} end
 * @returns {Promise<{judge: (id: string) => string[]}>}
 */
async function readPlatformEvidence(issues, start, end) {
  const ids = issues
    .map((issue) => issue.name?.split('/').pop())
    .filter((id) => known[id]?.kind === 'PLATFORM');
  if (ids.length === 0) return { judge: () => [] };

  const errorCount = METRIC_SETS.find((spec) => spec.set === 'errorCountMetricSet');
  const crashRate = METRIC_SETS.find((spec) => spec.set === 'crashRateMetricSet');
  const counts = await queryMetricSet(errorCount, WINDOW_DAYS - 1, ['issueId', 'versionCode']);
  const users = await queryMetricSet(
    { ...crashRate, metrics: ['distinctUsers'] },
    WINDOW_DAYS - 1,
    ['versionCode']
  );
  if (counts.note) console.error(`  ! errorCountMetricSet by issue: ${counts.note}`);
  if (users.note) console.error(`  ! crashRateMetricSet users by version: ${users.note}`);

  const dimension = (row, name) => row.dimensions?.find((d) => d.dimension === name)?.stringValue;
  const metric = (row, name) =>
    Number(row.metrics?.find((m) => m.metric === name)?.decimalValue?.value ?? 0);
  const usersByVersion = new Map();
  for (const row of users.rows) {
    const code = Number(dimension(row, 'versionCode'));
    usersByVersion.set(code, (usersByVersion.get(code) ?? 0) + metric(row, 'distinctUsers'));
  }

  const evidence = new Map();
  for (const id of ids) {
    const countsByVersion = new Map();
    for (const row of counts.rows.filter((r) => dimension(r, 'issueId') === id)) {
      const code = Number(dimension(row, 'versionCode'));
      countsByVersion.set(code, (countsByVersion.get(code) ?? 0) + metric(row, 'errorReportCount'));
    }
    const reports = await searchErrorReports(id, start, end, 100);
    evidence.set(id, { reports, countsByVersion, usersByVersion });
  }
  return { judge: (id) => judgePlatform(known[id], evidence.get(id)) };
}

async function main() {
  const end = new Date();
  const start = new Date(end.getTime() - WINDOW_DAYS * 86400_000);
  const raw = {};

  console.log(`# Android vitals - ${PKG}`);
  console.log(
    `# window: ${start.toISOString().slice(0, 10)} -> ${end.toISOString().slice(0, 10)}\n`
  );

  console.log('## What Play is serving');
  const live = await tracks();
  raw.tracks = live;
  for (const track of live) {
    for (const release of track.releases ?? []) {
      console.log(
        `  ${track.track.padEnd(11)} ${release.name} (code ${release.versionCodes?.join(',')}) - ${release.status}`
      );
    }
  }

  console.log("\n## Play's own anomaly detection");
  const anomalies = await api(`${REPORTING}/apps/${PKG}/anomalies`);
  raw.anomalies = anomalies.body;
  const found = anomalies.body?.anomalies ?? [];
  console.log(found.length === 0 ? '  none' : JSON.stringify(found, null, 2));

  console.log(`\n## Crash and ANR issues, last ${WINDOW_DAYS} days`);
  const issues = await searchErrorIssues(start, end);
  raw.issues = issues;
  const platformEvidence = await readPlatformEvidence(issues, start, end);
  let actionable = 0;
  if (issues.length === 0) console.log('  none');
  for (const issue of issues) {
    const id = issue.name?.split('/').pop();
    const { verdict, record, reopened } = classify(issue, known, () => platformEvidence.judge(id));
    if (verdict !== 'KNOWN' && verdict !== 'PLATFORM') actionable += 1;
    console.log(
      `\n  [${verdict}] ${issue.type} ${issue.cause}\n` +
        `    ${issue.location}\n` +
        `    ${issue.errorReportCount} report(s), ${issue.distinctUsers} user(s), last ${issue.lastErrorReportTime}\n` +
        `    versionCode ${issue.firstAppVersion?.versionCode} -> ${issue.lastAppVersion?.versionCode}, API ${issue.lastOsVersion?.apiLevel}\n` +
        `    ${issue.issueUri}`
    );
    if (record?.kind === 'PLATFORM') {
      console.log(`    platform: ${record.diagnosis}`);
      for (const reason of reopened ?? []) console.log(`    !! RE-OPENED: ${reason}`);
    } else if (record) {
      console.log(
        `    known: fixed by ${record.fixedBy}, first good build ${record.fixedInVersionCode}`
      );
    }
    if (verdict === 'REGRESSION') {
      console.log('    !! seen at or above the build that fixed it - the fix did not hold');
    }
    if (wantStacks && verdict !== 'KNOWN' && verdict !== 'PLATFORM') {
      const [report] = await searchErrorReports(id, start, end, 1);
      if (report?.reportText) {
        console.log(
          report.reportText
            .split('\n')
            .map((l) => `      ${l}`)
            .join('\n')
        );
      }
    }
  }

  console.log('\n## Vitals metric sets');
  raw.metrics = {};
  for (const spec of METRIC_SETS) {
    const result = await queryMetricSet(spec, WINDOW_DAYS - 1);
    raw.metrics[spec.set] = result;
    const freshTo = result.end ? `${result.end.year}-${result.end.month}-${result.end.day}` : 'n/a';
    console.log(
      `  ${spec.set.padEnd(38)} fresh to ${freshTo}: ${result.note ?? summarise(result.rows)}`
    );
  }

  console.log('\n## Reviews');
  const reviews = await api(`${PUBLISHER}/applications/${PKG}/reviews`);
  raw.reviews = reviews.body;
  const list = reviews.body?.reviews ?? [];
  console.log(list.length === 0 ? '  none' : `  ${list.length}`);
  for (const review of list) {
    const comment = review.comments?.[0]?.userComment;
    console.log(`  - ${comment?.starRating}* ${comment?.text?.slice(0, 160) ?? ''}`);
  }

  if (wantJson) console.log(`\n${JSON.stringify(raw, null, 2)}`);

  console.log(
    `\n=> ${actionable} issue(s) needing attention, ${issues.length - actionable} already known (fixed, or platform and still holding).`
  );
  return actionable === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`vitals watch failed: ${error.message}`);
    process.exit(2);
  }
);
