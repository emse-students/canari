/**
 * Is anything generating frames on its own, and if so what shape are they?
 *
 * Written to diagnose a repair that broadcast (~430 frames/min into one phone, continuously). That
 * mechanism was deleted on 2026-08-10, so this is now the REGRESSION probe for its class: after any
 * repair-mechanism change, a quiet conversation must produce a quiet capture.
 *
 * The three shapes at the top of the list no longer exist in a current build. They are kept
 * deliberately, because finding one is itself a finding: either a client is running an old build, or
 * the deleted rung has come back. An empty tally for them is the expected result, not a broken probe.
 *
 * Pure observation: a 30 s console capture, tallied by shape. Nothing is sent, nothing reloaded.
 */
import { listTargets, connect } from './cdp.mjs';

const WINDOW_MS = 30_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SHAPES = [
  // --- deleted 2026-08-10. Any hit here means an old build, or a regression. ---
  ['!! asked to retransmit (DELETED)', /Asked .* to retransmit/],
  ['!! answering decrypt_failed, retransmitting (DELETED)', /retransmitting \d+ payload/],
  ['!! answering decrypt_failed, nothing retained (DELETED)', /nothing sent in the last .*is still retained/],
  ['!! narrow-signal rate limit (DELETED)', /already signalled recently/],
  // --- the current repair: detection, then ONE id-addressed exchange ---
  ['LOST frame', /LOST frame/],
  ['soliciting a history diff', /soliciting a history diff/],
  ['ignoring a legacy decrypt_failed (benign)', /Ignoring a legacy decrypt_failed/],
  ['history request', /\[HISTORY_REQ\]/],
  ['history digest', /\[HISTORY_DIGEST\]/],
  ['history pull', /\[HISTORY_PULL\]/],
  ['history bundle', /\[HISTORY_BUNDLE\]/],
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
