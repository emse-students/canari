/**
 * WHAT THE RENDERER'S MAIN THREAD DID BETWEEN THE TAB TAP AND THE SALON ROWS - by kind, and when.
 *
 * Reads a trace written by `community-open.mjs --trace` (the tab tap to the target community's
 * salons). A CPU profile files style, layout, paint, parsing and the input pipeline under one
 * `(program)` bucket; the trace names them. The page's
 * marks are `performance.now()` values and the trace is on the monotonic clock, so the two are put
 * on one axis by the `touchstart` dispatch, which IS the tap mark (`tapHub`, taken in a capturing
 * `touchstart` listener).
 *
 *   bun tools/cold-start/trace-summary.mjs <trace.json> [--slot 25]
 *
 * Prints the input events (touchstart, touchend, click) with their delay from the tap, the
 * EXCLUSIVE time of every event kind inside [tap, salons] (a `FunctionCall` minus the `Layout` it
 * forced, and so on), and per slot what took it. Main thread only (`CrRendererMain`).
 */
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const SLOT = Number(opt('slot', 25));
const { traceEvents, marks } = JSON.parse(readFileSync(args[0], 'utf8'));

const mainTids = new Set(
  traceEvents
    .filter((e) => e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain')
    .map((e) => `${e.pid}:${e.tid}`)
);
const onMain = (e) => mainTids.has(`${e.pid}:${e.tid}`);

/** Complete events on the main thread; B/E pairs folded into X. */
const complete = [];
const open = new Map();
for (const e of traceEvents) {
  if (!onMain(e)) continue;
  if (e.ph === 'X') complete.push({ name: e.name, ts: e.ts, dur: e.dur ?? 0, args: e.args });
  else if (e.ph === 'B') open.set(`${e.tid}:${e.name}`, e);
  else if (e.ph === 'E') {
    const b = open.get(`${e.tid}:${e.name}`);
    if (b) complete.push({ name: e.name, ts: b.ts, dur: e.ts - b.ts, args: b.args });
  }
}
complete.sort((a, b) => a.ts - b.ts || b.dur - a.dur);

const dispatches = complete.filter((e) => e.name === 'EventDispatch');
const touch = dispatches.find((e) => e.args?.data?.type === 'touchstart');
if (!touch)
  throw new Error('no touchstart dispatch in the trace - nothing to anchor the page marks on');
const zero = touch.ts; // = marks.tapHub
const at = (ts) => (ts - zero) / 1000;
const rel = (m) => (m == null ? '-' : `+${m - marks.tapHub}`);
const end = (marks.targetSalons ?? marks.salons) - marks.tapHub;
console.log(
  `tap at trace ${zero}; rail ${rel(marks.rail)}, salons ${rel(marks.salons)}, rail tap ${rel(marks.tapTarget)}, target salons ${rel(marks.targetSalons)} (ms)`
);

console.log('\ninput');
for (const e of dispatches.filter((d) => at(d.ts) >= -5 && at(d.ts) <= end)) {
  console.log(
    `  +${at(e.ts).toFixed(1).padStart(7)}  ${e.args?.data?.type} (${(e.dur / 1000).toFixed(1)} ms)`
  );
}

/** Exclusive time: each event minus its direct children (nesting by containment on one thread). */
const stack = [];
const exclusive = [];
for (const e of complete) {
  while (stack.length && stack.at(-1).ts + stack.at(-1).dur <= e.ts) stack.pop();
  const parent = stack.at(-1);
  const node = { ...e, self: e.dur, depth: stack.length };
  if (parent && e.ts + e.dur <= parent.ts + parent.dur) parent.self -= e.dur;
  exclusive.push(node);
  stack.push(node);
}

const inWindow = exclusive.filter((e) => at(e.ts) >= 0 && at(e.ts) <= end);
const total = new Map();
for (const e of inWindow) total.set(e.name, (total.get(e.name) ?? 0) + e.self);
console.log(`\nexclusive main-thread time in [tap, salons] (${end} ms)`);
let busy = 0;
for (const [k, v] of [...total.entries()].sort((a, b) => b[1] - a[1])) {
  if (v < 1000) continue;
  busy += v;
  console.log(`  ${(v / 1000).toFixed(1).padStart(7)}  ${k}`);
}
console.log(`  ${(busy / 1000).toFixed(1).padStart(7)}  (sum of the above)`);

console.log(`\nper ${SLOT} ms slot, top-level events that START in it (duration)`);
for (const e of exclusive.filter(
  (x) => x.depth === 0 && at(x.ts) >= -5 && at(x.ts) <= end && x.dur >= 2000
)) {
  const kids = exclusive
    .filter((x) => x.ts >= e.ts && x.ts + x.dur <= e.ts + e.dur && x !== e && x.self >= 3000)
    .map(
      (x) =>
        `${x.name}${x.args?.data?.type ? `:${x.args.data.type}` : ''}${x.args?.data?.url ? `@${x.args.data.url.split('/').pop()}` : ''} ${(x.self / 1000).toFixed(0)}`
    )
    .slice(0, 6);
  console.log(
    `  +${at(e.ts).toFixed(0).padStart(5)}  ${(e.dur / 1000).toFixed(1).padStart(6)}  ${e.name}${e.args?.data?.type ? `:${e.args.data.type}` : ''}  [${kids.join(', ')}]`
  );
}
