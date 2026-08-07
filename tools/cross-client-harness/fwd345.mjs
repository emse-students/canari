/**
 * FWD-3, FWD-4, FWD-5 - the three forward shapes WP-FWD-1 has not been tried against.
 *
 * FWD-3  the sender loses the network the instant the picker closes. The forward is already
 *        accepted locally, so the outbox is the only thing that can still deliver it.
 * FWD-4  the phone is sent to the home screen ~200 ms after the forward. On Android the send may
 *        finish in the background service, which is a different code path from the foreground one.
 * FWD-5  the target conversation has never been opened in this session, so the sender holds no
 *        loaded state for it - the shape the original prod report came from.
 *
 * Each records whether `POST /api/mls/send` happened at all: no request means the client dropped
 * it, a 201 means the receiver did. That is the fork the whole diagnosis turns on.
 */
import {
  client,
  ensureChat,
  openChannel,
  openConversation,
  send,
  clickBubbleAction,
  realClick,
  until,
  awaitMessage,
  countMessage,
  evaluate,
} from './chat.mjs';
import { watch, report } from './watch.mjs';
import { cut } from './net.mjs';
import { mark } from './results.mjs';
import { execFileSync } from 'node:child_process';

const SERIAL = process.env.A1_USB || '2A251JEGR05373';
const adb = (...a) => execFileSync('adb', ['-s', SERIAL, ...a], { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Drains the `/api/mls/send` requests a watched client made, without clearing the buffer. */
function sendsOf(cx) {
  const out = [];
  const pending = new Map();
  for (const e of cx.events) {
    const p = e.params;
    if (e.method === 'Network.requestWillBeSent' && String(p.request.url).includes('/api/mls/send'))
      pending.set(p.requestId, p.request.method);
    if (e.method === 'Network.responseReceived' && pending.has(p.requestId))
      out.push(`${pending.get(p.requestId)} -> ${p.response.status}`);
    if (e.method === 'Network.loadingFailed' && pending.has(p.requestId))
      out.push(`FAILED ${p.errorText}`);
  }
  return out;
}

/** Posts `marker` into the channel and opens the forward picker on it. */
async function forwardFromChannel(cx, marker) {
  await openChannel(cx);
  await send(cx, marker);
  await awaitMessage(cx, marker, 25000);
  await sleep(800);
  await clickBubbleAction(cx, marker, 'Transférer');
  await until(cx, `!!document.querySelector('[role=dialog]')`, 15000);
  await realClick(cx, 'text=PEER DISPLAY NAME');
  await until(cx, `!document.querySelector('[role=dialog]')`, 15000);
}

const w1 = await client(9224, 'canari-emse.fr');
const w2 = await client(9223, 'canari-emse.fr');
const a1 = await client(9222);
await ensureChat(w2);
await openConversation(w2, 'OWNER DISPLAY NAME');

const results = [];

// ---------------------------------------------------------------- FWD-3
{
  const m = mark('FWD3');
  const o1 = await watch(w1, 'FWD3-W1');
  const o2 = await watch(w2, 'FWD3-W2');
  await forwardFromChannel(w1, m);

  const info = await cut(w1);
  await sleep(9000);
  const whileOffline = await countMessage(w2, m);
  await info.restore();

  const at = Date.now();
  const arrived = await awaitMessage(w2, m, 60000).then(() => Date.now() - at, () => null);
  await sleep(3000);
  results.push({
    check: 'FWD-3',
    marker: m,
    severed: info.severed,
    whileOffline,
    msAfterReconnect: arrived,
    onReceiver: await countMessage(w2, m),
    sends: sendsOf(w1),
    obs: { w1: await report(o1), w2: await report(o2) },
  });
}

// ---------------------------------------------------------------- FWD-4
{
  const m = mark('FWD4');
  const o2 = await watch(w2, 'FWD4-W2');
  const oa = await watch(a1, 'FWD4-A1');
  if (!(await evaluate(a1, `!!document.querySelector('.chat-composer-editor')`))) {
    await ensureChat(a1);
    await openConversation(a1, 'PEER DISPLAY NAME');
  }
  // No channel hop on the phone: send in the DM and background it at once. What FWD-4 is really
  // asking is whether a send survives the app leaving the foreground mid-flight.
  await send(a1, `${m} then straight to the home screen`);
  await sleep(200);
  adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');

  const at = Date.now();
  const arrived = await awaitMessage(w2, m, 60000).then(() => Date.now() - at, () => null);
  adb('shell', 'am', 'start', '-n', 'fr.emse.canari/fr.emse.canari.MainActivity');
  await sleep(4000);
  results.push({
    check: 'FWD-4',
    marker: m,
    msToArrive: arrived,
    onReceiver: await countMessage(w2, m),
    onSender: await countMessage(a1, m),
    obs: { a1: await report(oa), w2: await report(o2) },
  });
}

// ---------------------------------------------------------------- FWD-5
{
  const m = mark('FWD5');
  // A fresh session: reload, then go straight to the channel. The DM is never opened before the
  // forward, so the sender holds no loaded state for the conversation it is forwarding into.
  await w1.send('Page.reload');
  await sleep(6000);
  await ensureChat(w1);
  const o1 = await watch(w1, 'FWD5-W1');
  const o2 = await watch(w2, 'FWD5-W2');
  await forwardFromChannel(w1, m);

  const at = Date.now();
  const arrived = await awaitMessage(w2, m, 60000).then(() => Date.now() - at, () => null);
  await sleep(3000);
  results.push({
    check: 'FWD-5',
    marker: m,
    msToArrive: arrived,
    onReceiver: await countMessage(w2, m),
    sends: sendsOf(w1),
    obs: { w1: await report(o1), w2: await report(o2) },
  });
}

for (const r of results) {
  const ok = r.onReceiver === 1;
  console.log(`${r.check} ${ok ? 'PASS' : 'FAIL'}`);
  console.log(JSON.stringify(r, null, 1));
}
process.exit(results.every((r) => r.onReceiver === 1) ? 0 : 1);
