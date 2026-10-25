/**
 * THE PURE HALF OF EVERY 1.4.1 ROW RUNNER - the names a row mints, and how its verdict is composed.
 *
 * `docs/wiki/cross-client-campaign-1-4-1.md` section 4.2 is a matrix of about seventy rows in twelve
 * groups, and every one of them ends the same way: the row's OWN question (one commit, a refusal
 * cleared, a message once), the five invariants of section 4.0 (`invariantverdict.mjs`), and - for a
 * row that arms a fault - whether the fault actually fired. Written once here so the runners
 * (`archive/floor.mjs`, `archive/cc.mjs`, ...) differ only in their tables and their action, and
 * so `archive/floor-selftest.mjs` can pin the composition on a checkout with no rig: this module
 * imports only `marker.mjs`, never `names.mjs`.
 *
 * The impure half - seats, watchers, ownership, the server reads - is `mlsrow.mjs`.
 */
import { mark } from './marker.mjs';

/**
 * The row-group prefixes of section 4.2. A group a runner mints is `<GROUP><n>-<mark tail>`
 * (`FLOOR2-mh3k2a9xq`), so `debris.mjs` can sweep it and nothing a person types matches it.
 */
export const ROW_GROUPS = ['FLOOR', 'CC', 'DUP', 'OFF', 'KILL', 'GAP', 'RM', 'ADM', 'DEV', 'BIG', 'TOK', 'NET'];

/**
 * `FLOOR-2` -> `FLOOR2`, `RM-4b` -> `RM4b`, refusing an id that is not a 1.4.1 row. The one lower-case
 * letter is a sibling row on the same subject (RM-4b, the revoke race beside RM-4's grant race), and
 * `debris.mjs` allows exactly that letter.
 */
export function rowStem(rowId) {
  const m = /^([A-Z]+)-(\d+)([a-z]?)$/.exec(String(rowId));
  if (!m || !ROW_GROUPS.includes(m[1])) throw new Error(`rowStem: '${rowId}' is not a 1.4.1 row id (${ROW_GROUPS.join(' ')})`);
  return `${m[1]}${m[2]}${m[3]}`;
}

/**
 * The name of a group a row mints for itself, one per run: `FLOOR2-<mark tail>`. The ONE expression
 * every runner mints with, which is what `archive/debris-selftest.mjs` builds its case from.
 */
export const rowGroupName = (rowId) => mark(rowStem(rowId));

/**
 * A MESSAGE marker for a row. Deliberately NOT a group shape (`F1A-...`, never `FLOOR1-...`): a
 * marker shows up as a sidebar preview, and a preview matching the sweep's allowlist is how a
 * conversation gets deleted for its last message (`GRPBEF`, debris-selftest).
 */
export const rowMessageMark = (rowId, tag) => mark(`M${rowStem(rowId).replace(/[A-Z]+/, (g) => g.slice(0, 2))}${tag}`);

/**
 * The commit-log epochs a row moved: rows whose `baseEpoch` is at or past `fromEpoch`.
 *
 * @param {number[]} commitEpochs `mls_commit_log.baseEpoch` of the group
 * @param {number} fromEpoch the server's `activeEpoch` before the row's action
 */
export const commitsSince = (commitEpochs, fromEpoch) => (commitEpochs ?? []).filter((e) => e >= fromEpoch).sort((a, b) => a - b);

/**
 * THE ROW'S VERDICT, composed from its own assertions, the invariant and the faults it armed.
 *
 * - `INVALID` when the row's PREMISE could not be built (`premise` lists what is missing): the
 *   product was never asked the question, so a `FAIL` would accuse it of a rig condition.
 * - `VACUOUS` when an armed fault never fired (`fault.mjs` `report().vacuous`): the case the row
 *   exists for did not happen, so nothing about it was proved - whatever else held.
 * - `INCONCLUSIVE` when an invariant pass could not be judged (`unsettled`: the group never settled).
 * - `FAIL` when one of the row's own assertions or one invariant does not hold.
 * - `PASS` otherwise. `recordObserved` then gates it on the clients' and the server's windows, so a
 *   clean assertion over a dirty window still lands as `PASS-DIRTY`.
 *
 * @param {object} p
 * @param {{what: string, ok: boolean}[]} p.own the row's own assertions, each named
 * @param {{ok: boolean, passes: {pass: string, failures: object[], approximations: object[]}[]}|null} p.invariant
 *   `checkInvariant()`'s result; null only for a row whose premise failed before it could run
 * @param {{rule: number, fault: string}[]} [p.vacuousFaults] armed rules that never fired
 * @param {string[]} [p.premise] what the row could not build
 * @returns {{verdict: string, failures: string[]}}
 */
export function composeVerdict({ own = [], invariant = null, vacuousFaults = [], premise = [] }) {
  const failures = [];
  for (const a of own) if (!a.ok) failures.push(a.what);
  for (const p of invariant?.passes ?? []) for (const f of p.failures) failures.push(`invariant ${f.invariant} (${p.pass}): ${f.what}`);
  if (premise.length) return { verdict: 'INVALID', failures: [...premise.map((p) => `premise: ${p}`), ...failures] };
  if (vacuousFaults.length) {
    return { verdict: 'VACUOUS', failures: [...vacuousFaults.map((f) => `fault #${f.rule} '${f.fault}' never fired`), ...failures] };
  }
  // A PASS THE INVARIANT COULD NOT JUDGE (the group never settled) is no answer either way.
  const unsettled = (invariant?.passes ?? []).filter((p) => p.unsettled).map((p) => `invariant (${p.pass}): ${p.unsettled}`);
  if (unsettled.length) return { verdict: 'INCONCLUSIVE', failures: [...unsettled, ...failures] };
  if (!invariant && !own.length) return { verdict: 'INVALID', failures: ['the row asserted nothing'] };
  if (!invariant) failures.push('the invariant of section 4.0 was not run');
  return { verdict: failures.length ? 'FAIL' : 'PASS', failures };
}

/**
 * The invariant result as a ledger value: per pass, the failures and the approximations, both kept -
 * an approximation is what the rig could not read directly, and the row must say so.
 */
export const invariantDetail = (inv) =>
  inv
    ? inv.passes.map((p) => ({ pass: p.pass, ok: p.ok, failures: p.failures, approximations: p.approximations, ...(p.settleMs !== undefined ? { settleMs: p.settleMs } : {}), ...(p.unsettled ? { unsettled: p.unsettled } : {}) }))
    : null;

/**
 * WHY NO ROW MAY FAULT A FIRST-PARTY API REQUEST ON THE TAURI APPS (A1, I1): every JSON call to the
 * API, the commit POST included, goes through `tauri-plugin-http` (`hooks.client.ts`
 * `createRoutedFetch`), below the WebView, so CDP `Fetch` never sees it and a `hold` never fires.
 * Measured on A1, 2026-10-25 (OFF-5): the gesture succeeded, the commit was accepted, and the fault
 * timed out with "1 held request(s) never happened". A radio cut timed around the commit instead is
 * a race, not a fault. What would lift it: a fault point INSIDE the app's routed fetch, in a bench
 * build only - a rig proposal, not built.
 */
export const TAURI_HTTP_BLOCKED =
  'BLOCKED-ON-RIG: the row faults a first-party API request on a Tauri app, which goes through tauri-plugin-http where CDP Fetch cannot hold it';

/**
 * What a row's armed faults PUT IN FRONT OF THE PAGE, one entry per acted record (`fault.mjs`): a
 * fulfilled status (`status N`, `status-unsent N`) or a transport failure (`lose-answer`, and a
 * `hold` / `hold-answer` the row chose to `fail()`, or one the PAGE abandoned while it was held - its
 * own deadline fired, DUP-6 - which leaves the record's answer in error). A delayed or released
 * request provoked nothing.
 *
 * @param {object[]} records `armFault(...).disarm()` records
 * @returns {{method: string, url: string, status: number|null}[]} `status: null` is a transport failure
 */
export function provokedFailures(records) {
  const out = [];
  for (const r of records ?? []) {
    if (r.done === 'fulfillRequest' && Number.isInteger(r.gave)) out.push({ method: r.method, url: r.url, status: r.gave });
    else if (r.done === 'failRequest') out.push({ method: r.method, url: r.url, status: null });
    else if (r.answerError && (r.mode === 'hold' || r.mode === 'hold-answer')) out.push({ method: r.method, url: r.url, status: null });
  }
  return out;
}

/**
 * A WATCH REPORT WITH EXACTLY THE FAILURES THE ROW'S OWN FAULTS PROVOKED FORGIVEN, and nothing else.
 *
 * `ignoringExpectedRefusal` forgives by PATH and STATUS, so it cannot forgive a transport failure
 * (`POST .../api/mls/commit -> net::ERR_CONNECTION_RESET`) and it forgives EVERY matching line, so a
 * second, unprovoked 503 on the same path would vanish with the first. Here each provoked failure
 * (`provokedFailures`) forgives ONE `badHttp` line naming the same method, url and outcome, and ONE
 * `Failed to load resource` echo Chrome writes beside it for that url - a count, never a pattern.
 * What was forgiven is kept under `forgivenAsProvoked`, so the record still says the fault happened.
 *
 * @param {object} rep a `report()` result
 * @param {object[]} records the fault records of THIS page (`armFault(...).disarm()`)
 */
export function forgivingProvoked(rep, records) {
  const owed = provokedFailures(records);
  if (!owed.length) return rep;
  const parse = (line) => /^(\S+)\s+(\S+)\s+->\s+(\S+)$/.exec(line);
  const outcomeOk = (p, outcome) => (p.status === null ? !/^\d+$/.test(outcome) : outcome === String(p.status));
  const badLeft = [...rep.badHttp];
  const errLeft = [...rep.errors];
  const forgiven = { badHttp: [], errors: [] };
  for (const p of owed) {
    const bi = badLeft.findIndex((l) => {
      const m = parse(l);
      return !!m && m[1].toUpperCase() === String(p.method).toUpperCase() && m[2] === p.url && outcomeOk(p, m[3]);
    });
    if (bi >= 0) forgiven.badHttp.push(...badLeft.splice(bi, 1));
    const echo = p.status === null ? /Failed to load resource: net::ERR_\w+/ : new RegExp(`Failed to load resource: the server responded with a status of ${p.status}(?!\\d)`);
    const ei = errLeft.findIndex((l) => echo.test(l) && l.endsWith(` ${p.url}`));
    if (ei >= 0) forgiven.errors.push(...errLeft.splice(ei, 1));
  }
  return {
    ...rep,
    badHttp: badLeft,
    errors: errLeft,
    // THE SAME BUCKETS `report` JUDGES, minus only what was forgiven: a socket close or an
    // unexplained line still breaks the row.
    clean:
      errLeft.length === 0 &&
      badLeft.length === 0 &&
      rep.exceptions.length === 0 &&
      (rep.wsEvents ?? []).length === 0 &&
      rep.severe.length === 0 &&
      rep.unexplained.length === 0,
    forgivenAsProvoked: { provoked: owed.length, ...forgiven },
  };
}
