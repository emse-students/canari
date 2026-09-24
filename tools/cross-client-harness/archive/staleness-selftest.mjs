/**
 * A ROW MEASURED ON A BUNDLE THE ESTATE NO LONGER SERVES IS ABSENT, NOT FAILING.
 *
 * The ledger stamps `build` from the REPOSITORY, so a check run against a tab left open across a
 * deploy writes a row naming a commit whose code that tab never executed. Measured 2026-09-05:
 * TAB-1 was re-run three times against a fixed application and recorded `FAIL` each time, on a fix
 * its tab had never loaded. Three probes were spent before the stale tab was the answer, and three
 * rows in the ledger accused the product of the rig's own state.
 *
 * `bundle.mjs` could tell a stale client from a current one since 2026-08-24 and ONLY A RUNNER ever
 * asked it - `tab1.mjs` learned to reload after paying for those three rows, while `tab3b.mjs`,
 * `tab7.mjs`, `notif.mjs`, `del1.mjs`, `msg4.mjs` and `mut.mjs` had not. That is a rule living in
 * six memories. It now lives in `gate()`, which is what this file pins.
 *
 * WHAT IT ASSERTS, AND WHY EACH ONE IS HERE:
 *
 *   1. a stale client makes the row `VACUOUS` - never `FAIL`, never `PASS`, never `PASS-DIRTY`;
 *   2. it does not invent a stale client out of a clean run, which is the failure mode that would
 *      void the whole campaign rather than one row;
 *   3. an UNREADABLE bundle is a blind spot recorded, never a demotion - the same shape
 *      `deployWindow` already has, and for the same reason: a demotion on an unreadable id would
 *      void every row the moment a fetch to the origin failed;
 *   4. the recorder asks BEFORE it drains the sockets, and never repairs. TAB-7 asserts
 *      `neverReloaded`, so a recorder that quietly reloaded a stale client would destroy the very
 *      observable some checks exist to measure.
 *
 * `observedBundles` itself is not imported here: it reaches `names.mjs`, which is gitignored
 * because this repository is PUBLIC, and `gate-selftest.mjs` refuses a gated self-test that does -
 * so rule 4 is asserted on source, as `verdict-selftest.mjs` does for the same reason.
 *
 *   bun archive/staleness-selftest.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gate } from '../watch.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

let failures = 0;
const ok = (label, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}   ${label}`);
  if (!cond) failures++;
};

/**
 * A finished `report()` for a client that printed nothing worth naming.
 *
 * `since` is deliberately absent: it is what `gate()` uses to ask `deploy.mjs` whether a deploy
 * overlapped the window, and that question shells out to `gh`. A self-test in the CI gate must not
 * depend on a network or on being logged in, and the deploy branch is not what this file measures.
 */
const CLEAN = { clean: true };
const DIRTY = { clean: false, errors: ['something'], warnings: [], notable: [], unexplained: [] };
const STALE = { W1: { running: '__sveltekit_old', deployed: '__sveltekit_new' } };

// ── 1. a stale client makes the row absent ──────────────────────────────────────────────────────
{
  const g = gate('PASS', { W1: CLEAN }, { bundles: { stale: STALE } });
  ok('a PASS measured on a stale client is VACUOUS', g.verdict === 'VACUOUS');
  ok('and the row says which client, and both ids', g.detail.staleClients === STALE);
}
ok(
  'a FAIL on a stale client is VACUOUS too - it accuses the product of the rig',
  gate('FAIL', { W1: CLEAN }, { bundles: { stale: STALE } }).verdict === 'VACUOUS'
);
ok(
  'and it outranks dirt, which is a weaker statement about the same run',
  gate('PASS', { W1: DIRTY }, { bundles: { stale: STALE } }).verdict === 'VACUOUS'
);

// ── 2. nothing is invented out of a clean run ───────────────────────────────────────────────────
{
  const g = gate('PASS', { W1: CLEAN }, { bundles: { stale: {}, blind: {} } });
  ok('a clean run on a current client is still PASS', g.verdict === 'PASS');
  ok('and carries no staleClients key at all', !('staleClients' in g.detail));
  ok('nor a bundleCheck key', !('bundleCheck' in g.detail));
}
ok(
  'a gate called with no observations behaves exactly as before',
  gate('PASS', { W1: CLEAN }).verdict === 'PASS'
);
ok(
  'and dirt still demotes to PASS-DIRTY when nothing is stale',
  gate('PASS', { W1: DIRTY }, { bundles: { stale: {} } }).verdict === 'PASS-DIRTY'
);

// ── 3. an unreadable bundle is a blind spot, never a demotion ───────────────────────────────────
{
  const blind = { W2: 'its build id: Inspected target navigated or closed' };
  const g = gate('PASS', { W2: CLEAN }, { bundles: { stale: {}, blind } });
  ok('a client whose bundle could not be read does NOT void the row', g.verdict === 'PASS');
  ok('and the reason is recorded under its label', g.detail.bundleCheck === blind);
}
{
  const g = gate(
    'PASS',
    { W1: CLEAN, W2: CLEAN },
    { bundles: { stale: STALE, blind: { W2: 'its origin: gone' } } }
  );
  ok('one stale client voids the row even beside an unreadable one', g.verdict === 'VACUOUS');
  ok('and both findings are recorded', 'staleClients' in g.detail && 'bundleCheck' in g.detail);
}

// ── 4. the recorder asks, before the drain, and repairs nothing ─────────────────────────────────
const results = readFileSync(join(ROOT, 'results.mjs'), 'utf8');
const recordObserved = results.slice(results.indexOf('export async function recordObserved'));
const body = recordObserved.slice(0, recordObserved.indexOf('\n}\n'));
ok('recordObserved asks for the bundles', body.includes('observedBundles(observers)'));
ok(
  'BEFORE it drains the sockets - report() consumes the events and needs the clients alive',
  body.indexOf('observedBundles(observers)') < body.indexOf('await report(o)')
);
ok('and hands them to the gate', /gate\(verdict, reports, \{ bundles \}\)/.test(body));
ok(
  'the failure of the check is a blind spot, never a lost verdict',
  /\.catch\(/.test(body) && body.includes('blind:')
);
// TAB-7 ASSERTS `neverReloaded`. A recorder that repaired would destroy what it measures, so the
// absence of a repair is asserted rather than trusted to stay absent.
ok(
  'and the recorder repairs nothing - the repair is `bundle.mjs --repair`, run deliberately',
  !/reloadOntoBundle|Page\.reload/.test(body)
);

// ── 5. a dead client costs a sentence, not thirty seconds ───────────────────────────────────────
//
// `ws.send` on a CLOSED socket does not throw: the frame goes nowhere and the caller learns from
// `cdp.mjs`'s 30 s command timeout. Measured 2026-09-24 through this very path - 30 002 ms for a
// closed client against 8 ms for a live one, and 1 ms once the socket was asked first. A check
// whose client died is exactly the case where the row still has to be written promptly, so the
// FACT is read rather than the failure awaited. Asserted on source because both halves need a real
// socket, which a self-test in the CI gate does not have.
const cdp = readFileSync(join(ROOT, 'cdp.mjs'), 'utf8');
ok('the transport says whether its socket is still open', /isOpen: \(\) => ws\.readyState === 1/.test(cdp));
const observed = readFileSync(join(ROOT, 'bundle.mjs'), 'utf8');
const reader = observed.slice(observed.indexOf('export async function observedBundles'));
const readerBody = reader.slice(0, reader.indexOf('\n}\n'));
ok('and the bundle check asks it', readerBody.includes('o.cx.isOpen()'));
ok(
  'BEFORE it evaluates anything in the page, which is what costs the thirty seconds',
  readerBody.indexOf('o.cx.isOpen()') < readerBody.indexOf("evaluate(o.cx, 'location.origin')")
);

console.log(
  failures
    ? `[staleness] ${failures} FAILURE(S) - a row can still name a build its client never ran`
    : '[staleness] clean - a stale client makes the row absent, an unreadable one makes it say so'
);
process.exit(failures ? 1 : 0);
