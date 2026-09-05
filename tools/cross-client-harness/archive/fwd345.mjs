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
  APP_TAB,
  awaitAppReady,
  awaitMessage,
  clickBubbleAction,
  client,
  countMessage,
  ensureChat,
  ensureConversation,
  evaluate,
  openChannel,
  openConversation,
  realClick,
  reloadAndWait,
  send,
  settledCount,
  until,
} from '../chat.mjs';
import { gate, ignoringOfflineCut, report, watch } from '../watch.mjs';
// The venue channel's history carries three mentions of accounts that do not exist, and every
// one of these three checks opens it. See `stranded.mjs` for the allowlist and why the fixture
// is left in place; none of these rows has an opinion about user profiles.
import { ignoringStrandedMentions } from '../stranded.mjs';
import { cut } from './net.mjs';
import { mark, record } from '../results.mjs';
import { execFileSync } from 'node:child_process';
import { PEER_NAME, PORTS, peerNameFor } from '../names.mjs';
import { serial } from '../phone.mjs';

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

const w1 = await client(PORTS.W1, APP_TAB);
const w2 = await client(PORTS.W2, APP_TAB);
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
    // The `check` field is NOT free to reuse: `results.mjs` stamps it with the RUNNER's
    // filename, and a detail of the same name overwrites it. These three held the row id -
    // which `id` already carries - so `rows.mjs` read "its runner no longer exists" for all
    // three, a false alarm in the one tool that settles board-versus-ledger. Dropped, not
    // renamed: nothing was being said that the row did not already say.
    marker: m,
    severed: info.severed,
    whileOffline,
    msAfterReconnect: arrived,
    onReceiver: settled.count,
    countSettled: settled.settled,
    sends: sendsOf(w1),
    // W1 IS THE CLIENT THIS CHECK CUT, so its own disconnected fetches are the experiment working
    // rather than the app failing. W2 was never touched and is judged as it is.
    obs: {
      W1: ignoringStrandedMentions(ignoringOfflineCut(await report(o1))),
      W2: ignoringStrandedMentions(await report(o2)),
    },
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
    marker: m,
    msToArrive: arrived,
    onReceiver: onReceiver.count,
    onSender: onSender.count,
    countSettled: onReceiver.settled && onSender.settled,
    obs: {
      A1: ignoringStrandedMentions(await report(oa)),
      W2: ignoringStrandedMentions(await report(o2)),
    },
  });
}

// ---------------------------------------------------------------- FWD-5
{
  const m = mark('FWD5');
  // A fresh session: reload, then go straight to the channel. The DM is never opened before the
  // forward, so the sender holds no loaded state for the conversation it is forwarding into.
  // THE RELOAD IS WAITED FOR ON ITS OWN EVENT BEFORE ANYTHING POLLS. `awaitAppReady` is an
  // `until`, so it sends `Runtime.evaluate` into the context this reload is destroying, and CDP
  // answers `Inspected target navigated or closed` when the two meet - which cost READ-7 three
  // runs in four before it was located (2026-09-04).
  await reloadAndWait(w1);
  await awaitAppReady(w1);
  await ensureChat(w1);
  const o1 = await watch(w1, 'FWD5-W1');
  const o2 = await watch(w2, 'FWD5-W2');
  await forwardFromChannel(w1, m);

  const at = Date.now();
  const arrived = await awaitMessage(w2, m, 60000).then(() => Date.now() - at, () => null);
  const settled = await settledCount(w2, m);
  results.push({
    marker: m,
    countSettled: settled.settled,
    msToArrive: arrived,
    onReceiver: settled.count,
    sends: sendsOf(w1),
    obs: {
      W1: ignoringStrandedMentions(await report(o1)),
      W2: ignoringStrandedMentions(await report(o2)),
    },
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
const rows = [];
for (const r of results) {
  const gated = gate(r.onReceiver === 1 ? 'PASS' : 'FAIL', r.obs);
  console.log(`${r.check} ${gated.verdict}`);
  console.log(JSON.stringify(r, null, 1));
  rows.push(record(r.check, gated.verdict, { ...r, ...gated.detail, obs: undefined }));
}
// THE ASSERTION IS NOT THE VERDICT. `gate` sits four lines above and may have turned any of these
// into PASS-DIRTY; the line this replaces re-derived the code from `onReceiver` alone and exited 0
// over it, so a dirty forward reported `done` in the runner's table. The exit stays explicit - this
// script holds two CDP sockets open, so `beforeExit` would never fire - but it now reads the
// VERDICTS that were recorded, which is the only thing that can disagree with `onReceiver`.
process.exit(rows.every((r) => r.verdict === 'PASS') ? 0 : 1);
