/**
 * MSG-9 - the receiver is REALLY offline: A1 with its radios off.
 *
 * Why not a browser: `Network.emulateNetworkConditions` fails every new request within 3 ms and
 * still does NOT tear down the WebSocket already carrying messages, so the receiver kept receiving
 * and the check was testing nothing. Cutting the phone's radios is a genuine disconnection, and it
 * exercises the platform where losing signal actually happens. CDP reaches A1 over USB, which
 * survives the cut.
 *
 * Assertions: nothing arrives while the radios are down; exactly one copy after they come back.
 */
import { client, ensureChat, openConversation, send, countMessage, evaluate } from './chat.mjs';
import { watch, report, logcatSince, logcatNotable } from './watch.mjs';
import { mark } from './results.mjs';
import { execFileSync } from 'node:child_process';

const SERIAL = process.env.A1_USB || '2A251JEGR05373';
const adb = (...args) => execFileSync('adb', ['-s', SERIAL, ...args], { encoding: 'utf8' }).trim();

const w1 = await client(9224, 'canari-emse.fr');
const a1 = await client(9222);
await ensureChat(w1);
await openConversation(w1, 'PEER DISPLAY NAME');
if (!(await evaluate(a1, `!!document.querySelector('.chat-composer-editor')`))) {
  await ensureChat(a1);
  await openConversation(a1, 'PEER DISPLAY NAME');
}

const wA = await watch(w1, 'sender');
const wB = await watch(a1, 'a1-receiver');
const since = Date.now();

/** Radios down. Wifi and mobile data both, or the phone silently falls back to the other. */
adb('shell', 'svc', 'wifi', 'disable');
adb('shell', 'svc', 'data', 'disable');

const t0 = Date.now();
let offlineAt = null;
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 500));
  if (!(await evaluate(a1, 'navigator.onLine'))) {
    offlineAt = Date.now() - t0;
    break;
  }
}

const restore = () => {
  adb('shell', 'svc', 'wifi', 'enable');
  adb('shell', 'svc', 'data', 'enable');
};

if (offlineAt === null) {
  restore();
  console.log(JSON.stringify({ check: 'MSG-9', verdict: 'ABORT', why: 'the phone never went offline' }));
  process.exit(2);
}

const m = mark('MSG9A1');
await send(w1, `${m} sent while the phone had no radio`);
await new Promise((r) => setTimeout(r, 10000));
const whileOffline = await countMessage(a1, m);

restore();
const backAt = Date.now();
let arrived = null;
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  if ((await countMessage(a1, m)) > 0) {
    arrived = Date.now() - backAt;
    break;
  }
}
await new Promise((r) => setTimeout(r, 8000));

const finalCount = await countMessage(a1, m);
const obs = { sender: await report(wA), receiver: await report(wB) };
const native = { logcat: logcatNotable(await logcatSince(since)) };
const pass = whileOffline === 0 && finalCount === 1;

console.log(
  JSON.stringify(
    {
      check: 'MSG-9',
      marker: m,
      verdict: pass ? 'PASS' : 'FAIL',
      msToGoOffline: offlineAt,
      whileOffline,
      msToArriveAfterReconnect: arrived,
      finalCount,
      obs,
      native,
    },
    null,
    1
  )
);
process.exit(pass ? 0 : 1);
