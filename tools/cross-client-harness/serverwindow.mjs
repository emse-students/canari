/**
 * THE SERVER HALF OF A ROW'S WINDOW, CONDENSED FOR THE LEDGER AND FOLDED INTO ITS VERDICT.
 *
 * A HEAL verdict used to say "clean on the web client" and never "clean on the server": `run.mjs`
 * takes the server window per PASS and PRINTS it, so `gate()` never saw it, `bun rows.mjs` could not
 * report it, and a `PASS-DIRTY` meant "the console was dirty" with the server's answer unrecorded -
 * while both windows of the HEAL-NEW 2/12 pair were not clean. A row that sets `serverWindowSince`
 * in its detail now gets this window written beside its client dirt, by `recordObserved`.
 *
 * Pure apart from the injected reader, so a self-test can drive it: `results.mjs` imports the
 * gitignored `names.mjs` and cannot be loaded on a fresh checkout.
 */
import { srvReport } from './srvlog.mjs';

/** Per service, only what a reader needs to judge: counts and the first few lines of each dirty bucket. */
const BUCKETS = [
  ['severe', 'severeCount'],
  ['errors', 'errorCount'],
  ['unexplained', 'unexplainedCount'],
];

/**
 * A `srvReport` result as a small, JSON-stable ledger value.
 *
 * @param {object} rep the value `srvReport` returns, or `{clean:false, unreachable}`
 */
export function serverWindowDetail(rep) {
  const out = { since: rep.since ?? null, clean: rep.clean === true };
  if (rep.unreachable) out.unreachable = rep.unreachable;
  const dirty = {};
  for (const [service, r] of Object.entries(rep)) {
    if (!r || typeof r !== 'object' || (r.clean !== false && !r.unreachable)) continue;
    const d = {};
    if (r.unreachable) d.unreachable = r.unreachable;
    for (const [bucket, countKey] of BUCKETS) {
      if (r[bucket]?.length) d[bucket] = { count: r[countKey] ?? r[bucket].length, lines: r[bucket].slice(0, 5) };
    }
    dirty[service] = d;
  }
  if (Object.keys(dirty).length) out.dirt = dirty;
  return out;
}

/**
 * Read a window from the server and condense it. UNREACHABLE IS NOT QUIET: a window that could not be
 * read is recorded as not clean with its reason, never as clean.
 *
 * @param {(service: string, since: string) => string[]} read the log reader (`estate.mjs` `srvLines`)
 * @param {string} since an ISO instant, the row's own start
 * @param {string[]} [subjects] campaign user-id prefixes; omit to leave the window unpartitioned
 */
export function takeServerWindow(read, since, subjects = []) {
  try {
    return serverWindowDetail(srvReport(read, since, { subjects }));
  } catch (e) {
    return { since, clean: false, unreachable: String(e?.message ?? e).slice(0, 200) };
  }
}

/**
 * Fold a server window into a gated verdict: a PASS over a dirty server window is `PASS-DIRTY`, and
 * nothing else is rewritten. Same demotion `gate()` applies to a dirty client, for the same reason.
 *
 * @returns {{verdict: string, detail: object}} the verdict and the fields to add to the row
 */
export function foldServerWindow(verdict, serverWindow) {
  if (!serverWindow) return { verdict, detail: {} };
  const detail = { serverWindow, serverClean: serverWindow.clean };
  return { verdict: verdict === 'PASS' && !serverWindow.clean ? 'PASS-DIRTY' : verdict, detail };
}
