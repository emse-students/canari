/**
 * WP-ECHO-1 - the SENDER loses its own message across a reload.
 *
 * MLS gives you no echo of your own message, so the optimistic copy drawn at send time is the only
 * one that exists. `addMessageToChat`'s bulk-ingest early return sat IN FRONT of `saveMessage`, so a
 * message sent while an inbound drain was running was buffered and never written - and the buffer is
 * cleared without flushing by the next drain. The receiver keeps it; the sender loses it at the next
 * load. That asymmetry is the whole signature.
 *
 * THE CHECK IS ONLY MEANINGFUL IF THE SENDS LANDED INSIDE A DRAIN. A green run made outside one
 * proves nothing at all - it exercises the live path, which was never broken. So the drain windows
 * are read out of W1's own console and the overlap is asserted, not assumed.
 */
import { client, openConversation, send, ensureChat } from './chat.mjs';
import { evaluate, until } from './cdp.mjs';

// Each side names the OTHER person: W1 is owner's client, W2 is the peer's. One constant for both
// silently opened nothing on W2 and the run died 20 s later inside `openConversation`, pointing at
// the list rather than at the name.
const PEER_ON_W1 = 'PEER DISPLAY NAME';
const PEER_ON_W2 = 'OWNER DISPLAY NAME';
// The drains are SHORT (~100-280 ms each, one per arriving frame), so how many own sends land
// inside one is luck. Two earlier runs bought 2/3 and 1/3 overlaps - green, but a thin sample for
// the only condition that exercises the bug. More of both raises the number of sends that actually
// hit the condition, rather than the number that merely look like they did.
const BURST = 10; // from W2, to keep W1 draining
const OWN = 8; // W1's own markers, sent into that drain

const tag = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { check: 'WP-ECHO-1 verification' };
const t0 = Date.now();
const stage = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(3)}s] ${m}`);

/** Console lines with their wall-clock timestamps, for the overlap proof. */
function consoleLines(cx) {
  return cx.events
    .filter((e) => e.method === 'Runtime.consoleAPICalled')
    .map((e) => ({
      ts: e.params.timestamp,
      text: (e.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '),
    }));
}

/**
 * Pairs `Drain start` with the `Drain complete` that follows it. An unclosed drain is kept with
 * `end: Infinity` on purpose: a drain that never completed is exactly the condition WP-DRAIN-2
 * describes, and swallowing it here would hide it.
 */
function drainWindows(lines) {
  const wins = [];
  let open = null;
  for (const l of lines) {
    if (/\[QUEUE\] Drain start/.test(l.text)) open = { start: l.ts, end: Infinity };
    else if (/\[QUEUE\] Drain complete/.test(l.text) && open) {
      open.end = l.ts;
      wins.push(open);
      open = null;
    }
  }
  if (open) wins.push(open);
  return wins;
}

const w1 = await client(9224, 'canari-emse.fr');
const w2 = await client(9223, 'canari-emse.fr');
await w1.send('Runtime.enable');
await w2.send('Runtime.enable');

stage('opening the DM on both');
await ensureChat(w1);
await ensureChat(w2);
await openConversation(w1, PEER_ON_W1);
await openConversation(w2, PEER_ON_W2);
await sleep(2_000);

// Clear W1's event buffer only now: everything before this is the load, not the check.
w1.events.length = 0;

const ownMarkers = Array.from({ length: OWN }, () => `ECHO-${tag()}`);
const burstMarkers = Array.from({ length: BURST }, () => `FILL-${tag()}`);
out.ownMarkers = ownMarkers;

// W2's burst is started and DELIBERATELY NOT AWAITED - the point is that W1 is mid-drain while it
// sends. Awaiting it first would put every own-send safely after the drain, i.e. on the live path,
// and the check would pass against the broken build too.
stage(`W2 burst of ${BURST}, not awaited`);
const burst = (async () => {
  for (const m of burstMarkers) {
    await send(w2, `${m} echo filler`);
  }
})();

await sleep(1_200); // let the first frames land so a drain is actually open

stage(`W1 sends ${OWN} of its own, into the drain`);
out.ownSentAt = [];
for (const m of ownMarkers) {
  out.ownSentAt.push(await send(w1, `${m} own message during drain`));
}

await burst;
stage('burst settled; letting both quiesce');
await sleep(8_000);

// ── did the sends actually land inside a drain? ──────────────────────────────
const lines = consoleLines(w1);
out.drainWindows = drainWindows(lines).map((w) => ({
  start: Math.round(w.start),
  end: w.end === Infinity ? null : Math.round(w.end),
}));
out.overlap = out.ownSentAt.map((at) =>
  drainWindows(lines).some((w) => at >= w.start && at <= w.end)
);
out.overlapped = out.overlap.filter(Boolean).length;
out.bulkDeferred = lines.filter((l) => /bulk ingest depth=/.test(l.text)).length;
stage(`drains=${JSON.stringify(out.drainWindows)} overlap=${JSON.stringify(out.overlap)} deferredLines=${out.bulkDeferred}`);

const visible = async (cx) =>
  JSON.parse(
    await evaluate(
      cx,
      `JSON.stringify(${JSON.stringify(ownMarkers)}.map(function (m) {
         return (document.body.innerText || '').indexOf(m) !== -1;
       }))`
    )
  );

out.onW1BeforeReload = await visible(w1);
out.onW2 = await visible(w2);
stage(`before reload: W1 ${JSON.stringify(out.onW1BeforeReload)}  W2 ${JSON.stringify(out.onW2)}`);

// ── the reload, which is where the loss used to show ────────────────────────
stage('reloading W1');
await w1.send('Page.reload', { ignoreCache: false });
await sleep(12_000);
await until(w1, `document.readyState === 'complete'`, 30_000).catch(() => null);

const gate = await evaluate(
  w1,
  `(!!document.querySelector('#encryption-pin') || document.body.innerText.indexOf('PIN de chiffrement') !== -1)`
);
out.pinGateAfterReload = gate;
if (gate) throw new Error('W1 came back to the PIN gate - unlock before measuring (harness fault #22)');

await ensureChat(w1);
await openConversation(w1, PEER_ON_W1);
await sleep(4_000);
out.onW1AfterReload = await visible(w1);
stage(`after reload:  W1 ${JSON.stringify(out.onW1AfterReload)}`);

out.verdict =
  out.overlapped > 0 && out.onW1AfterReload.every(Boolean) && out.onW2.every(Boolean)
    ? 'PASS'
    : 'FAIL';
out.why =
  out.overlapped === 0
    ? 'NO SEND LANDED IN A DRAIN - the check exercised the live path and proves nothing'
    : !out.onW2.every(Boolean)
      ? 'the receiver did not get them all - that is WP-LOSS-1 territory, not WP-ECHO-1'
      : out.onW1AfterReload.every(Boolean)
        ? 'every own message survived the reload on the sender'
        : 'the sender lost its own message across the reload';

console.log(JSON.stringify(out, null, 2));
process.exit(0);
