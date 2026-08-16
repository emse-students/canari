#!/usr/bin/env node
/**
 * WP-RECONNECT-1's owed PROSPECTIVE proof: the reconnect ladder no longer terminates on a count.
 *
 * `circuit.mjs` captured the DEFECT - two prod tabs, 7 h old, online and visible, 0 retries and 0
 * sockets in 135 s, then a synthetic `visibilitychange` on the already-visible tab reconnecting it
 * in under 20 s while its twin stayed dead as a control. That capture cannot be repeated as a
 * verification: it measured a circuit that no longer exists, and a tab reloaded to GET the fix has
 * not lived through an outage.
 *
 * So the proof has to be made rather than found, and it turns on ONE NUMBER. The old circuit opened
 * at 20 attempts; `RECONNECT_DELAYS` is `[1, 2, 4, 8, 16, 30]` seconds saturating, and nothing caps
 * the count any more. **A retry line reading `attempt 21` is therefore impossible under the old
 * code and inevitable under the new one** - it is not evidence that has to be interpreted.
 *
 * WHY THE CUT IS A `cutHard`. `emulateNetworkConditions` fails new requests and leaves an
 * ESTABLISHED WebSocket completely alone, so a client "taken offline" that way never notices and
 * never retries - the check would then measure a silence it caused itself (testing-methodology
 * rule 7). `armCut` patches the socket constructor across a reload; `cutHard` puts offline on
 * FIRST and only then closes, so the reconnect fired the instant the socket dies cannot succeed.
 *
 * The reload `armCut` performs is not incidental here: it is what guarantees the tab is running the
 * DEPLOYED bundle, which is the half of this that made a standalone run impossible before.
 *
 *   node ladder.mjs [--device W2] [--outage 600000]
 */
import { client, evaluate } from './chat.mjs';
import { armCut, cutHard } from './net.mjs';
import { consoleLines, watch } from './watch.mjs';
import { PORTS } from './names.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => (argv.indexOf(`--${n}`) === -1 ? d : argv[argv.indexOf(`--${n}`) + 1]);
const device = opt('device', 'W2');
if (!PORTS[device]) throw new Error(`unknown device ${device} - known: ${Object.keys(PORTS).join(' ')}`);
const outageMs = Number(opt('outage', 600000));

/** The old circuit's cap. Passing it is the whole verdict. */
const OLD_CIRCUIT_CAP = 20;

const cx = await client(PORTS[device]);
const w = await watch(cx, 'ladder');
const t0 = Date.now();
const at = () => Math.round((Date.now() - t0) / 1000);

console.log(`[${at()}s] arming ${device} - this reloads it, which is also how it picks up the deployed bundle`);
const armed = await armCut(cx);
console.log(`[${at()}s] armed; gateway back after ${armed.gatewayBackAfterMs} ms`);

const cut = await cutHard(cx);
const cutAt = Date.now();
console.log(`[${at()}s] CUT - ${cut.socketsClosed} socket(s) closed with offline already on`);
console.log(`[${at()}s] holding the outage for ${Math.round(outageMs / 1000)}s; need attempt > ${OLD_CIRCUIT_CAP}\n`);

const RETRY = /Retrying in ([\d.]+)s\.\.\. \(attempt (\d+)/;
const WATCHDOG = /Watchdog: socket inactive/;

let highest = 0;
let reported = 0;
while (Date.now() - cutAt < outageMs) {
  await new Promise((r) => setTimeout(r, 5000));
  for (const l of consoleLines(cx)) {
    const m = l.match(RETRY);
    if (m) highest = Math.max(highest, Number(m[2]));
  }
  // Progress on the number that decides it, not on the clock.
  if (highest >= reported + 5) {
    reported = highest;
    console.log(`  [${at()}s] attempt ${highest}`);
  }
  if (highest > OLD_CIRCUIT_CAP) break;
}

const heldFor = Math.round((Date.now() - cutAt) / 1000);
console.log(`\n[${at()}s] outage held ${heldFor}s, highest attempt ${highest}`);

// RESTORE ONLY LIFTS THE EMULATION. Nothing here dispatches `online` or `visibilitychange` - the
// app reconnecting by itself is the behaviour under test, and dispatching the event the old circuit
// needed would answer a different question entirely.
await cut.restore();
console.log(`[${at()}s] network restored - no synthetic event dispatched`);

const backBy = Date.now();
let reconnectedMs = null;
while (Date.now() - backBy < 60000) {
  const ok = await evaluate(cx, `fetch('/api/version', { cache: 'no-store' }).then(function () { return true; }, function () { return false; })`);
  if (ok) {
    const lines = consoleLines(cx).filter((l) => /\[WS\] Connected to Chat Gateway/.test(l));
    if (lines.length) {
      reconnectedMs = Date.now() - backBy;
      break;
    }
  }
  await new Promise((r) => setTimeout(r, 1000));
}

const all = consoleLines(cx);
const retries = all.map((l) => l.match(RETRY)).filter(Boolean).map((m) => ({ delay: Number(m[1]), attempt: Number(m[2]) }));
const watchdogs = all.filter((l) => WATCHDOG.test(l)).length;
const delays = [...new Set(retries.map((r) => r.delay))].sort((a, b) => a - b);
const monotonic = retries.every((r, i) => i === 0 || r.attempt >= retries[i - 1].attempt);

console.log(`\nLADDER on ${device}`);
console.log(`  retry lines        : ${retries.length}`);
console.log(`  highest attempt    : ${highest}   (old circuit opened at ${OLD_CIRCUIT_CAP})`);
console.log(`  distinct delays    : ${delays.join(', ')} s`);
console.log(`  attempts monotonic : ${monotonic}`);
console.log(`  watchdog lines     : ${watchdogs}`);
console.log(`  reconnected after  : ${reconnectedMs === null ? 'NEVER within 60 s' : `${reconnectedMs} ms`}`);

const pass = highest > OLD_CIRCUIT_CAP && monotonic && delays.includes(30) && reconnectedMs !== null;
console.log(`\nVERDICT: ${pass ? 'PASS' : 'FAIL'} - the ladder ${highest > OLD_CIRCUIT_CAP ? 'climbed past the old cap' : `stopped at ${highest}`} and ${reconnectedMs === null ? 'did NOT come back' : 'came back unaided'}`);
cx.close();
process.exit(pass ? 0 : 1);
