/**
 * FWD-1 / FWD-2 - the WP-FWD-1 reproduction attempt, channel -> DM.
 *
 * The prod loss went: forward a channel message to a DM, the toast says success, the echo persists,
 * the outbox drains - and the peer never receives it. Two later attempts delivered, so the whole
 * value of this runner is VOLUME plus reconciliation: a single miss is the bug, and a miss is only
 * visible as a difference between what the sender shows and what the receiver shows.
 *
 * Nothing about forwarding is special in the code - `forwardMessage` calls the same
 * `sendChatMessage` the composer does - which is why WP-LOSS-1 very likely subsumes this. That
 * makes the interesting outcome not "did the forward work" but "does a forward ever produce the
 * SecretReuseError branch", so both sides are observed and the receiver's notable lines are kept
 * per iteration rather than aggregated.
 *
 * Usage: node fwd.mjs [iterations]
 */
import {
  client,
  ensureChat,
  openChannel,
  openConversation,
  evaluate,
  send,
  clickBubbleAction,
  realClick,
  until,
  awaitMessage,
  countMessage,
} from './chat.mjs';
import { watch, report } from './watch.mjs';
import { record, mark } from './results.mjs';

const N = Number(process.argv[2] || 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const w1 = await client(9224, 'canari-emse.fr');
const w2 = await client(9223, 'canari-emse.fr');

// The receiver sits in the DM for the whole run: the loss is about what ARRIVES there, and moving
// it around would add navigation as a variable the original report did not have.
await ensureChat(w2);
await openConversation(w2, 'OWNER DISPLAY NAME');

const rows = [];
for (let i = 0; i < N; i++) {
  const marker = mark('FWD');
  const ow1 = await watch(w1, `FWD-${i}-W1`);
  const ow2 = await watch(w2, `FWD-${i}-W2`);

  // Post into the channel, then forward THAT message to the DM - the exact prod shape.
  await openChannel(w1);
  await send(w1, marker);
  await awaitMessage(w1, marker, 25000);
  await sleep(800);

  await clickBubbleAction(w1, marker, 'Transférer');
  await until(w1, `!!document.querySelector('[role=dialog]')`, 15000);
  await realClick(w1, 'text=PEER DISPLAY NAME');
  await until(w1, `!document.querySelector('[role=dialog]')`, 15000);

  const at = Date.now();
  const arrived = await awaitMessage(w2, marker, 40000).then(
    () => Date.now() - at,
    () => null
  );
  await sleep(1500);

  // The sender's requests for THIS iteration, drained before report() clears the buffer. Whether
  // `POST /api/mls/send` happened, and with what status, is the fork the whole diagnosis turns on:
  // no request at all means the client dropped it, a 201 means the receiver did.
  const sends = [];
  const pending = new Map();
  for (const e of w1.events) {
    const p = e.params;
    if (e.method === 'Network.requestWillBeSent' && p.request.url.includes('/api/mls/send'))
      pending.set(p.requestId, { method: p.request.method });
    if (e.method === 'Network.responseReceived' && pending.has(p.requestId))
      sends.push(`${pending.get(p.requestId).method} -> ${p.response.status}`);
    if (e.method === 'Network.loadingFailed' && pending.has(p.requestId))
      sends.push(`FAILED ${p.errorText}`);
  }

  const obs2 = await report(ow2);
  const obs1 = await report(ow1);
  rows.push({
    i,
    marker,
    arrivedMs: arrived,
    copies: await countMessage(w2, marker),
    mlsSend: sends,
    senderClean: obs1.clean,
    // The sender's swallowed-outbox branches are the ONLY trace a loss leaves on that side, so
    // they are kept per iteration rather than reduced to a boolean.
    senderErrors: obs1.errors,
    senderNotable: obs1.notable,
    senderBadHttp: obs1.badHttp,
    receiverClean: obs2.clean,
    receiverNotable: obs2.notable,
    receiverErrors: obs2.errors,
  });
  console.log(`[fwd] ${i + 1}/${N} ${marker} -> ${arrived === null ? 'LOST' : arrived + 'ms'}`);
  await sleep(1200);
}

const lost = rows.filter((r) => r.arrivedMs === null);
const dupes = rows.filter((r) => r.copies > 1);
const verdict = lost.length === 0 && dupes.length === 0 ? 'PASS' : 'FAIL';
record(N > 1 ? 'FWD-2' : 'FWD-1', verdict, { iterations: N, lost, dupes, rows });
console.log(JSON.stringify({ verdict, iterations: N, lostCount: lost.length, dupes: dupes.length, rows }, null, 1));
process.exit(0);
