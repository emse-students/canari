/**
 * TAB-4 - two tabs of the SAME account, open at once.
 *
 * The risk is named in the ratchet-checkpoint fix itself: a ratchet that can go backwards means two
 * live tabs of one device can diverge. Both tabs share one IndexedDB and one MLS state, and the app
 * elects a leader over Web Locks (`[TAB] Leadership acquired`) so only one holds the WebSocket. The
 * questions are therefore:
 *   - does a message arrive in BOTH tabs, or only the leader's?
 *   - does sending from the FOLLOWER tab work at all, and exactly once?
 *   - does either tab log a duplicate / out-of-bounds, i.e. did the two of them fight over the
 *     ratchet?
 *
 * The second tab is opened BY THE PAGE (`window.open`), which is the only way to get a real sibling
 * tab in the same window and the same profile - see `tabs.mjs` for why the CDP routes do not.
 *
 * REWRITTEN 2026-08-14, and the reason is worth keeping: this script computed three verdicts, printed
 * them as JSON and exited. Nothing reached `results.ndjson`, so TAB-4a, TAB-4b and TAB-4c had never
 * once appeared in the campaign's record - and a check that records nothing is indistinguishable
 * from one that passed, which is the worse of the two directions to be wrong in.
 */
import { APP_TAB, awaitAppReady, awaitMessage, client, ensureConversation, evaluate, send, settledCount } from '../chat.mjs';
import { connect, listTargets, reloadAndWait } from '../cdp.mjs';
import { gate, ignoringExpectedLog, report, watch } from '../watch.mjs';
import { mark, record, exitOnRecorded } from '../results.mjs';
import { PORTS, SITE, peerNameFor } from '../names.mjs';

const w1 = await client(PORTS.W1, APP_TAB);
const w2 = await client(PORTS.W2, APP_TAB);

// Both clients are reloaded first, and this is not hygiene: a long-lived tab keeps the bundle it
// loaded, so a page opened before a deploy runs the OLD code while a tab opened by this script runs
// the new one. The first run after the WP-HIDDEN-1 deploy failed exactly that way.
// `reloadAndWait`, not a reload followed by a poll: `awaitAppReady` is a page-side poll, and one
// issued against the context this very reload is destroying is a race of this script's own making
// (see `until` in `cdp.mjs`). The load event is a fact; the app being ready is then polled against a
// context that exists.
for (const cx of [w1, w2]) await reloadAndWait(cx);
for (const cx of [w1, w2]) await awaitAppReady(cx);
await ensureConversation(w1, peerNameFor('W1'));
await ensureConversation(w2, peerNameFor('W2'));

const before = new Set((await listTargets(PORTS.W1)).map((t) => t.id));
await evaluate(
  w1,
  `(function () { window.__t2 = window.open(${JSON.stringify(`${SITE}/chat`)}, '_blank'); return !!window.__t2; })()`,
);

// A NEW TARGET IS A FACT, so it is polled for and the bound is a failure rather than a wait. Twenty
// seconds is well past the point where a tab that opened at all would be listed.
const OPEN_DEADLINE_MS = 20000;
const t0 = Date.now();
let target = null;
while (!target && Date.now() - t0 < OPEN_DEADLINE_MS) {
  target = (await listTargets(PORTS.W1)).find((t) => !before.has(t.id) && t.url.includes(APP_TAB));
  if (!target) await new Promise((r) => setTimeout(r, 200));
}
if (!target) {
  // INCONCLUSIVE, never FAIL: the second tab never existing says nothing about whether two tabs
  // diverge, which is the only thing TAB-4 is asking. Recording FAIL here would put a defect against
  // the application for something the popup blocker did.
  record('TAB-4', 'INCONCLUSIVE', {
    why: `no second tab appeared on ${PORTS.W1} within ${OPEN_DEADLINE_MS}ms - window.open blocked?`,
  });
  process.exit(1);
}

const w1b = connect(target.webSocketDebuggerUrl);
await w1b.ready;
await w1b.send('Runtime.enable');
w1b.port = PORTS.W1;
console.log(`second tab attached: ${target.url}`);

/**
 * A FRESH TAB MAY COME UP AT THE PIN GATE, and that is not this check's failure to report as one.
 *
 * The line this replaces was `sleep(12000)` under a comment saying "PIN unlock included" - which
 * assumed an outcome it never verified. If the gate is up, no amount of waiting clears it, every
 * assertion below then measures a tab that cannot decrypt, and the run reports a divergence between
 * two tabs when what it saw was one locked one.
 */
const ready = await awaitAppReady(w1b, 30000).then(() => true, () => false);
if (!ready) {
  const gated = await evaluate(w1b, `!!document.querySelector('#encryption-pin')`).catch(() => false);
  record('TAB-4', 'INCONCLUSIVE', {
    why: gated
      ? 'the second tab came up at the PIN gate - it cannot decrypt, so nothing here is measurable'
      : 'the second tab never rendered within 30s',
  });
  process.exit(1);
}
await ensureConversation(w1b, peerNameFor('W1'));

/** One round: send, wait for arrival, then let every count settle before reading any of them. */
async function round(id, from, text, watched) {
  const m = mark(id.replace(/\W/g, '').toUpperCase());
  const obs = [];
  for (const [label, cx] of watched) obs.push([label, cx, await watch(cx, `${id}-${label}`)]);

  await send(from, `${m} ${text}`);
  // Arrival on every watched client is what the round is FOR, so a client that never sees it is a
  // measured zero rather than a thrown error - the counts below are the verdict, not this line.
  for (const [, cx] of watched) await awaitMessage(cx, m, 25000).catch(() => null);

  const counts = {};
  let allSettled = true;
  for (const [label, cx] of watched) {
    const s = await settledCount(cx, m);
    counts[label] = s.count;
    allSettled &&= s.settled;
  }

  const reports = {};
  for (const [label, , o] of obs) reports[label] = await report(o);
  return { marker: m, counts, allSettled, reports };
}

const WATCHED = [
  ['tab1', w1],
  ['tab2', w1b],
  ['peer', w2],
];

/**
 * Records one round. THE OBSERVATION IS PART OF THE VERDICT, not a field beside it.
 *
 * The version this replaces kept `notable` in the row and computed the verdict from the counts
 * alone, so a tab logging a ratchet collision recorded `PASS` with the collision in its own record.
 * That is the exact shape that let MSG-6 pass twice with `SecretReuseError` inside it.
 */
function verdict(id, r, expected, expectedLogs = {}) {
  const wrong = Object.entries(expected).filter(([k, v]) => r.counts[k] !== v);
  const asserted = wrong.length ? 'FAIL' : !r.allSettled ? 'INCONCLUSIVE' : 'PASS';
  // `gate`, not a hand-rolled copy of it. This function computed the same thing correctly and named
  // it `dirt`, which is one field away from `dirtOf` and one CONCEPT away from the record every other
  // check writes: no `clean` key, so a reader filtering the ledger for observed runs skipped all
  // three TAB-4 rows, and `record`'s own refusal - which recognises an observation by that key -
  // would now demote them to UNOBSERVED. A private reimplementation of a shared rule stays right
  // exactly until the shared one moves.
  // Per row and per client, which is the only granularity a disposition may have: a needle list
  // that lived beside the runner would excuse the same sentence on the ten rows that never expect
  // it. Each entry below is a line this row MANUFACTURES, named where it is manufactured.
  const reports = Object.fromEntries(
    Object.entries(r.reports).map(([label, rep]) => [
      label,
      expectedLogs[label] ? ignoringExpectedLog(rep, expectedLogs[label]) : rep,
    ]),
  );
  const gated = gate(asserted, reports);
  record(id, gated.verdict, {
    ...gated.detail,
    marker: r.marker,
    counts: r.counts,
    expected,
    countsSettled: r.allSettled,
  });
}

/**
 * THE TWO LINES THIS ROW MANUFACTURES, AND WHY EACH IS EXPECTED RATHER THAN TOLERATED.
 *
 * HANDOVER is the visible end of the leader gate working: a follower may not encrypt, so it queues
 * and asks the leader to drain. The line is one per follower send, and it is load-bearing - its
 * ABSENCE is exactly how the follower's outbox was found dead on 2026-09-05 (the Web Locks branch
 * never decided, so `runFlush` awaited an election that had already happened and never returned).
 * A row that manufactures a second tab is the only row that can produce it.
 *
 * COLLISION is the snapshot-version guard refusing a second writer. `_snapshotSeq` is per document
 * and seeded from the stored value, so two tabs seeded from one snapshot reach the same number and
 * one write is dropped. Harmless HERE - a follower holds no WebSocket and never advances the
 * ratchet, so its snapshot carries nothing the leader's does not - and open in general as the P2 in
 * `docs/wiki/backlog.md` on the cross-document counter. This row is where two documents exist.
 */
const HANDOVER = '[OUTBOX] Flush requested by a follower tab.';
const COLLISION = 'collides with the stored one';
const TWO_TABS = { tab1: [HANDOVER, COLLISION], tab2: [HANDOVER, COLLISION] };

// TAB-4a - the peer sends; both tabs of the same account must show it, exactly once each.
verdict('TAB-4a', await round('TAB4A', w2, 'from the peer, two tabs open', WATCHED), { tab1: 1, tab2: 1 }, TWO_TABS);

// TAB-4b - the SECOND tab sends. It is very likely the follower, which is the interesting half.
verdict('TAB-4b', await round('TAB4B', w1b, 'sent from the second tab', WATCHED), { tab2: 1, peer: 1 }, TWO_TABS);

// TAB-4c - the FIRST tab sends straight after, the case where a rewind between tabs would show.
verdict('TAB-4c', await round('TAB4C', w1, 'sent from the first tab right after', WATCHED), { tab1: 1, peer: 1 }, TWO_TABS);

// The tab this script opened is this script's to close - it is the one piece of debris the runner's
// between-job repair cannot clear, because a stray tab is not an overlay and looks like a client.
await evaluate(w1, '(function () { if (window.__t2) { window.__t2.close(); window.__t2 = null; } return true; })()').catch(() => null);

// THE CODE IS STILL DERIVED, AND NOW THE SCRIPT ALSO ENDS. `beforeExit` only fires when the loop
// idles, and this one holds three CDP sockets that nothing closes - so the three rows were written
// at 07:54 on 2026-09-05 and the runner was still blocked at 08:00, with every verdict already on
// disk and nothing to show for it. `exitOnRecorded` is that same derivation, called instead of
// waited for; a bare `process.exit(0)` here would have reported `done` beside a recorded FAIL.
exitOnRecorded();
