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
 */
import { client, ensureConversation, send, countMessage, evaluate } from './chat.mjs';
import { dirtOf, ignoringOfflineCut, report, watch } from './watch.mjs';
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
let drained = null;
for (let i = 0; i < 90; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  if ((await countMessage(w2, m)) > 0) {
    drained = Date.now() - backAt;
    break;
  }
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
const delivered =
  sendError === null &&
  offlineState.onSender === 1 &&
  offlineState.onReceiver === 0 &&
  afterReconnect.onSender === 1 &&
  afterReconnect.onReceiver === 1 &&
  afterReload === 1;

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
finish('MSG-10', delivered ? (obs.sender.clean && obs.receiver.clean ? 'PASS' : 'PASS-DIRTY') : 'FAIL', {
  marker: m,
  sendError,
  msToSever: info.msToSever,
  copiesOnSenderWhileOffline: offlineState.onSender,
  copiesOnReceiverWhileOffline: offlineState.onReceiver,
  composerEmpty: offlineState.composerEmpty,
  msToDrainAfterReconnect: drained,
  copiesOnSender: afterReconnect.onSender,
  copiesOnReceiver: afterReconnect.onReceiver,
  copiesOnSenderAfterReload: afterReload,
  senderClean: obs.sender.clean,
  receiverClean: obs.receiver.clean,
  senderDirt: dirtOf(obs.sender),
  receiverDirt: dirtOf(obs.receiver),
});
