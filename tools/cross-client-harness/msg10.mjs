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
import { client, ensureChat, openConversation, send, countMessage, evaluate } from './chat.mjs';
import { watch, report } from './watch.mjs';
import { cut } from './net.mjs';
import { mark } from './results.mjs';

const w1 = await client(9224, 'canari-emse.fr');
const w2 = await client(9223, 'canari-emse.fr');
await ensureChat(w1);
await openConversation(w1, 'PEER DISPLAY NAME');
await ensureChat(w2);
await openConversation(w2, 'OWNER DISPLAY NAME');

const wA = await watch(w1, 'sender-offline');
const wB = await watch(w2, 'receiver');

const info = await cut(w1);
if (!info.severed) {
  await info.restore();
  console.log(JSON.stringify({ check: 'MSG-10', verdict: 'ABORT', why: 'the link never went down' }));
  process.exit(2);
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
await ensureChat(w1);
await openConversation(w1, 'PEER DISPLAY NAME');
await new Promise((r) => setTimeout(r, 4000));
const afterReload = await countMessage(w1, m);

const obs = { sender: await report(wA), receiver: await report(wB) };
const pass =
  sendError === null &&
  offlineState.onSender === 1 &&
  offlineState.onReceiver === 0 &&
  afterReconnect.onSender === 1 &&
  afterReconnect.onReceiver === 1 &&
  afterReload === 1;

console.log(
  JSON.stringify(
    {
      check: 'MSG-10',
      marker: m,
      verdict: pass ? 'PASS' : 'FAIL',
      sendError,
      msToSever: info.msToSever,
      offlineState,
      msToDrainAfterReconnect: drained,
      afterReconnect,
      afterReload,
      obs,
    },
    null,
    1
  )
);
process.exit(pass ? 0 : 1);
