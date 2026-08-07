/**
 * MSG-9 - the RECEIVER is offline when the message is sent.
 *
 * The message must not be lost and must not arrive twice: exactly one copy once the link is back.
 * The interesting failure is the second one - a client that both replays from history and takes
 * the live frame has two writers for one message, and only a duplicate check catches it.
 */
import { client, ensureChat, openConversation, send, countMessage, evaluate } from './chat.mjs';
import { watch, report } from './watch.mjs';
import { cut, link } from './net.mjs';
import { mark } from './results.mjs';

const w1 = await client(9224, 'canari-emse.fr');
const w2 = await client(9223, 'canari-emse.fr');
await ensureChat(w1);
await openConversation(w1, 'PEER DISPLAY NAME');
await ensureChat(w2);
await openConversation(w2, 'OWNER DISPLAY NAME');

const wA = await watch(w1, 'sender');
const wB = await watch(w2, 'receiver-offline');

const cutInfo = await cut(w2);
if (!cutInfo.severed) {
  console.log(JSON.stringify({ check: 'MSG-9', verdict: 'ABORT', why: 'the link never went down' }));
  await cutInfo.restore();
  process.exit(2);
}
const restore = cutInfo.restore;
await new Promise((r) => setTimeout(r, 2000));
const cutState = { ...(await link(w2)), msToSever: cutInfo.msToSever };

const m = mark('MSG9');
const t0 = Date.now();
await send(w1, `${m} sent while the receiver was offline`);

// It must NOT appear while the link is down - if it does, the "offline" was not offline.
await new Promise((r) => setTimeout(r, 8000));
const whileOffline = await countMessage(w2, m);

await restore();
const backAt = Date.now();
let arrived = null;
for (let i = 0; i < 80; i++) {
  await new Promise((r) => setTimeout(r, 500));
  if ((await countMessage(w2, m)) > 0) {
    arrived = Date.now() - backAt;
    break;
  }
}

// Settle, then count again: a duplicate usually lands moments after the first copy.
await new Promise((r) => setTimeout(r, 6000));
const finalCount = await countMessage(w2, m);
const senderCount = await countMessage(w1, m);

const obs = { sender: await report(wA), receiver: await report(wB) };
const pass = whileOffline === 0 && finalCount === 1 && senderCount === 1;

console.log(
  JSON.stringify(
    {
      check: 'MSG-9',
      marker: m,
      verdict: pass ? 'PASS' : 'FAIL',
      cutState,
      whileOffline,
      msToArriveAfterReconnect: arrived,
      finalCount,
      senderCount,
      totalMs: Date.now() - t0,
      obs,
    },
    null,
    1
  )
);
process.exit(pass ? 0 : 1);
