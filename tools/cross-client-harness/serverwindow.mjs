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
 * Fold a server window into what `gate()` returned, so the server counts EXACTLY as a client does.
 *
 * A PASS over a dirty server window is `PASS-DIRTY`; nothing else is rewritten. And the row's
 * `clean` - the one field every reader of a gated row reads - is the conjunction of the clients AND
 * the server, with the server's dirt under `dirt_server` beside each `dirt_<client>`. Until
 * 2026-10-04 the fold demoted the verdict but left `clean: true` on a row whose server was dirty, so
 * the row contradicted itself and a reader of `clean` saw two observers out of three.
 *
 * NO WINDOW LEAVES THE ROW EXACTLY AS `gate()` MADE IT - in particular with no `serverClean` key.
 * That absence is what `rows.mjs` reads as "the server was not observed": a row recorded before the
 * window reached the ledger carries no `serverClean`, and must never read as a clean server.
 *
 * @param {{verdict: string, detail: object}} gated what `gate()` returned for the clients
 * @param {object|null} serverWindow a {@link takeServerWindow} result, or null when the row took none
 * @returns {{verdict: string, detail: object}} the verdict and the whole gated detail
 */
export function foldServerWindow(gated, serverWindow) {
  if (!serverWindow) return gated;
  const { dirt, ...window } = serverWindow;
  const detail = {
    ...gated.detail,
    clean: gated.detail.clean === true && serverWindow.clean === true,
    serverWindow: window,
    serverClean: serverWindow.clean === true,
  };
  if (!detail.serverClean) detail.dirt_server = dirt ?? { unreachable: serverWindow.unreachable ?? 'no reason recorded' };
  const verdict = gated.verdict === 'PASS' && !detail.serverClean ? 'PASS-DIRTY' : gated.verdict;
  return { verdict, detail };
}
