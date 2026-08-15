/**
 * MSG-5: W1 -> the campaign channel, with W2 and A1 as members.
 *
 * Three assertions, not one:
 *  1. all three clients converge on exactly one copy;
 *  2. no response body anywhere carries `masterSecret` - the durable rule says a `Channel` entity
 *     must never reach a client, and only reading the wire can establish that;
 *  3. nothing unexplained happened on any of the three while it ran (see watch.mjs).
 */
import { writeFileSync } from 'node:fs';
import { awaitMessage, client, countMessage, openChannel, send } from './chat.mjs';
import { gate, logcatSince, report, sanity, watch } from './watch.mjs';
import { mark, record } from './results.mjs';
import { PORTS } from "./names.mjs";

const w1 = await client(9224);
const w2 = await client(9223);
const a1 = await client(PORTS.A1);
const named = [
  ['W1', w1],
  ['W2', w2],
  ['A1', a1],
];

for (const [, cx] of named) await cx.send('Network.enable');
for (const [n, cx] of named) console.log(`${n}: ${await openChannel(cx)}`);

const pre = {};
for (const [n, cx] of named) pre[n] = await sanity(cx);
const watches = [];
for (const [n, cx] of named) watches.push(await watch(cx, n));
const t0 = Date.now();

const marker = mark('MSG5');
const at = await send(w1, `MSG-5 channel ${marker}`);

const latency = {};
for (const [n, cx] of named.slice(1)) {
  try {
    latency[n] = await awaitMessage(cx, marker, 25000);
  } catch {
    latency[n] = null;
  }
}
await new Promise((r) => setTimeout(r, 2500));

/**
 * Every JSON body seen on a client, scanned for the secrets that must never travel.
 * Runs BEFORE report(), which drains the same event buffer.
 */
async function leaks(cx, label) {
  const found = [];
  for (const e of cx.events) {
    if (e.method !== 'Network.responseReceived') continue;
    const url = e.params.response.url;
    if (!url.includes('/api/')) continue;
    const body = await cx.send('Network.getResponseBody', { requestId: e.params.requestId }).catch(() => null);
    const text = String(body?.body ?? '');
    for (const secret of ['masterSecret', 'master_secret', 'webhookSecret'])
      if (text.includes(secret)) found.push({ label, url, secret });
  }
  return found;
}

const leaked = [];
for (const [n, cx] of named) leaked.push(...(await leaks(cx, n)));

const observed = [];
for (const w of watches) observed.push(await report(w));

const copies = {
  W1: await countMessage(w1, marker),
  W2: await countMessage(w2, marker),
  A1: await countMessage(a1, marker),
};
const phone = await logcatSince(t0);

const converged = Object.values(copies).every((c) => c === 1);
// ONE NAME FOR ONE STATE. This used to spell a dirty pass `PASS-WITH-NOISE` while MSG-10 spelt the
// same state `PASS-DIRTY`, so counting the dirty runs on the dashboard meant knowing which script
// wrote each row. `gate` is now the only place either word is chosen.
//
// A LEAK IS NOT DIRT, IT IS A FAILURE, and it stays out of the gate on purpose: this check searches
// the network traffic for the plaintext secret, and finding it means the ciphertext-only guarantee
// is broken. That is the most serious thing MSG-5 can report and it may never be softened to a
// qualified pass.
const gated = gate(converged && leaked.length === 0 ? 'PASS' : 'FAIL', Object.fromEntries(observed.map((o) => [o.label, o])));
writeFileSync(
  new URL(`./logs/msg5-${marker}.json`, import.meta.url),
  JSON.stringify({ marker, at, latency, copies, pre, leaked, observed, phone }, null, 1),
);

record('MSG-5', gated.verdict, {
  ...gated.detail,
  marker,
  secretsLeaked: leaked,
  latency,
  copies,
  pre,
  noise: observed.map((o) => ({
    c: o.label,
    clean: o.clean,
    errors: o.errors.length,
    badHttp: o.badHttp,
    notable: o.notable.slice(0, 6),
    unexplained: o.unexplained.slice(0, 6),
  })),
  phoneLogTail: phone.slice(-8),
  log: `logs/msg5-${marker}.json`,
});
w1.close();
w2.close();
a1.close();
