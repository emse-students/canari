/**
 * FWD-5, isolated and repeated - the shape that just lost a forward.
 *
 * The first run lost it AND the receiver logged `SecretReuseError` then
 * `[MLS] Duplicate ... - silent ACK`, which is the WP-LOSS-1 branch. If that holds across
 * iterations, WP-FWD-1 is not a forwarding bug at all: it is the receiver discarding a frame it
 * has never seen, and forwarding merely happens to reach the branch often.
 *
 * Everything is written to `logs/fwd5-<n>.json` so the evidence survives the terminal.
 *
 * Usage: node fwd5.mjs [iterations]
 */
import { APP_TAB, awaitAppReady, awaitMessage, clickBubbleAction, client, countMessage, ensureChat, openChannel, openConversation, realClick, send, settledCount, until } from './chat.mjs';
import { watch, report, dirtOf } from './watch.mjs';
import { finishObserved, mark } from './results.mjs';
// See fwd.mjs: a real display name belongs in names.mjs, which never reaches the public repo.
import { peerNameFor } from './names.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';

const N = Number(process.argv[2] || 3);
mkdirSync('logs', { recursive: true });

/** Every `/api/mls/send` the client made, with its status - the fork the diagnosis turns on. */
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

const w1 = await client(9224, APP_TAB);
const w2 = await client(9223, APP_TAB);
await ensureChat(w2);
await openConversation(w2, peerNameFor('W2'));

const summary = [];
/** Every iteration's two reports, keyed - so the gate can say WHICH round was noisy. */
const reports = {};
for (let i = 0; i < N; i++) {
  const m = mark('FWD5');

  // Fresh session, then straight to the channel: the DM is never opened before the forward.
  await w1.send('Page.reload');
  await awaitAppReady(w1);
  await ensureChat(w1);

  const o1 = await watch(w1, `FWD5-${i}-W1`);
  const o2 = await watch(w2, `FWD5-${i}-W2`);

  await openChannel(w1);
  await send(w1, m);
  await awaitMessage(w1, m, 25000);
  await clickBubbleAction(w1, m, 'Transférer');
  await until(w1, `!!document.querySelector('[role=dialog]')`, 15000);
  await realClick(w1, `text=${peerNameFor('W1')}`);
  await until(w1, `!document.querySelector('[role=dialog]')`, 15000);

  const at = Date.now();
  const arrived = await awaitMessage(w2, m, 45000).then(() => Date.now() - at, () => null);
  // Stability, not a delay: the question after arrival is whether a SECOND copy follows, and that is
  // an absence no fact can be waited on. Polling until the count holds still answers it and returns
  // at once in the ninety-nine cases where nothing was going to change.
  const settled = await settledCount(w2, m);

  const sends = sendsOf(w1);
  const row = {
    iteration: i,
    marker: m,
    msToArrive: arrived,
    onReceiver: settled.count,
    // A count still moving at the deadline is not a measurement, and the record has to say so.
    countSettled: settled.settled,
    sends,
    obs: { w1: await report(o1), w2: await report(o2) },
  };
  reports[`W1#${i}`] = row.obs.w1;
  reports[`W2#${i}`] = row.obs.w2;
  writeFileSync(`logs/fwd5-${i}.json`, JSON.stringify(row, null, 1));

  summary.push({
    i,
    marker: m,
    delivered: row.onReceiver === 1,
    ms: arrived,
    sends,
    receiverNotable: row.obs.w2.notable,
    receiverClean: row.obs.w2.clean,
    receiverDirt: dirtOf(row.obs.w2),
  });
  console.log(JSON.stringify(summary[summary.length - 1]));
}

const lost = summary.filter((s) => !s.delivered);
console.log(`\n${summary.length - lost.length}/${summary.length} delivered; ${lost.length} lost`);

/**
 * A SEPARATE ID FROM `fwd345.mjs`'s FWD-5, on purpose.
 *
 * This is the same shape run N times from a fresh session each round; `fwd345.mjs` records the
 * single FWD-5 the dashboard names. Sharing the id would put N rows under one check and leave any
 * reader of the ledger unable to say which instrument produced which - the volume is the whole
 * point of this file, and it deserves to be legible as volume rather than as five FWD-5s.
 *
 * Until now it recorded nothing at all: the per-round evidence went to `logs/fwd5-<n>.json`, which
 * `.gitignore` covers and `git clean -xdf` removes, and the campaign's own record held no trace that
 * the repeat ever ran.
 */
await finishObserved(
  `FWD-5-repeat`,
  lost.length ? 'FAIL' : 'PASS',
  { iterations: N, lostCount: lost.length, lostRounds: lost.map((s) => s.i), rounds: summary },
  reports,
);
