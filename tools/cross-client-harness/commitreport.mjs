/**
 * THE HOURLY COMMIT-LOG REPORT, READ ONCE PER CAMPAIGN RUN AND NEVER IN A ROW'S WINDOW.
 *
 * `chat-delivery-service` writes `[CRON] reportCommitLogHealth` on the hour (`app.controller.ts`): a
 * commit RATE over the last hour, the busy groups behind it (a `warn` naming each group and its
 * busiest committer), and any HOLE in a commit log (an `error`). It describes the WHOLE estate over
 * the WHOLE last hour, so the row whose window it happens to land in is not its subject: on
 * `1.4.1-alpha.6` DEV-6 read a busy group as its own dirt because the clock struck during it
 * (2026-10-26). A per-row rule cannot judge it - it can only be lucky or unlucky about the hour.
 *
 * SO IT IS JUDGED HERE, ONCE PER RUN, over the run's span (coordinator, 2026-10-26):
 *
 * - every group a report names must be the CAMPAIGN'S - its id in the ledger, or its busiest
 *   committer a campaign account (a community's key group is minted by the server and never recorded
 *   by id, so its committer is the only evidence of whose it is);
 * - a group at the per-device threshold is expected ONLY in an hour in which KILL-1 ran (it kills W1
 *   around its own commit twenty times in one group), and then ONE such group only;
 * - a HOLE, a failed report, and any spelling this module was not written against FAIL the read.
 *
 * Pure: `archive/hourlyread.mjs` reads the server and the ledger and hands the lines here, and
 * `archive/commitreport-selftest.mjs` pins every branch without an estate.
 */

/** Any line of the report, whatever it says. `srvlog.mjs` lifts these out of every row's window. */
export const COMMIT_REPORT_TAG = /\[CRON\] reportCommitLogHealth\b/;

/** One hour, the span each rate line describes. */
const HOUR_MS = 60 * 60 * 1000;

/** A report span longer than this must hold at least one rate line, or the cron was not read. */
const REPORT_EXPECTED_AFTER_MS = 65 * 60 * 1000;

const RATE_NONE = /\[CRON\] reportCommitLogHealth: commit rate over the last hour - no group committed$/;
const RATE = /\[CRON\] reportCommitLogHealth: commit rate over the last hour - \d+ commit\(s\) in \d+ group\(s\); per group p50=\d+ p90=\d+ max=\d+; busiest single committer per group p50=\d+ p90=\d+ max=\d+; (\d+) group\(s\) at >= \d+ by one device$/;
const BUSY = /\[CRON\] reportCommitLogHealth: (\d+) group\(s\) were re-keyed \d+ or more times in the last hour by ONE device - .* Busiest \d+ of \d+: (.+)$/;
const BUSY_ENTRY = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\((?:key group, )?epoch \d+, \d+ commit\(s\) by \d+ device\(s\), (\S+) x\d+\)/g;
const CONTIGUOUS = /\[CRON\] reportCommitLogHealth: every commit log is contiguous from its oldest retained commit to its group's head$/;

/** Docker's receive instant at the head of a `--timestamps` line, in ms, or null. */
export function lineInstant(line) {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s/.exec(String(line));
  if (!m) return null;
  // Docker prints nanoseconds; Date reads at most milliseconds.
  const t = Date.parse(m[1].replace(/(\.\d{3})\d+Z$/, '$1Z'));
  return Number.isNaN(t) ? null : t;
}

/** The user id a device id carries (`web-<user id>-<two-part tail>`), or null. */
const userOfDevice = (device) => /^(?:web|tauri)-([0-9a-f-]+)-[0-9a-z]+-[0-9a-z]+$/.exec(String(device))?.[1] ?? null;

/**
 * The verdict of the run's hourly commit reports.
 *
 * @param {object} input
 * @param {string[]} input.lines `chat-delivery-service` lines of the run's span, docker-timestamped
 * @param {string[]} input.ownedIds every id the campaign ledger records (groups, accounts, devices)
 * @param {{from: number, to: number}[]} input.killOneSpans when each KILL-1 of the span ran, in ms
 * @param {number} input.spanMs how long the run's span is, in ms
 * @returns {{verdict: 'PASS' | 'FAIL', reports: number, failures: string[], notes: string[]}}
 */
export function judgeCommitReports({ lines, ownedIds, killOneSpans, spanMs }) {
  const owned = new Set(ownedIds);
  const failures = [];
  const notes = [];
  let reports = 0;
  /** Whether a KILL-1 ran in the hour a line at `at` reports on. */
  const killOneInHour = (at) => at !== null && killOneSpans.some((s) => s.from <= at && s.to >= at - HOUR_MS);
  const short = (line) => String(line).replace(/^\S+\s+/, '').slice(0, 220);

  for (const line of lines.filter((l) => COMMIT_REPORT_TAG.test(l))) {
    const at = lineInstant(line);
    if (RATE_NONE.test(line) || CONTIGUOUS.test(line)) {
      if (!CONTIGUOUS.test(line)) reports += 1;
      continue;
    }
    const rate = RATE.exec(line);
    if (rate) {
      reports += 1;
      const busy = Number(rate[1]);
      if (busy === 0) continue;
      if (!killOneInHour(at)) failures.push(`${busy} busy group(s) in an hour no KILL-1 ran in: ${short(line)}`);
      else if (busy > 1) failures.push(`${busy} busy groups in KILL-1's hour - KILL-1 makes ONE: ${short(line)}`);
      else notes.push(`one busy group in KILL-1's hour (${new Date(at).toISOString()})`);
      continue;
    }
    const busyLine = BUSY.exec(line);
    if (busyLine) {
      const entries = [...busyLine[2].matchAll(BUSY_ENTRY)];
      if (!entries.length) failures.push(`a busy-group report whose groups could not be read: ${short(line)}`);
      for (const [, group, committer] of entries) {
        if (owned.has(group)) continue;
        if (owned.has(userOfDevice(committer))) {
          notes.push(`busy group ${group.slice(0, 8)} is the campaign's by its committer (${committer.slice(0, 13)}...), not by a ledger id`);
          continue;
        }
        failures.push(`a busy group the campaign does not own: ${group.slice(0, 8)} (committer ${committer.slice(0, 13)}...)`);
      }
      continue;
    }
    // A HOLE, A FAILED REPORT, OR A SPELLING NOBODY READ: each one is the finding.
    failures.push(`unexpected hourly commit report: ${short(line)}`);
  }
  if (reports === 0 && spanMs >= REPORT_EXPECTED_AFTER_MS) {
    failures.push(`no hourly commit rate in a span of ${Math.round(spanMs / 60_000)} min - the report was not read`);
  }
  return { verdict: failures.length ? 'FAIL' : 'PASS', reports, failures, notes };
}
