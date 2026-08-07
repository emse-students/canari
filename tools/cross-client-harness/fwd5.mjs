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
} from './chat.mjs';
import { watch, report } from './watch.mjs';
import { mark } from './results.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';

const N = Number(process.argv[2] || 3);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

const w1 = await client(9224, 'canari-emse.fr');
const w2 = await client(9223, 'canari-emse.fr');
await ensureChat(w2);
await openConversation(w2, 'OWNER DISPLAY NAME');

const summary = [];
for (let i = 0; i < N; i++) {
  const m = mark('FWD5');

  // Fresh session, then straight to the channel: the DM is never opened before the forward.
  await w1.send('Page.reload');
  await sleep(6000);
  await ensureChat(w1);

  const o1 = await watch(w1, `FWD5-${i}-W1`);
  const o2 = await watch(w2, `FWD5-${i}-W2`);

  await openChannel(w1);
  await send(w1, m);
  await awaitMessage(w1, m, 25000);
  await sleep(800);
  await clickBubbleAction(w1, m, 'Transférer');
  await until(w1, `!!document.querySelector('[role=dialog]')`, 15000);
  await realClick(w1, 'text=PEER DISPLAY NAME');
  await until(w1, `!document.querySelector('[role=dialog]')`, 15000);

  const at = Date.now();
  const arrived = await awaitMessage(w2, m, 45000).then(() => Date.now() - at, () => null);
  await sleep(2500);

  const sends = sendsOf(w1);
  const row = {
    iteration: i,
    marker: m,
    msToArrive: arrived,
    onReceiver: await countMessage(w2, m),
    sends,
    obs: { w1: await report(o1), w2: await report(o2) },
  };
  writeFileSync(`logs/fwd5-${i}.json`, JSON.stringify(row, null, 1));

  summary.push({
    i,
    marker: m,
    delivered: row.onReceiver === 1,
    ms: arrived,
    sends,
    receiverNotable: row.obs.w2.notable,
    receiverClean: row.obs.w2.clean,
  });
  console.log(JSON.stringify(summary[summary.length - 1]));
}

const lost = summary.filter((s) => !s.delivered);
console.log(`\n${summary.length - lost.length}/${summary.length} delivered; ${lost.length} lost`);
process.exit(lost.length ? 1 : 0);
