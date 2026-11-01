/**
 * THE RUN'S ONE READ OF THE HOURLY COMMIT REPORT - once per campaign run, after its last row.
 *
 *   bun archive/hourlyread.mjs --since 2026-10-26T20:00:00.000Z [--until <ISO>]
 *
 * `srvlog.mjs` lifts `[CRON] reportCommitLogHealth` out of every row's window, because the report
 * describes the whole estate over the last hour and the row the clock strikes in is not its subject.
 * This is where it is judged instead (`commitreport.mjs`): every group named must be the campaign's,
 * a busy group is expected only in an hour KILL-1 ran in, and a hole or an unread spelling FAILS.
 * Exit 0 on PASS, 1 on FAIL, 2 on a usage error. It records no row: it is the run's read, not a row.
 */
import { ledger } from '../campaign.mjs';
import { judgeCommitReports, lineInstant } from '../commitreport.mjs';
import { srvLines } from '../estate.mjs';
import { all } from '../results.mjs';

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const since = arg('--since');
const until = arg('--until') ?? new Date().toISOString();
const from = Date.parse(since ?? '');
const to = Date.parse(until);
if (Number.isNaN(from) || Number.isNaN(to) || to <= from) {
  console.error('usage: bun archive/hourlyread.mjs --since <ISO run start> [--until <ISO>]');
  process.exit(2);
}

const lines = srvLines('chat-delivery-service', since, { timestamps: true }).filter((l) => {
  const at = lineInstant(l);
  return at === null || at <= to;
});
const ownedIds = ledger()
  .map((e) => e.id)
  .filter(Boolean);
// WHEN EACH KILL-1 RAN: from its server window's start to its record. A KILL-1 with no window start
// is dated by its record alone, which only narrows the hour it may excuse.
const killOneSpans = all()
  .filter((r) => r.id === 'KILL-1')
  .map((r) => ({ from: Date.parse(r.serverWindow?.since ?? r.at), to: Date.parse(r.at) }))
  .filter((s) => !Number.isNaN(s.from) && !Number.isNaN(s.to) && s.to >= from && s.from <= to);

const out = judgeCommitReports({ lines, ownedIds, killOneSpans, spanMs: to - from });
console.log(`[hourlyread] ${since} .. ${until}: ${out.reports} hourly rate report(s), ${killOneSpans.length} KILL-1 run(s) in span`);
for (const n of out.notes) console.log(`[hourlyread] note: ${n}`);
for (const f of out.failures) console.log(`[hourlyread] FAIL ${f}`);
console.log(`[hourlyread] ${out.verdict}`);
process.exit(out.verdict === 'PASS' ? 0 : 1);
