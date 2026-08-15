/**
 * MSG-10 - the SENDER is offline.
 *
 * This one the browser can do honestly: `emulateNetworkConditions` fails every NEW request, which
 * is exactly what an outbound send is. (It does not tear down an already-open WebSocket, which is
 * why the mirror-image check MSG-9 needs a real radio cut on the phone.)
 *
 * Four things must hold, and the last is the one WP-ECHO-1 is about:
 *   1. the composer empties - the send is accepted locally;
 *   2. the sender shows its own message immediately, offline;
 *   3. nothing reaches the peer until the link is back, then exactly one copy;
 *   4. the sender still has it after a RELOAD - MLS gives no echo of your own message, so the
 *      optimistic update is the only writer it ever gets.
 *
 * AND THE DELAY IS ITS OWN VERDICT, added 2026-08-14 after this check reported a loss that had not
 * happened. It waited 90 s, saw nothing, and recorded `copiesOnReceiver: 0`; the message was
 * delivered at 98 s and the server's `[SEND] ... DONE queued=2 realtime=2` proves it. The four
 * assertions above are about CORRECTNESS and still decide FAIL; how long the queue took to drain is
 * a separate question with a separate answer, `SLOW`, and a separate cause - which `msToReconnect`
 * now names rather than leaving to be guessed.
 */
import { client, ensureConversation, send, countMessage, evaluate } from './chat.mjs';
import { gate, ignoringOfflineCut, longestSilence, report, watch } from './watch.mjs';
import { cut } from './net.mjs';
import { finish, mark } from './results.mjs';
import { OWNER_NAME, PEER_NAME, PORTS } from './names.mjs';

// Ports and display names come from `names.mjs`, never as literals - see the header of `msg2.mjs`
// for what a stale literal of either costs. `ensureConversation` proves WHICH conversation is open.
const w1 = await client(PORTS.W1, 'canari-emse.fr');
const w2 = await client(PORTS.W2, 'canari-emse.fr');
await ensureConversation(w1, PEER_NAME);
await ensureConversation(w2, OWNER_NAME);

const wA = await watch(w1, 'sender-offline');
const wB = await watch(w2, 'receiver');

const info = await cut(w1);
if (!info.severed) {
  await info.restore();
  finish('MSG-10', 'INVALID (the link never went down)', { marker: null });
}

const m = mark('MSG10');
let sendError = null;
try {
  await send(w1, `${m} sent from an offline client`);
} catch (e) {
  sendError = e.message;
}

await new Promise((r) => setTimeout(r, 3000));
const offlineState = {
  onSender: await countMessage(w1, m),
  onReceiver: await countMessage(w2, m),
  composerEmpty: await evaluate(w1, `!document.querySelector('.chat-composer-editor').innerText.trim()`),
};

await info.restore();
const backAt = Date.now();

/**
 * "NEVER ARRIVED" AND "ARRIVED LATE" ARE DIFFERENT DEFECTS AND MUST NOT SHARE A VERDICT.
 *
 * This loop used to stop at 90 s and report `copiesOnReceiver: 0`, which reads as a LOST MESSAGE -
 * the most serious thing this campaign can claim. On 2026-08-14 it claimed it wrongly: the message
 * was delivered at 98 s, eight seconds after the loop gave up, and the server's own `[SEND] ... DONE
 * queued=2 realtime=2` proves it. A check that cannot tell a loss from a delay sends its reader
 * hunting for a dropped frame when the fault is in the transport coming back.
 *
 * So there are now TWO horizons. `BUDGET_MS` is what a user should ever wait for a queued message
 * after the link returns; `HARD_MS` is how long this check keeps looking before it is entitled to
 * say the word "lost". Between them the verdict is SLOW, and the record carries the real figure.
 */
const BUDGET_MS = 30_000;
const HARD_MS = 180_000;

/**
 * WHEN THE SENDER'S SOCKET CAME BACK - the evidence that separates the two causes this check cannot
 * otherwise tell apart, sampled in the SAME loop rather than asked for afterwards.
 *
 * A slow delivery is either an outbox sitting on a message over a healthy link, or a link that was
 * not healthy yet. Those need opposite fixes and `msToDrainAfterReconnect` alone points at neither.
 *
 * READ OFF THE UI, not off an app global. There is no exposed connection flag - that is exactly what
 * made WP-RECONNECT-1 unreadable from outside - but the app RENDERS its verdict as a pill, which is
 * a fact and is what a user sees. `circuit.mjs` established the same reading.
 */
const PILL = `(function () {
  return Array.prototype.slice.call(document.querySelectorAll('span, div, button'))
    .map(function (e) { return (e.innerText || '').trim(); })
    .filter(function (t) { return /^(Hors-ligne|Connecte|Connecté)$/i.test(t); })[0] || null;
})()`;

let drained = null;
let reconnectedAfterMs = null;
while (Date.now() - backAt < HARD_MS) {
  if (reconnectedAfterMs === null) {
    const pill = await evaluate(w1, PILL).catch(() => null);
    if (pill && /^connect/i.test(pill)) reconnectedAfterMs = Date.now() - backAt;
  }
  if ((await countMessage(w2, m)) > 0) {
    drained = Date.now() - backAt;
    break;
  }
  await new Promise((r) => setTimeout(r, 1000));
}

await new Promise((r) => setTimeout(r, 6000));

const afterReconnect = {
  onSender: await countMessage(w1, m),
  onReceiver: await countMessage(w2, m),
};

// The WP-ECHO-1 predicate: does the sender's own message survive a load?
await w1.send('Page.reload');
await new Promise((r) => setTimeout(r, 3000));
await ensureConversation(w1, PEER_NAME);
await new Promise((r) => setTimeout(r, 4000));
const afterReload = await countMessage(w1, m);

// The SENDER is the client this check cut; its disconnected requests are the instrument. The
// RECEIVER was never touched and is judged raw.
const obs = { sender: ignoringOfflineCut(await report(wA)), receiver: await report(wB) };

/** Everything except the DELAY: the message exists, exactly once, on both sides, and survives a load. */
const delivered =
  sendError === null &&
  offlineState.onSender === 1 &&
  offlineState.onReceiver === 0 &&
  afterReconnect.onSender === 1 &&
  afterReconnect.onReceiver === 1 &&
  afterReload === 1;

// THREE OUTCOMES, NOT TWO. `FAIL` is now reserved for a message that never arrived or arrived
// wrong - the loss claim - and a delivery that took longer than a user should ever wait earns
// `SLOW`, which is a different Work Package with a different owner. Collapsing them cost a false
// loss report on 2026-08-14; keeping them apart is what makes either believable.
const verdict = !delivered ? 'FAIL' : drained !== null && drained <= BUDGET_MS ? 'PASS' : 'SLOW';

console.log(
  JSON.stringify(
    { check: 'MSG-10', marker: m, msToSever: info.msToSever, offlineState, afterReconnect, obs },
    null,
    1
  )
);

// RECORDED, not merely exited. This script printed its verdict and called `process.exit` - so the
// phase table showed eleven rows for twelve scripts and the silent one read as a pass, which is the
// exact failure `finish` exists to make impossible. Seen again on 2026-08-13, in a run where every
// other check had already been converted.
const gated = gate(verdict, { sender: obs.sender, receiver: obs.receiver });

finish('MSG-10', gated.verdict, {
  ...gated.detail,
  marker: m,
  sendError,
  msToSever: info.msToSever,
  copiesOnSenderWhileOffline: offlineState.onSender,
  copiesOnReceiverWhileOffline: offlineState.onReceiver,
  composerEmpty: offlineState.composerEmpty,
  budgetMs: BUDGET_MS,
  msToDrainAfterReconnect: drained,
  // THE DISCRIMINATOR, next to the number it explains. `msToReconnect` close to zero with a large
  // `msToDrainAfterReconnect` accuses the OUTBOX; the two close together accuse the TRANSPORT and
  // exonerate it. `null` means the pill never read connected inside the hard deadline, which is
  // itself the answer.
  msToReconnect: reconnectedAfterMs,
  // THE HOLE, AS A NUMBER - WP-RECONNECT-2. A stalled recovery is made of ABSENT lines, so no
  // classifier bucket can show it: the 98 s of silence on 2026-08-14 was visible only to a human
  // reading two adjacent entries and noticing their clocks. `longestSilence` names the gap and the
  // two lines that bracket it, which is exactly the evidence that says whether the socket close
  // opened the hole or closed it - the question the previous capture could not answer at all.
  senderLongestSilence: longestSilence(obs.sender.timeline),
  senderWsDuringCut: obs.sender.wsEventsDuringCut,
  senderTimeline: obs.sender.timeline,
  copiesOnSender: afterReconnect.onSender,
  copiesOnReceiver: afterReconnect.onReceiver,
  copiesOnSenderAfterReload: afterReload,
});
