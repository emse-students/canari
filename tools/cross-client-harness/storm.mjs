/**
 * What is generating ~430 frames/minute into A1's queue, continuously since 12:59 CEST?
 *
 * A1 DECRYPTS them: the line it spams is `systemMessageHandler`'s answer to an incoming
 * `decrypt_failed` ("nothing retained - it cannot be recovered"). So the senders are W1 and W2, and
 * the question is which of their own log lines dominates - the emitter (`Asked ... to retransmit`),
 * the ledger (`LOST frame`), the rate limiter (`already signalled recently`), or an outbox retry.
 *
 * Pure observation: a 30 s console capture, tallied by shape. Nothing is sent, nothing reloaded.
 */
import { listTargets, connect } from './cdp.mjs';

const WINDOW_MS = 30_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SHAPES = [
  ['LOST frame', /LOST frame/],
  ['asked to retransmit', /Asked .* to retransmit/],
  ['rate-limited', /already signalled recently/],
  ['answering decrypt_failed (nothing retained)', /nothing sent in the last .*is still retained/],
  ['answering decrypt_failed (retransmitting)', /retransmitting \d+ payload/],
  ['duplicate delivery', /Duplicate delivery/],
  ['generation out of bounds', /generation out of bounds/],
  ['SecretReuse', /SecretReuse/],
  ['outbox send', /\[OUTBOX\].*sen[dt]/i],
  ['outbox retry', /\[OUTBOX\].*retr/i],
  ['control event queued', /control/i],
  ['drain start', /\[QUEUE\] Drain start/],
  ['processing message', /\[QUEUE\] Processing message/],
];

async function attach(port, urlPart) {
  const ts = await listTargets(port).catch(() => []);
  const t = ts.find((x) => String(x.url).includes(urlPart));
  if (!t) return null;
  const cx = connect(t.webSocketDebuggerUrl);
  await cx.ready;
  await cx.send('Runtime.enable');
  return cx;
}

for (const [name, port] of [
  ['W1', 9224],
  ['W2', 9223],
]) {
  const cx = await attach(port, 'canari-emse.fr');
  if (!cx) {
    console.log(`${name}: not attached`);
    continue;
  }
  cx.events.length = 0;
  await sleep(WINDOW_MS);
  const lines = cx.events
    .filter((e) => e.method === 'Runtime.consoleAPICalled')
    .map((e) => (e.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));

  console.log(`\n=== ${name}: ${lines.length} console lines in ${WINDOW_MS / 1000}s ===`);
  for (const [label, re] of SHAPES) {
    const n = lines.filter((l) => re.test(l)).length;
    if (n > 0) console.log(`  ${String(n).padStart(5)}  ${label}`);
  }
  // The unattributed remainder, deduplicated by prefix - that is where a missed shape hides.
  const tally = new Map();
  for (const l of lines) {
    if (SHAPES.some(([, re]) => re.test(l))) continue;
    const key = l.replace(/[0-9a-f]{6,}/g, '…').replace(/\d+/g, 'N').slice(0, 90);
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  const top = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (top.length) {
    console.log('  --- unattributed ---');
    for (const [k, n] of top) console.log(`  ${String(n).padStart(5)}  ${k}`);
  }
  cx.close();
}
process.exit(0);
