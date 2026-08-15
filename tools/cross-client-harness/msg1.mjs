/**
 * MSG-1: W1 -> W2, both foreground, DM, plain text. One copy, correct author, and it STAYS.
 *
 *   node msg1.mjs           steady state - the conversation is already open on both sides
 *   node msg1.mjs --cold    the FIRST message into a conversation just opened on the receiver
 *
 * WHY TWO MODES AND NOT ONE THRESHOLD. Measured 2026-08-13, four consecutive sends with both ends
 * open throughout: 2142 ms, then 186, 192, 174. The sender's own echo was 8-17 ms in every one of
 * them, so encrypting and rendering locally is never the cost - the whole difference sits on the
 * receiver, and only for the first message after it opens the conversation.
 *
 * A single check with a single 2 s threshold therefore answered a question nobody asked: it was
 * lenient enough that a tenfold regression in steady-state delivery (180 ms -> 1900 ms) would still
 * have passed, while flagging SLOW for a cost that belongs to opening a conversation. Two questions,
 * two verdicts, two thresholds - and `--cold` exists so that 2 s stays VISIBLE on the dashboard
 * rather than being warmed away, because it is a real thing a user waits for.
 *
 * REWRITTEN 2026-08-12 to trace CONTINUOUSLY. The two-reading version returned `latencyMs: 987` and
 * `copiesOnReceiver: 0` in the same record - both honest, and between them the message had been
 * rendered and then dropped by a stale page overwrite. A check whose failure mode is DISAPPEARANCE
 * cannot be built from a wait plus a later count; it has to sample across the window and, when the
 * marker is absent at the end, name the mechanism rather than report a bare zero.
 */
import {
  classifyDisappearance,
  client,
  countMessage,
  evaluate,
  openDM,
  send,
  traceArrival,
} from './chat.mjs';
import { OWNER_NAME, PEER_NAME, PORTS } from './names.mjs';
import { mark, record } from './results.mjs';
import { consoleLines, gate, report, watch } from './watch.mjs';

const w1 = await client(PORTS.W1);
const w2 = await client(PORTS.W2);

// `openDM` for BOTH, because it navigates first. This used to `goto('/chat')` for W2 only and call
// `openConversation` on W1 bare, which silently depended on W1 already sitting on /chat - true only
// because whatever ran before had left it there. Started from /communities the sidebar holds
// CHANNELS, the peer's name is not in it, and the check dies in a 20 s locator timeout that looks
// nothing like its cause. A check may not inherit a precondition from whatever ran before it.
const opened = await openDM(w2, OWNER_NAME);
await openDM(w1, PEER_NAME);

// OBSERVATION IS PART OF THE CHECK, not a debugging step for when it fails. A verdict is PASS only
// if the assertions hold AND the run is clean - several shipped defects came out of the noise of a
// check that passed, which is why the dump at the end is raw and unclassified rather than filtered.
// Attached AFTER both conversations are open, so the boot chatter of two clients does not bury the
// handful of lines this check is actually about.
const wa = await watch(w1, 'W1');
const wb = await watch(w2, 'W2');

// STEADY STATE IS REACHED BY SENDING, not by waiting: the receiver's first-message cost is paid by
// whatever message arrives first, so one unmeasured send buys it. Its arrival is waited for rather
// than slept through - a fixed sleep would either be too short (and charge this run for the warm-up
// it was meant to absorb) or too long for no reason.
const COLD = process.argv.includes('--cold');
if (!COLD) {
  const warm = mark('MSG1WARM');
  await send(w1, `MSG-1 warm-up ${warm}`);
  await traceArrival(w2, warm, { timeoutMs: 20000, settleMs: 0 });
}

const marker = mark('MSG1');
const before2 = await countMessage(w2, marker);
const at = await send(w1, `MSG-1 baseline ${marker}`);

// The trace runs past first sight on purpose: `settleMs` is what turns "it arrived" into "it stayed",
// and a duplicate landing 500 ms later is caught by the same window rather than by a separate sleep.
const trace = await traceArrival(w2, marker, { timeoutMs: 20000, settleMs: 3500 });
const last = trace.last;

let disappearance = null;
if (!last || last.count === 0) {
  // `openDM` IS "navigate then open", so calling it here is the whole reopen. The previous version
  // spelt those two steps out with `goto` + `openConversation` - neither of which this file
  // imports, so the callback threw `ReferenceError` instead of classifying. It never showed,
  // because this branch only runs when the message is MISSING: the one path that exists to explain
  // a real defect was the one path guaranteed to crash. Reusing the primitive removes both the
  // duplication and the chance of it drifting again.
  disappearance = await classifyDisappearance(w2, marker, () => openDM(w2, OWNER_NAME));
}

const onW2 = last ? last.count : 0;
const onW1 = await countMessage(w1, marker);
const author = await evaluate(
  w2,
  `(function () {
    var needle = ${JSON.stringify(marker)};
    var leaf = [].filter.call(document.querySelectorAll('main *, [role=main] *, body *'), function (e) {
      return e.children.length === 0 && (e.textContent || '').indexOf(needle) !== -1;
    })[0];
    if (!leaf) return null;
    var row = leaf;
    for (var i = 0; i < 6 && row.parentElement; i++) { row = row.parentElement; if (row.innerText.length > 120) break; }
    return row.innerText.replace(/\\s+/g, ' ').trim().slice(0, 250);
  })()`,
);

// PASS requires the message to have arrived, arrived FAST, still be there at the end, and be there
// exactly once on both sides. `lost` is fatal even when it comes back: a message that flickers is
// the defect this check was rewritten to see.
// The budget is per MODE, and both are set from measurement rather than from a round number.
// Steady state runs at ~180 ms and `traceArrival` samples every 250 ms, so 1000 ms is four sample
// periods of headroom and still catches a regression long before a user could call it slow. Cold is
// budgeted at 3000 ms against a measured ~2140 ms: enough not to flap, tight enough that the
// conversation-open path cannot quietly get worse.
const budgetMs = COLD ? 3000 : 1000;
const arrived = trace.firstSeen !== null;
const verdict = !arrived
  ? 'FAIL'
  : trace.lost !== null
    ? 'FAIL'
    : onW2 !== 1 || onW1 !== 1
      ? 'FAIL'
      : trace.firstSeen < budgetMs
        ? 'PASS'
        : 'SLOW';

// THE OBSERVATION DECIDES SOMETHING. This file already said the words - "a verdict is PASS only if
// the assertions hold AND the run is clean" - forty lines above, and then formed the verdict from
// `trace` alone and dumped the console for a human to read. `gate` is that sentence, executed.
//
// THE RAW LINES ARE TAKEN FIRST. `report` DRAINS the event buffer (`cx.events.length = 0`), and
// `consoleLines` reads that same buffer - so classifying before capturing leaves the dump below
// empty, removing the evidence exactly when the verdict is bad and someone needs it.
const raw = [
  ['W1', consoleLines(wa.cx)],
  ['W2', consoleLines(wb.cx)],
];
const obs = { W1: await report(wa), W2: await report(wb) };
const gated = gate(verdict, obs);

record(COLD ? 'MSG-1-cold' : 'MSG-1', gated.verdict, {
  mode: COLD ? 'first message into a freshly opened conversation' : 'steady state',
  ...gated.detail,
  budgetMs,
  marker,
  latencyMs: trace.firstSeen,
  lostAgainMs: trace.lost,
  regainedMs: trace.regained,
  sentAt: at,
  copiesOnReceiver: onW2,
  copiesOnSender: onW1,
  before2,
  openedOnW2: opened,
  samples: trace.samples.length,
  endState: last,
  disappearance,
  authorContext: author,
});

for (const [label, lines] of raw) {
  console.log(`\n===== ${label}: ${lines.length} console lines =====`);
  for (const l of lines) console.log(`  ${l}`);
}

w1.close();
w2.close();
