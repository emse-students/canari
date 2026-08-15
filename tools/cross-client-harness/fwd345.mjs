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
  ensureConversation,
  send,
  clickBubbleAction,
  realClick,
  until,
  awaitMessage,
  countMessage,
  evaluate,
  awaitAppReady,
  settledCount,
} from './chat.mjs';
import { gate, ignoringOfflineCut, report, watch } from './watch.mjs';
import { cut } from './net.mjs';
import { mark, record } from './results.mjs';
import { execFileSync } from 'node:child_process';
import { PEER_NAME, PORTS, peerNameFor } from './names.mjs';
import { serial } from './phone.mjs';

// RESOLVED, never hard-coded: this phone's USB link drops on its own and comes back under the
// wireless entry, so a literal serial names a transport that may no longer exist.
const SERIAL = process.env.A1_USB || serial();
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
  await clickBubbleAction(cx, marker, 'Transférer');
  await until(cx, `!!document.querySelector('[role=dialog]')`, 15000);
  await realClick(cx, `text=${peerNameFor('W1')}`);
  await until(cx, `!document.querySelector('[role=dialog]')`, 15000);
}

const w1 = await client(9224, 'canari-emse.fr');
const w2 = await client(9223, 'canari-emse.fr');
const a1 = await client(PORTS.A1);
await ensureChat(w2);
await openConversation(w2, peerNameFor('W2'));

const results = [];

// ---------------------------------------------------------------- FWD-3
{
  const m = mark('FWD3');
  const o1 = await watch(w1, 'FWD3-W1');
  const o2 = await watch(w2, 'FWD3-W2');
  await forwardFromChannel(w1, m);

  const info = await cut(w1);
  // THIS ONE IS THE EXPERIMENT AND STAYS A DURATION. The assertion is that nothing arrives while the
  // sender is severed, which is an absence: there is no fact to poll, only a window to hold open.
  // Nine seconds is the window over which a healthy round trip would have completed several times.
  await sleep(9000);
  const whileOffline = await countMessage(w2, m);
  await info.restore();

  const at = Date.now();
  const arrived = await awaitMessage(w2, m, 60000).then(() => Date.now() - at, () => null);
  const settled = await settledCount(w2, m);
  results.push({
    check: 'FWD-3',
    marker: m,
    severed: info.severed,
    whileOffline,
    msAfterReconnect: arrived,
    onReceiver: settled.count,
    countSettled: settled.settled,
    sends: sendsOf(w1),
    // W1 IS THE CLIENT THIS CHECK CUT, so its own disconnected fetches are the experiment working
    // rather than the app failing. W2 was never touched and is judged as it is.
    obs: { W1: ignoringOfflineCut(await report(o1)), W2: await report(o2) },
  });
}

// ---------------------------------------------------------------- FWD-4
{
  const m = mark('FWD4');
  const o2 = await watch(w2, 'FWD4-W2');
  const oa = await watch(a1, 'FWD4-A1');
  // PROVEN, not assumed - a composer says a conversation is open, never which. See `ensureConversation`.
  await ensureConversation(a1, PEER_NAME);
  // No channel hop on the phone: send in the DM and background it at once. What FWD-4 is really
  // asking is whether a send survives the app leaving the foreground mid-flight.
  await send(a1, `${m} then straight to the home screen`);
  // THE ONLY DURATION FWD-4 HAS, AND IT IS THE EXPERIMENT ITSELF: the check asks whether a send
  // survives the app leaving the foreground MID-FLIGHT, so the window between the two lines is the
  // condition under test. Waiting for a fact here would wait for the very thing being interrupted.
  await sleep(200);
  adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');

  const at = Date.now();
  const arrived = await awaitMessage(w2, m, 60000).then(() => Date.now() - at, () => null);
  adb('shell', 'am', 'start', '-n', 'fr.emse.canari/fr.emse.canari.MainActivity');
  await awaitAppReady(a1);
  const onReceiver = await settledCount(w2, m);
  const onSender = await settledCount(a1, m);
  results.push({
    check: 'FWD-4',
    marker: m,
    msToArrive: arrived,
    onReceiver: onReceiver.count,
    onSender: onSender.count,
    countSettled: onReceiver.settled && onSender.settled,
    obs: { A1: await report(oa), W2: await report(o2) },
  });
}

// ---------------------------------------------------------------- FWD-5
{
  const m = mark('FWD5');
  // A fresh session: reload, then go straight to the channel. The DM is never opened before the
  // forward, so the sender holds no loaded state for the conversation it is forwarding into.
  await w1.send('Page.reload');
  await awaitAppReady(w1);
  await ensureChat(w1);
  const o1 = await watch(w1, 'FWD5-W1');
  const o2 = await watch(w2, 'FWD5-W2');
  await forwardFromChannel(w1, m);

  const at = Date.now();
  const arrived = await awaitMessage(w2, m, 60000).then(() => Date.now() - at, () => null);
  const settled = await settledCount(w2, m);
  results.push({
    check: 'FWD-5',
    marker: m,
    countSettled: settled.settled,
    msToArrive: arrived,
    onReceiver: settled.count,
    sends: sendsOf(w1),
    obs: { W1: await report(o1), W2: await report(o2) },
  });
}

// THESE THREE NOW REACH THE RECORD, AND THEIR OBSERVATION DECIDES SOMETHING.
//
// Two faults in the four lines this replaces. The verdict was printed to stdout and never `record`ed,
// so `results.ndjson` - the thing `run.mjs` reads back, because stdout scrolls past and several
// scripts print a raw dump after their verdict - held no row for FWD-3, FWD-4 or FWD-5 at all: three
// checks that could only ever be reported as "done". And each one had built a full `obs` from two
// watchers that could not change the answer, which is the campaign's rule stated and then skipped.
//
// The assertion itself is unchanged: exactly one copy on the receiver. `countSettled` is reported but
// deliberately not fatal - it says the count stopped moving, which a slow arrival can fail honestly.
for (const r of results) {
  const gated = gate(r.onReceiver === 1 ? 'PASS' : 'FAIL', r.obs);
  console.log(`${r.check} ${gated.verdict}`);
  console.log(JSON.stringify(r, null, 1));
  record(r.check, gated.verdict, { ...r, ...gated.detail, obs: undefined });
}
process.exit(results.every((r) => r.onReceiver === 1) ? 0 : 1);
