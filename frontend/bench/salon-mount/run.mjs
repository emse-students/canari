/**
 * The salon open, measured in a real Chrome on a production build of the components.
 * NOT GATED BY CI: a hand-run instrument whose numbers are a SHAPE, never a phone's number.
 *
 *   bun bench/salon-mount/run.mjs [--scene pane|hub] [--runs 7] [--rows 200] [--shape own|mixed]
 *                                 [--cpu 4] [--profile <dir>] [--no-build] [--compare <dir>]
 *
 * What it answers: how long a salon whose page is already in memory takes to show its last
 * messages, how many rows were mounted to get there, which long tasks it cost, and how many
 * warnings the engine printed on the way (and every `error` event, a ResizeObserver loop included),
 * plus the style recalculations and layouts the engine ran for it - the "salon open" of
 * docs/wiki/frontend/community-open-budget.md, with nothing else on the thread.
 *   --scene pane   `ChatArea` mounted over the salon (default).
 *   --scene hub    the communities hub drawn first (sidebar: ten communities), then the tap on a
 *                  salon row: the pane takes the salon, the sidebar hides, the listing refreshes.
 *
 * What it does NOT answer: the phone's number. Desktop V8 under `--cpu` throttling is a SHAPE (the
 * same work, scaled), never the Mi 9T's milliseconds; and the session, MLS and the network are
 * absent by construction.
 *
 * Each run is a fresh page (cold JIT, as a first open after a launch) that opens the salon twice:
 * `first` and `reopen` (warm, as a same-process reopen). Chrome is launched here, headless, on a
 * throwaway profile; `CHROME_PATH` overrides where it is looked for. `BENCH_READABLE=1` builds
 * unminified, for a profile read with `tools/cold-start/profile-summary.mjs`.
 *
 * A BEFORE/AFTER IS INTERLEAVED, NEVER TWO SESSIONS. `--compare <dir>` serves a second build (made
 * from the baseline tree with `BENCH_OUT=<dir> bun x vite build --config bench/salon-mount/vite.config.ts`)
 * and alternates the two arms run by run, so a busy machine slows both alike.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const here = import.meta.dirname;
const frontend = resolve(here, '../..');
const outDir = join(frontend, 'node_modules/.cache/bench-salon-mount');

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const SCENE = opt('scene', 'pane');
const RUNS = Number(opt('runs', 7));
const ROWS = Number(opt('rows', 200));
const SHAPE = opt('shape', 'own');
const CPU = Number(opt('cpu', 4));
const PROFILE_DIR = opt('profile', null);
const COMPARE = opt('compare', null);
/** The arms, each a build served under its own path prefix. */
const ARMS = COMPARE ? { this: outDir, base: resolve(COMPARE) } : { this: outDir };
/** The Mi 9T's viewport in CSS pixels (1080 x 2340 at a 2.625 ratio). */
const VIEWPORT = { width: 411, height: 891, deviceScaleFactor: 2.625, mobile: true };
const ENTRY = { pane: 'open', hub: 'openFromHub' }[SCENE];
if (!ENTRY) throw new Error(`--scene is pane or hub, not ${SCENE}`);

if (!args.includes('--no-build')) {
  console.log('building the bench (production Svelte, the app sheet)...');
  const b = spawnSync(
    process.execPath,
    ['x', 'vite', 'build', '--config', join(here, 'vite.config.ts')],
    { cwd: frontend, stdio: 'inherit' }
  );
  if (b.status !== 0) process.exit(b.status ?? 1);
}

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const [, arm, ...rest] = new URL(req.url).pathname.split('/');
    const file = ARMS[arm] ? join(ARMS[arm], ...rest) : null;
    return file && existsSync(file)
      ? new Response(Bun.file(file))
      : new Response('not found', { status: 404 });
  },
});
const pageUrl = (arm) => `http://127.0.0.1:${server.port}/${arm}/bench/salon-mount/index.html`;

/** Where Chrome usually is, per platform; `CHROME_PATH` wins. */
function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error(`no Chrome found; set CHROME_PATH (tried ${candidates.join(', ')})`);
  return found;
}

const profileDir = mkdtempSync(join(tmpdir(), 'salon-mount-'));
const chrome = spawn(
  chromePath(),
  [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  { stdio: 'ignore' }
);

/** The port Chrome picked, read from the file it writes once listening. */
async function devtoolsPort() {
  const file = join(profileDir, 'DevToolsActivePort');
  for (let i = 0; i < 200; i++) {
    if (existsSync(file)) {
      const [p] = readFileSync(file, 'utf8').split('\n');
      if (p) return Number(p);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Chrome never opened its devtools port');
}

/**
 * A minimal CDP session over one page socket. `warnings` counts what the ENGINE printed (the `Log`
 * domain: an invalid keyframe, a CSS parse error), which no `console.*` call ever reaches.
 */
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const session = { warnings: new Map() };
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(m.data);
    if (msg.method === 'Log.entryAdded') {
      const text = msg.params.entry.text.slice(0, 60);
      session.warnings.set(text, (session.warnings.get(text) ?? 0) + 1);
    }
    if (msg.id && pending.has(msg.id)) {
      const { ok, ko } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) ko(new Error(`${msg.error.message} (${msg.error.code})`));
      else ok(msg.result);
    }
  });
  const ready = new Promise((ok, ko) => {
    ws.addEventListener('open', ok);
    ws.addEventListener('error', () => ko(new Error(`ws error on ${wsUrl}`)));
  });
  return Object.assign(session, {
    ready,
    send(method, params = {}) {
      const n = ++id;
      ws.send(JSON.stringify({ id: n, method, params }));
      return new Promise((ok, ko) => pending.set(n, { ok, ko }));
    },
    close: () => ws.close(),
  });
}

async function evaluate(cx, expression) {
  const r = await cx.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails)
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

/**
 * The engine's own counters (`Performance.getMetrics`): how many style recalculations and layouts
 * ran, and for how long, whoever triggered them - a read inside a script (forced) or the rendering
 * step (natural). A CPU profile books a forced layout to the JavaScript that read, so moving the read
 * moves the milliseconds to the next reader without removing any; these counts are what says
 * whether a change REMOVED work (2026-11-08, community-open-budget).
 */
async function engineMetrics(cx) {
  const { metrics } = await cx.send('Performance.getMetrics');
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
}

const median = (xs) => {
  const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const port = await devtoolsPort();
const readings = Object.fromEntries(Object.keys(ARMS).map((a) => [a, { first: [], reopen: [] }]));
if (PROFILE_DIR) mkdirSync(PROFILE_DIR, { recursive: true });
try {
  for (let i = 0; i < RUNS * Object.keys(ARMS).length; i++) {
    const arm = Object.keys(ARMS)[i % Object.keys(ARMS).length];
    const run = Math.floor(i / Object.keys(ARMS).length) + 1;
    const target = await (
      await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
    ).json();
    const cx = connect(target.webSocketDebuggerUrl);
    await cx.ready;
    await cx.send('Emulation.setDeviceMetricsOverride', VIEWPORT);
    await cx.send('Emulation.setCPUThrottlingRate', { rate: CPU });
    await cx.send('Page.enable');
    await cx.send('Log.enable');
    await cx.send('Performance.enable');
    await cx.send('Page.navigate', { url: pageUrl(arm) });
    for (let i = 0; i < 400; i++) {
      if (await evaluate(cx, 'typeof window.__salonBench === "object"').catch(() => false)) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const options = JSON.stringify({ rows: ROWS, shape: SHAPE, settleMs: 1500 });
    for (const which of ['first', 'reopen']) {
      const profiling = PROFILE_DIR && run === 1 && arm === 'this';
      if (profiling) {
        await cx.send('Profiler.enable');
        await cx.send('Profiler.setSamplingInterval', { interval: 200 });
        await cx.send('Profiler.start');
      }
      cx.warnings.clear();
      const before = await engineMetrics(cx);
      const r = await evaluate(cx, `window.__salonBench.${ENTRY}(${options})`);
      const after = await engineMetrics(cx);
      r.layouts = after.LayoutCount - before.LayoutCount;
      r.layoutMs = (after.LayoutDuration - before.LayoutDuration) * 1000;
      r.styles = after.RecalcStyleCount - before.RecalcStyleCount;
      r.styleMs = (after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000;
      if (profiling) {
        const { profile } = await cx.send('Profiler.stop');
        writeFileSync(join(PROFILE_DIR, `${SCENE}-${which}.cpuprofile`), JSON.stringify(profile));
      }
      for (const text of r.errors ?? []) {
        const key = `error event: ${text.slice(0, 48)}`;
        cx.warnings.set(key, (cx.warnings.get(key) ?? 0) + 1);
      }
      r.warnings = [...cx.warnings.values()].reduce((a, b) => a + b, 0);
      readings[arm][which].push(r);
      const lt = r.longTasks.map(([s, d]) => `${d}@${s}`).join(' ');
      const said = [...cx.warnings].map(([text, n]) => `${n} x "${text}"`).join('; ');
      console.log(
        `run ${run} ${arm.padEnd(4)} ${which.padEnd(6)} gesture ${r.mountMs.toFixed(0).padStart(4)} reveal ${String(Math.round(r.revealMs)).padStart(4)} rows ${r.rowsAtReveal}->${r.rowsSettled} layouts ${r.layouts} (${r.layoutMs.toFixed(0)} ms) styles ${r.styles} (${r.styleMs.toFixed(0)} ms)  long tasks [${lt}]${said ? `  engine: ${said}` : ''}`
      );
    }
    cx.close();
    await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`);
  }
} finally {
  // The profile directory stays locked until Chrome has EXITED, not merely been signalled.
  const exited = new Promise((r) => chrome.once('exit', r));
  chrome.kill();
  await exited;
  server.stop(true);
  rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

console.log(
  `\n${SCENE}: ${ROWS} rows (${SHAPE}), cpu x${CPU}, ${VIEWPORT.width}x${VIEWPORT.height}, ${RUNS} runs - medians:`
);
for (const [arm, which] of Object.keys(ARMS).flatMap((a) => [
  [a, 'first'],
  [a, 'reopen'],
])) {
  const rs = readings[arm][which];
  const longest = rs.map((r) => Math.max(0, ...r.longTasks.map(([, d]) => d)));
  console.log(
    `  ${arm.padEnd(4)} ${which.padEnd(6)} gesture ${median(rs.map((r) => r.mountMs)).toFixed(0)} ms, reveal ${median(rs.map((r) => r.revealMs)).toFixed(0)} ms, longest task ${median(longest)} ms, rows at reveal ${median(rs.map((r) => r.rowsAtReveal))}, settled ${median(rs.map((r) => r.rowsSettled))}, layouts ${median(rs.map((r) => r.layouts))} (${median(rs.map((r) => r.layoutMs)).toFixed(0)} ms), styles ${median(rs.map((r) => r.styles))} (${median(rs.map((r) => r.styleMs)).toFixed(0)} ms), engine warnings ${median(rs.map((r) => r.warnings))}`
  );
}
