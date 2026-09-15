/**
 * ONE COLD LAUNCH WITH EVERY CLOCK ON ONE AXIS.
 *
 * Cold-starts the app, attaches to the WebView as early as its devtools socket exists, and prints
 * every console line with BOTH its offset from `performance.timeOrigin` and its absolute wall
 * clock - `timeOrigin` is an absolute epoch, and so is a `logcat` timestamp, so the page's own
 * timeline and the `BiometricPrompt` can be placed against each other with no guesswork. The
 * bracketing `logcat` lines are printed underneath.
 *
 * Usage: `bun tools/cold-start/launch-trace.mjs [seconds]` (default 25).
 * Add `--heartbeat` to arm the 50 ms main-thread probe over the same window; it answers a
 * different question - see `heartbeat.mjs` - and the two together are what a cold start is read
 * with.
 */
import { client, evaluate } from '../cross-client-harness/chat.mjs';
import { watch } from '../cross-client-harness/watch.mjs';
import {
  adb,
  deviceSerial,
  forceStop,
  forwardDevtools,
  launch,
  logcatDump,
  waitMs,
} from './device.mjs';

const seconds = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 25);
const withHeartbeat = process.argv.includes('--heartbeat');

const serial = await deviceSerial();
await forceStop(serial);
await waitMs(3000);
await adb(serial, ['logcat', '-c']);
await launch(serial);
const socket = await forwardDevtools(serial);
console.log(`device ${serial}, socket ${socket}`);

const cx = await client(9222, null, { allowMany: true, focus: false });
const timeOrigin = Number(await evaluate(cx, 'String(performance.timeOrigin)'));
await watch(cx, 'COLDSTART');
if (withHeartbeat) {
  await evaluate(
    cx,
    `(function () {
       window.__hb = [];
       window.__hbTimer = setInterval(function () { window.__hb.push(Math.round(performance.now())); }, 50);
       return 'armed';
     })()`
  );
}
console.log(
  `timeOrigin ${new Date(timeOrigin).toISOString()} (attached at +${Math.round(Date.now() - timeOrigin)} ms)`
);

await new Promise((r) => setTimeout(r, seconds * 1000));

// Raw events rather than `consoleLines`, which drops the timestamp - and the timestamp is the
// whole point of this instrument.
// The two domains carry the timestamp in DIFFERENT places - `Runtime.consoleAPICalled` on the
// params, `Log.entryAdded` on the entry - and reading only the first printed every browser-issued
// line (a failed resource, a CSP refusal) at epoch zero, i.e. at -1789490651400 ms. Both are
// milliseconds since the epoch, the same axis as `timeOrigin`, so one sort puts them in order.
const rows = (cx.consumed ?? [])
  .concat(cx.events)
  .filter((e) => e.method === 'Runtime.consoleAPICalled' || e.method === 'Log.entryAdded')
  .map((e) =>
    e.method === 'Log.entryAdded'
      ? [e.params.entry.timestamp, e.params.entry.text]
      : [e.params.timestamp, e.params.args.map((a) => a.value ?? a.description ?? '').join(' ')]
  )
  .sort((a, b) => a[0] - b[0]);
for (const [at, message] of rows) {
  const offset = String(Math.round(at - timeOrigin)).padStart(6);
  console.log(
    `  +${offset} ms  ${new Date(at).toISOString().slice(11, 23)}  ${message.slice(0, 160)}`
  );
}
console.log(`${rows.length} console line(s)`);

if (withHeartbeat) {
  const beats = JSON.parse(await evaluate(cx, 'JSON.stringify(window.__hb || [])'));
  await evaluate(cx, 'clearInterval(window.__hbTimer), "stopped"');
  let worst = 0;
  for (let i = 1; i < beats.length; i++) {
    const gap = beats[i] - beats[i - 1];
    if (gap > 150)
      console.log(`  GAP ${String(gap).padStart(5)} ms   +${beats[i - 1]} -> +${beats[i]}`);
    worst = Math.max(worst, gap);
  }
  console.log(`worst main-thread gap ${worst} ms over ${beats.length} beats`);
}
cx.close();

console.log('--- logcat anchors ---');
const log = await logcatDump(serial);
for (const line of log.filter((l) =>
  /ActivityTaskManager.*START u0 .*fr\.emse\.canari|BiometricService.*handleAuthenticate/.test(l)
)) {
  console.log(`  ${line.slice(0, 120)}`);
}
await forceStop(serial);
