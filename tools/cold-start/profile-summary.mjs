/**
 * WHAT A CPU PROFILE OF A PAGE MOUNT IS MADE OF - self and inclusive time, by chunk and by function.
 *
 * Reads a `.cpuprofile` written by `community-open.mjs --profile` (the tab tap to the salon rows)
 * and prints where its samples went: the V8 buckets (`(program)` = native work outside JavaScript -
 * style, layout, parse; `(garbage collector)`; `(idle)`), then self time per chunk, then the
 * functions with the most self and the most inclusive time.
 *
 *   bun tools/cold-start/profile-summary.mjs <file.cpuprofile> [--top 30] [--sources <dir>]
 *       [--timeline <ms>] [--tree <ms>] [--trace <trace.json> --from <ms> --to <ms>]
 *
 * A release build is minified, so a function is named by `chunk:line:col`. `--sources <dir>` holds
 * the chunks as the WebView parsed them (dumped with `Debugger.getScriptSource`, file names = the
 * URL path with `/` as `__`), and prints 90 characters of code at each hot position - a Svelte
 * component is recognisable by the template string it carries.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const file = args[0];
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const TOP = Number(opt('top', 30));
const SOURCES = opt('sources', null);

const profile = JSON.parse(readFileSync(file, 'utf8'));
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);

/**
 * `--trace <file> --from <ms> --to <ms>`: only the samples taken in that window, in ms from the tap
 * as the trace of the SAME run anchors it (`trace-summary.mjs`: the `touchstart` dispatch). A profile
 * and a trace share the renderer's monotonic clock, so a slot the trace names can be opened here.
 */
const TRACE_FILE = opt('trace', null);
let windowUs = null;
if (TRACE_FILE) {
  const { traceEvents } = JSON.parse(readFileSync(TRACE_FILE, 'utf8'));
  const touch = traceEvents.find(
    (e) => e.name === 'EventDispatch' && e.args?.data?.type === 'touchstart'
  );
  if (!touch) throw new Error(`${TRACE_FILE}: no touchstart dispatch to anchor on`);
  windowUs = [touch.ts + Number(opt('from', 0)) * 1000, touch.ts + Number(opt('to', 1e9)) * 1000];
}

/** Microseconds of samples per node id. */
const self = new Map();
let sampleTs = profile.startTime;
for (let i = 0; i < profile.samples.length; i++) {
  sampleTs += profile.timeDeltas[i] ?? 0;
  if (windowUs && (sampleTs < windowUs[0] || sampleTs > windowUs[1])) continue;
  const dt = profile.timeDeltas[i + 1] ?? 0;
  self.set(profile.samples[i], (self.get(profile.samples[i]) ?? 0) + dt);
}

const short = (url) => (url ? url.replace(/^https?:\/\/[^/]+\//, '') : '');
const keyOf = (cf) =>
  `${cf.functionName || '(anon)'} ${short(cf.url)}:${cf.lineNumber + 1}:${cf.columnNumber + 1}`;
const ms = (us) => (us / 1000).toFixed(1);

const total = [...self.values()].reduce((a, b) => a + b, 0);
const bucket = new Map();
const chunk = new Map();
const fnSelf = new Map();
const fnIncl = new Map();
for (const [id, us] of self) {
  const node = byId.get(id);
  const cf = node.callFrame;
  if (!cf.url) bucket.set(cf.functionName, (bucket.get(cf.functionName) ?? 0) + us);
  else chunk.set(short(cf.url), (chunk.get(short(cf.url)) ?? 0) + us);
  fnSelf.set(keyOf(cf), (fnSelf.get(keyOf(cf)) ?? 0) + us);
  // Inclusive: once per distinct function on the stack, so recursion is not counted twice.
  const seen = new Set();
  for (let at = id; at !== undefined; at = parent.get(at)) {
    const k = keyOf(byId.get(at).callFrame);
    if (seen.has(k)) continue;
    seen.add(k);
    fnIncl.set(k, (fnIncl.get(k) ?? 0) + us);
  }
}

const sorted = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);
const snippet = (key) => {
  if (!SOURCES) return '';
  const m = key.match(/ (.+):(\d+):(\d+)$/);
  if (!m) return '';
  const path = join(SOURCES, m[1].replace(/[/?]/g, '__'));
  if (!existsSync(path)) return '';
  const line = readFileSync(path, 'utf8').split('\n')[Number(m[2]) - 1] ?? '';
  return `\n      ${line.slice(Number(m[3]) - 1, Number(m[3]) + 89).replace(/\s+/g, ' ')}`;
};

console.log(`${file}: ${ms(total)} ms sampled`);
console.log('\nV8 buckets');
for (const [k, v] of sorted(bucket)) console.log(`  ${ms(v).padStart(8)}  ${k}`);
console.log('\nself time per chunk');
for (const [k, v] of sorted(chunk).slice(0, TOP)) console.log(`  ${ms(v).padStart(8)}  ${k}`);
console.log('\nself time per function');
for (const [k, v] of sorted(fnSelf).slice(0, TOP))
  console.log(`  ${ms(v).padStart(8)}  ${k}${snippet(k)}`);
console.log('\ninclusive time per function');
for (const [k, v] of sorted(fnIncl).slice(0, TOP))
  console.log(`  ${ms(v).padStart(8)}  ${k}${snippet(k)}`);

/**
 * `--timeline <ms>`: per slot of that many ms from the profile's start, the root children that
 * took it - which work ran WHEN between the tap and the rows. The deepest frame named in
 * `--mark <chunk:line:col>` on a sample's stack is shown instead, to follow one function.
 */
const SLOT = opt('timeline', null);
if (SLOT !== null) {
  const marks = args.flatMap((a, i) => (args[i - 1] === '--mark' ? [a] : []));
  const top = (id) => {
    let at = id;
    let label = null;
    while (at !== undefined) {
      const k = keyOf(byId.get(at).callFrame);
      if (!label && marks.some((m) => k.endsWith(m))) label = k;
      const up = parent.get(at);
      if (up === profile.nodes[0].id || up === undefined) return label ?? k;
      at = up;
    }
    return label;
  };
  const slots = [];
  let t = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    t += profile.timeDeltas[i] ?? 0;
    const s = Math.floor(t / 1000 / Number(SLOT));
    slots[s] ??= new Map();
    const k = top(profile.samples[i]);
    const dt = profile.timeDeltas[i + 1] ?? 0;
    slots[s].set(k, (slots[s].get(k) ?? 0) + dt);
  }
  console.log(`\ntimeline (${SLOT} ms slots)`);
  slots.forEach((m, i) => {
    if (!m) return;
    const parts = sorted(m)
      .filter(([, v]) => v >= 2000)
      .map(([k, v]) => `${ms(v)} ${k}`);
    console.log(`  ${String(i * Number(SLOT)).padStart(5)}  ${parts.join(' | ')}`);
  });
}

/** `--tree <ms>`: the call tree top-down, every node of at least that many ms inclusive. */
const TREE = opt('tree', null);
if (TREE !== null) {
  const incl = new Map();
  const sum = (id) => {
    const n = byId.get(id);
    const v = (self.get(id) ?? 0) + (n.children ?? []).reduce((s, c) => s + sum(c), 0);
    incl.set(id, v);
    return v;
  };
  const root = profile.nodes[0].id;
  sum(root);
  console.log(`\ncall tree (>= ${TREE} ms)`);
  const walk = (id, depth) => {
    const n = byId.get(id);
    const kids = (n.children ?? []).filter((c) => incl.get(c) >= Number(TREE) * 1000);
    kids.sort((a, b) => incl.get(b) - incl.get(a));
    // A chain of single children is printed flat, so the tree stays readable at depth 60.
    const linear = kids.length === 1 && incl.get(kids[0]) > incl.get(id) * 0.97;
    if (!linear || depth === 0)
      console.log(
        `${' '.repeat(Math.min(depth, 40))}${ms(incl.get(id)).padStart(7)} ${keyOf(n.callFrame)}`
      );
    for (const c of kids) walk(c, linear ? depth : depth + 1);
  };
  walk(root, 0);
}
