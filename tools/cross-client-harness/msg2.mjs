/**
 * MSG-2: W2 -> A1, phone app in the FOREGROUND. DM. Expect in-app delivery, exactly one copy.
 *
 * REPAIRED 2026-08-13. It carried three copies of things that live in one place:
 *
 *   - the ports, as literals - and A1's had moved from 9222 to 9333, so every run connected to a
 *     port nothing was listening on and died in `ECONNREFUSED`. A stale literal does not degrade,
 *     it takes the whole check out, and it took the check out silently because nothing re-reads a
 *     script that is not being run;
 *   - the two display names, as literals, which `names.mjs` exists to be the only source of - a
 *     renamed account would have made this open NOTHING and then report on whatever was on screen;
 *   - `goto` + a 3 s sleep + `openConversation`, which is what `openDM` already is.
 *
 * The stale comment about a fix "not deployed yet" went with them: it named a commit that shipped.
 */
import { client, countMessage, evaluate, openDM, send, traceArrival } from './chat.mjs';
import { OWNER_NAME, PEER_NAME, PORTS } from './names.mjs';
import { finish, mark } from './results.mjs';
import { consoleLines, gate, report, watch } from './watch.mjs';

const w2 = await client(PORTS.W2);
const a1 = await client(PORTS.A1);

// A1 holds the OWNER account, so it reaches the shared DM by the PEER's name - the same way W1
// does. W2 is the peer and looks for the owner.
const openedA1 = await openDM(a1, PEER_NAME);
await openDM(w2, OWNER_NAME);

const wa = await watch(w2, 'W2');
const wb = await watch(a1, 'A1');

const marker = mark('MSG2');
const before = await countMessage(a1, marker);
const at = await send(w2, `MSG-2 phone foreground ${marker}`);

// Traced rather than awaited once: "arrived" and "stayed" are different claims, and a push
// duplicate landing after the in-app copy is exactly what this check is meant to catch - which a
// single `awaitMessage` returning on first sight cannot see.
const trace = await traceArrival(a1, marker, { timeoutMs: 25000, settleMs: 4000 });

const onA1 = trace.last ? trace.last.count : await countMessage(a1, marker);
const visibility = await evaluate(a1, 'document.visibilityState');

// `visible` is a PRECONDITION, not a detail: this check is defined as "app in the foreground", so a
// backgrounded phone does not make it fail, it makes it meaningless. Reported as its own verdict so
// a future reader is sent to the phone rather than to the delivery path.
const verdict =
  visibility !== 'visible'
    ? 'INVALID (phone not in the foreground)'
    : trace.firstSeen === null
      ? 'FAIL'
      : trace.lost !== null || onA1 !== 1
        ? 'FAIL'
        : 'PASS';

// THE DUMP FIRST, THE VERDICT LAST. `finish` exits the process, so anything printed after it would
// never appear - and this dump is the whole evidence when the verdict is bad.
//
// Captured before `report`, which drains the buffer both of them read. This check used to print the
// lines and form its verdict without ever consulting them: two observers attached, and nothing they
// saw could change the answer.
for (const [label, cx] of [
  ['W2', wa.cx],
  ['A1', wb.cx],
]) {
  const lines = consoleLines(cx);
  console.log(`\n===== ${label}: ${lines.length} console lines =====`);
  for (const l of lines) console.log(`  ${l}`);
}

const gated = gate(verdict, { W2: await report(wa), A1: await report(wb) });

w2.close();
a1.close();

// This used to `record` and never exit, so the runner printed `msg2.mjs  done` in the same table as
// a recorded `FAIL MSG-2` - the two halves of one run contradicting each other.
finish('MSG-2', gated.verdict, {
  ...gated.detail,
  marker,
  latencyMs: trace.firstSeen,
  lostAgainMs: trace.lost,
  copiesOnPhone: onA1,
  before,
  phoneVisibility: visibility,
  openedA1,
  sentAt: at,
  samples: trace.samples.length,
});
