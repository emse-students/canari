/**
 * MSG-9 - the RECEIVER is offline when the message is sent.
 *
 * The message must not be lost and must not arrive twice: exactly one copy once the link is back.
 * The interesting failure is the second one - a client that both replays from history and takes
 * the live frame has two writers for one message, and only a duplicate check catches it.
 *
 * OFFLINE HERE MEANS AT THE GATEWAY, AND ONLY `cutHard` GETS THERE. A receiver is unreachable when
 * the server holds no socket for it; `cut()` fails new requests and leaves the established socket
 * untouched, which was measured on 2026-08-13 as sixty seconds of "offline" with the presence key
 * refreshed the whole way through. Under that cut this check sent to a receiver that took the
 * message live and reported a delivery defect that was its own doing, then - once it started
 * WAITING for the gateway to agree - reported INVALID for ever, because the agreement never came.
 * `cutHard` closes the socket as a dropped connection would; the gateway's `Drop` guard removes the
 * key, and the wait below is what turns that into a fact rather than an intention.
 */
import { APP_TAB, client, countMessage, ensureConversation, send } from '../chat.mjs';
import { gate, ignoringOfflineCut, report, watch } from '../watch.mjs';
import { armCut, cutHard, link } from './net.mjs';
import { awaitOffline, awaitOnline, whoIs } from './presence.mjs';
import { finish, mark } from '../results.mjs';
import { OWNER_NAME, PEER_NAME, PORTS } from '../names.mjs';

// PORTS AND NAMES FROM `names.mjs`, never as literals here. Both faults were repaired in `msg2.mjs`
// and left standing in this file: A1's port had already moved once, and a renamed account makes
// `openConversation` open NOTHING and the check then reports on whatever was left on screen.
// `ensureConversation` is used rather than `ensureChat` + `openConversation` for the same reason it
// exists - a composer proves a conversation is open, never WHICH one.
const w1 = await client(PORTS.W1, APP_TAB);
const w2 = await client(PORTS.W2, APP_TAB);
// ARMED FIRST, because the patch has to be in the document before the app opens its socket - so it
// costs a reload, and a reload has to happen before anything is opened or measured.
const armed = await armCut(w2);
await ensureConversation(w1, PEER_NAME);
await ensureConversation(w2, OWNER_NAME);

const wA = await watch(w1, 'sender');
const wB = await watch(w2, 'receiver-offline');

const cutInfo = await cutHard(w2);
const restore = cutInfo.restore;

// OFFLINE IS A FACT AT THE GATEWAY, NOT A SETTING IN THE BROWSER. The gateway deletes
// `user:online:{user}:{device}` when the connection task exits and lets it expire 20 s after the
// last frame either way, so its absence is the only statement of "this device is unreachable" that
// the thing doing the delivering agrees with.
const who = await whoIs(w2);
const offlineAfterMs = who ? await awaitOffline(who.user, who.device) : null;
if (offlineAfterMs === null) {
  await restore();
  // RECORDED, not just printed: a check that abandons in silence is indistinguishable from one that
  // passed, and this is the abandonment most likely to go unnoticed - the run looks orderly.
  finish('MSG-9', 'INVALID (the receiver never went offline at the gateway)', {
    marker: null,
    socketsClosed: cutInfo.socketsClosed,
  });
}

const cutState = {
  ...(await link(w2)),
  socketsClosed: cutInfo.socketsClosed,
  gatewayBackAfterMs: armed.gatewayBackAfterMs,
  offlineAfterMs,
};

const m = mark('MSG9');
const t0 = Date.now();
await send(w1, `${m} sent while the receiver was offline`);

// It must NOT appear while the link is down - if it does, the "offline" was not offline.
await new Promise((r) => setTimeout(r, 8000));
const whileOffline = await countMessage(w2, m);

await restore();
const backAt = Date.now();
// THE RETURN IS A FACT TOO. Lifting the emulation only permits a reconnect; the app has to make one,
// and a client that never comes back would otherwise read as a delivery loss - the same substitution
// this check has already made once in the other direction.
const backOnlineAfterMs = await awaitOnline(who.user, who.device, 60000);
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

// The RECEIVER is the client this check cut, so its disconnected fetches and its closed socket are
// the instrument, not the app. The SENDER was never touched and is judged raw.
const obs = { sender: await report(wA), receiver: ignoringOfflineCut(await report(wB)) };
const delivered =
  whileOffline === 0 && finalCount === 1 && senderCount === 1 && backOnlineAfterMs !== null;
const gated = gate(delivered ? 'PASS' : 'FAIL', { sender: obs.sender, receiver: obs.receiver });

// The full observation dump stays on stdout - it is what a reader needs when the verdict is bad -
// while the verdict itself goes to the record `run.mjs` builds its table from.
console.log(JSON.stringify({ check: 'MSG-9', marker: m, cutState, obs }, null, 1));

finish('MSG-9', gated.verdict, {
  ...gated.detail,
  marker: m,
  whileOffline,
  socketsClosed: cutInfo.socketsClosed,
  offlineAfterMs,
  backOnlineAfterMs,
  msToArriveAfterReconnect: arrived,
  finalCount,
  senderCount,
  elapsedMs: Date.now() - t0,
});
