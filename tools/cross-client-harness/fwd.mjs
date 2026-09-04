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
import { APP_TAB, awaitMessage, clickBubbleAction, client, countMessage, ensureChat, evaluate, openChannel, openConversation, realClick, send, settledCount, until } from './chat.mjs';
import { watch, report, dirtOf, gate } from './watch.mjs';
import { finish, mark } from './results.mjs';
// NO DISPLAY NAME IS EVER SPELT IN A CHECK. `names.mjs` is the one file that holds real identities
// and the one file that never reaches the repo, which is PUBLIC - so a check that imports cannot
// leak, and a check that spells the name relies on someone noticing before the mirror. One did not:
// the peer's full name reached the public archive in 95d76fdf that way.
import { peerNameFor } from './names.mjs';

const N = Number(process.argv[2] || 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const w1 = await client(9224, APP_TAB);
const w2 = await client(9223, APP_TAB);

// The receiver sits in the DM for the whole run: the loss is about what ARRIVES there, and moving
// it around would add navigation as a variable the original report did not have.
await ensureChat(w2);
await openConversation(w2, peerNameFor('W2'));

const rows = [];
// Every iteration's two reports, keyed so the gate can name WHICH round was dirty. A run of ten
// forwards reduced to one boolean would say "something was noisy" and send its reader back to a
// stdout dump the next nine rounds have scrolled past.
const reports = {};
for (let i = 0; i < N; i++) {
  const marker = mark('FWD');
  const ow1 = await watch(w1, `FWD-${i}-W1`);
  const ow2 = await watch(w2, `FWD-${i}-W2`);

  // Post into the channel, then forward THAT message to the DM - the exact prod shape.
  await openChannel(w1);
  await send(w1, marker);
  await awaitMessage(w1, marker, 25000);
  await clickBubbleAction(w1, marker, 'Transférer');
  await until(w1, `!!document.querySelector('[role=dialog]')`, 15000);
  await realClick(w1, `text=${peerNameFor('W1')}`);
  await until(w1, `!document.querySelector('[role=dialog]')`, 15000);

  const at = Date.now();
  const arrived = await awaitMessage(w2, marker, 40000).then(
    () => Date.now() - at,
    () => null
  );
  // Stability rather than a delay - see `settledCount`. The read below used to be a single sample
  // taken 1500 ms after arrival, which reports a second copy landing at 1600 ms as no copy at all.
  const settled = await settledCount(w2, marker);

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
  reports[`W1#${i}`] = obs1;
  reports[`W2#${i}`] = obs2;
  rows.push({
    i,
    marker,
    arrivedMs: arrived,
    copies: settled.count,
    copiesSettled: settled.settled,
    mlsSend: sends,
    senderClean: obs1.clean,
    // The sender's swallowed-outbox branches are the ONLY trace a loss leaves on that side, so
    // they are kept per iteration rather than reduced to a boolean.
    senderDirt: dirtOf(obs1),
    senderNotable: obs1.notable,
    receiverClean: obs2.clean,
    receiverNotable: obs2.notable,
    receiverDirt: dirtOf(obs2),
  });
  console.log(`[fwd] ${i + 1}/${N} ${marker} -> ${arrived === null ? 'LOST' : arrived + 'ms'}`);
  // A DELIBERATE GAP BETWEEN ITERATIONS, not a wait for anything. Back-to-back forwards would make
  // each round's observation window overlap the next one's traffic, and a stray line would then be
  // attributed to whichever iteration happened to be watching. Kept short and stated, rather than
  // removed: this one buys separability, which is the property the per-iteration records exist for.
  await sleep(1200);
}

const lost = rows.filter((r) => r.arrivedMs === null);
const dupes = rows.filter((r) => r.copies > 1);
const asserted = lost.length === 0 && dupes.length === 0 ? 'PASS' : 'FAIL';
// THE OBSERVATION DECIDES, having been computed and ignored until now. Both reports were read into
// `senderClean` / `receiverClean` on every row, where they could be printed but never contradict the
// verdict - which is the exact fault this check was written to catch in the APPLICATION, running in
// the instrument. And `process.exit(0)` sat under a `record` that can be FAIL, so `run.mjs` printed
// `done` next to a recorded loss; `finish` is the one place that cannot do half of it.
const gated = gate(asserted, reports);
finish(N > 1 ? 'FWD-2' : 'FWD-1', gated.verdict, { ...gated.detail, iterations: N, lost, dupes, rows });
