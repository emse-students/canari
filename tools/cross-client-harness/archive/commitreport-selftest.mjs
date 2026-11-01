/**
 * Pins `commitreport.mjs`: the run's one read of the hourly commit report - campaign-owned groups
 * only, a busy group only in KILL-1's hour and only one, and a hole or an unread spelling FAILS.
 */
import { judgeCommitReports, lineInstant } from '../commitreport.mjs';

let failures = 0;
const check = (label, actual, expected) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures += 1;
    console.log(`FAIL ${label}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
  } else console.log(`ok   ${label}`);
};

const OWNER = '472df672aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const STRANGER = '9a8b7c6dbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const OUR_GROUP = 'aaaaaaaa-0000-4000-8000-000000000001';
const KEY_GROUP = 'bbbbbbbb-0000-4000-8000-000000000002';
const NEST = (level) => `[Nest] 1  - 10/26/2026, 9:00:00 PM   ${level} [AppController] `;
const at = (iso, level, msg) => `${iso} ${NEST(level)}${msg}`;
const rate = (busy) =>
  `[CRON] reportCommitLogHealth: commit rate over the last hour - 248 commit(s) in 20 group(s); per group p50=4 p90=20 max=40; busiest single committer per group p50=2 p90=10 max=20; ${busy} group(s) at >= 8 by one device`;
const busyWarn = (entries) =>
  `[CRON] reportCommitLogHealth: ${entries.length} group(s) were re-keyed 8 or more times in the last hour by ONE device - every commit is an epoch each lagging device must cross, and this churn is what makes a dropped frame likely. Busiest ${entries.length} of ${entries.length}: ${entries.join(' ')}`;
const entry = (group, user, key = false) => `${group}(${key ? 'key group, ' : ''}epoch 54, 40 commit(s) by 1 device(s), web-${user}-mvpp81eo-ioeg x40)`;
const CONTIGUOUS = "[CRON] reportCommitLogHealth: every commit log is contiguous from its oldest retained commit to its group's head";

const T = '2026-10-26T21:00:00.123456789Z';
const HOUR = 60 * 60 * 1000;
const t = Date.parse('2026-10-26T21:00:00.123Z');
const base = { ownedIds: [OUR_GROUP, OWNER], killOneSpans: [], spanMs: 30 * 60 * 1000 };
const verdict = (input) => {
  const r = judgeCommitReports({ ...base, ...input });
  return [r.verdict, r.failures.length];
};

check('docker nanoseconds read as an instant', lineInstant(`${T} x`), t);
check('a line with no timestamp has no instant', lineInstant('[Nest] x'), null);

check('a quiet hour passes', verdict({ lines: [at(T, 'LOG', rate(0)), at(T, 'LOG', CONTIGUOUS)] }), ['PASS', 0]);
check('nothing committed passes', verdict({ lines: [at(T, 'LOG', '[CRON] reportCommitLogHealth: commit rate over the last hour - no group committed')] }), ['PASS', 0]);

const killHour = [{ from: t - 40 * 60 * 1000, to: t - 30 * 60 * 1000 }];
check(
  "one busy campaign group in KILL-1's hour passes",
  verdict({ lines: [at(T, 'LOG', rate(1)), at(T, 'WARN', busyWarn([entry(OUR_GROUP, OWNER)]))], killOneSpans: killHour }),
  ['PASS', 0]
);
check(
  "a community key group is the campaign's by its committer",
  verdict({ lines: [at(T, 'LOG', rate(1)), at(T, 'WARN', busyWarn([entry(KEY_GROUP, OWNER, true)]))], killOneSpans: killHour }),
  ['PASS', 0]
);

// THE COUNTER-CASES: each one FAILS the read.
check(
  'control: a busy group in an hour no KILL-1 ran in (DEV-6, alpha.6)',
  verdict({ lines: [at(T, 'LOG', rate(1)), at(T, 'WARN', busyWarn([entry(OUR_GROUP, OWNER)]))] }),
  ['FAIL', 1]
);
check(
  'control: a KILL-1 that ended more than an hour before the report does not excuse it',
  verdict({ lines: [at(T, 'LOG', rate(1))], killOneSpans: [{ from: t - 3 * HOUR, to: t - HOUR - 1 }] }),
  ['FAIL', 1]
);
check("control: TWO busy groups in KILL-1's hour", verdict({ lines: [at(T, 'LOG', rate(2))], killOneSpans: killHour }), ['FAIL', 1]);
check(
  'control: a busy group neither recorded nor re-keyed by a campaign account',
  verdict({ lines: [at(T, 'LOG', rate(1)), at(T, 'WARN', busyWarn([entry(KEY_GROUP, STRANGER)]))], killOneSpans: killHour }),
  ['FAIL', 1]
);
check(
  'control: a HOLE in a commit log',
  verdict({
    lines: [
      at(
        T,
        'ERROR',
        `[CRON] reportCommitLogHealth: 1 group(s) have a HOLE in their commit log - 2 epoch(s) between the oldest retained commit and the head were accepted and never recorded. Newest 1 of 1: ${OUR_GROUP}(first hole at 4, 2 missing, log 1..9, after 2026-10-26T20:00:00.000Z)`
      ),
    ],
  }),
  ['FAIL', 1]
);
check('control: a failed report', verdict({ lines: [at(T, 'ERROR', '[CRON] reportCommitLogHealth failed')] }), ['FAIL', 1]);
check('control: a span over an hour with no rate line was not read', verdict({ lines: [], spanMs: 2 * HOUR }), ['FAIL', 1]);
check('a span under an hour may hold no report', verdict({ lines: [], spanMs: 50 * 60 * 1000 }), ['PASS', 0]);

if (failures) {
  console.log(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nall good');
