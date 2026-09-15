/**
 * IS THE MAIN THREAD BLOCKED, AND FOR HOW LONG - THE INSTRUMENT THAT NAMED THE 2 731 ms.
 *
 * A 50 ms interval pushes `performance.now()` into an array. A gap far larger than 50 ms is the
 * event loop not getting a turn, and it is the ONLY instrument here that can see such work:
 *
 * - the resource timeline sees nothing, because a block issues no request;
 * - airplane mode removes the NETWORK but not the REQUESTS, so it bounds the network's share and
 *   isolates nothing;
 * - the console keeps no buffer in a WebView, so a line is only observable by an observer already
 *   attached when it printed.
 *
 * It also explains a prompt that looks slow and is not: a `BiometricPrompt` is raised by an
 * `invoke`, so its IPC message queues behind whatever is blocking, and the sheet appears after the
 * block ends rather than when the app asked for it.
 *
 * Usage: `bun tools/cold-start/heartbeat.mjs [seconds]` (default 12) against an ALREADY forwarded
 * port - `launch-trace.mjs` is the one that cold-starts the app and forwards for you.
 */
import { client, evaluate } from '../cross-client-harness/chat.mjs';

const seconds = Number(process.argv[2] ?? 12);
const cx = await client(9222, null, { allowMany: true, focus: false });
const timeOrigin = Number(await evaluate(cx, 'String(performance.timeOrigin)'));

await evaluate(
  cx,
  `(function () {
     window.__hb = [];
     window.__hbTimer = setInterval(function () { window.__hb.push(Math.round(performance.now())); }, 50);
     return 'armed';
   })()`
);
console.log(
  `armed at +${Math.round(Date.now() - timeOrigin)} ms (timeOrigin ${new Date(timeOrigin).toISOString()})`
);

await new Promise((r) => setTimeout(r, seconds * 1000));
const beats = JSON.parse(await evaluate(cx, 'JSON.stringify(window.__hb || [])'));
await evaluate(cx, 'clearInterval(window.__hbTimer), "stopped"');

console.log(`${beats.length} beats between +${beats[0]} ms and +${beats.at(-1)} ms`);
let worst = 0;
for (let i = 1; i < beats.length; i++) {
  const gap = beats[i] - beats[i - 1];
  // 150 ms is three missed beats: enough that scheduling jitter cannot explain it.
  if (gap > 150)
    console.log(`  GAP ${String(gap).padStart(5)} ms   +${beats[i - 1]} -> +${beats[i]}`);
  worst = Math.max(worst, gap);
}
console.log(`worst gap ${worst} ms`);
cx.close();
