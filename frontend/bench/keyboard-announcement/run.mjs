/**
 * THE ANDROID KEYBOARD ANNOUNCEMENT, IN A REAL CHROMIUM (keyboard-and-send-motion.md, section 6: the
 * leaf channel). NOT GATED BY CI: a hand-run instrument, like `bench/salon-mount`.
 *
 *   bun bench/keyboard-announcement/run.mjs [--rows 200] [--cpu 4] [--no-build]
 *
 * `ChatArea` over a synthetic salon, the app's own sheet, the keyboard store initialised as the app
 * does, a phone viewport and an Android user agent; then the shell's announcement, `canariImeTarget(
 * { px, durationMs, curve })`, a rise and a fall. What it ASSERTS (and exits 1 on), each a fact of the
 * engine, never a time:
 *
 * - the announcement's task writes NO style on `:root` - any custom property there restyles the
 *   whole document - and writes the riding pieces (`[data-keyboard-leaf]`);
 * - the ride starts in the first rendering update after the announcement;
 * - the root is written in a later rendering update than the ride's first frame, and that write
 *   moves no riding piece: the footer's
 *   offset and height, the thread's `scrollTop`, its padding and its last row's offset are the same
 *   numbers before and after it.
 *
 * What it REPORTS, as a shape (desktop V8 under `--cpu` throttling, never the Mi 9T's milliseconds):
 * what one write costs in forced style, on `:root` and on one piece, registered or not
 * (`__kbBench.styleCost`) - the measurement the leaf channel was chosen by.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { closeChrome, launchChrome } from '../../../tools/headless-chrome/chrome.mjs';

const here = import.meta.dirname;
const frontend = resolve(here, '../..');
const outDir = join(frontend, 'node_modules/.cache/bench-keyboard-announcement');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const ROWS = Number(opt('rows', 200));
const CPU = Number(opt('cpu', 4));
/** The Mi 9T's viewport in CSS pixels, and an Android Chrome's user agent (the store asks the OS). */
const VIEWPORT = { width: 411, height: 891, deviceScaleFactor: 2.625, mobile: true };
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 16; Mi 9T) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36';
/** The Mi 9T's keyboard, in CSS px. */
const KEYBOARD_PX = 357.98;

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
  hostname: '127.0.0.1',
  fetch(req) {
    const path = new URL(req.url).pathname;
    // A root-relative asset the app fetches itself is served from `static/`, as the app serves it.
    const built = join(outDir, path);
    const file = existsSync(built) ? built : join(frontend, 'static', path);
    return existsSync(file)
      ? new Response(Bun.file(file))
      : new Response('not found', { status: 404 });
  },
});

const live = new Set();
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};
let side;
try {
  side = await launchChrome({
    name: 'keyboard-announcement',
    profile: join(tmpdir(), 'canari-keyboard-announcement'),
    url: 'about:blank',
    readyTitle: '',
    live,
  });
  const { cdp } = side;
  await cdp.send('Emulation.setDeviceMetricsOverride', VIEWPORT);
  await cdp.send('Emulation.setUserAgentOverride', { userAgent: ANDROID_UA });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
  await cdp.send('Page.navigate', {
    url: `http://127.0.0.1:${server.port}/bench/keyboard-announcement/index.html`,
  });
  for (let i = 0; i < 400; i++) {
    if (await cdp.eval('typeof window.__kbBench === "object"').catch(() => false)) break;
    await Bun.sleep(25);
  }
  const elements = await cdp.eval(`window.__kbBench.ready(${ROWS})`);
  console.log(`salon mounted: ${ROWS} messages, ${elements} elements, cpu x${CPU}`);

  for (const [what, px] of [
    ['rise', KEYBOARD_PX],
    ['fall', 0],
  ]) {
    const r = await cdp.eval(`window.__kbBench.announce(${px})`);
    console.log(`${what}: ${JSON.stringify(r)}`);
    check(r.rootWritesInTask === 0, `${what}: the announcement's task writes nothing on :root`);
    check(r.leafWritesInTask >= 2, `${what}: it writes the riding pieces (footer, thread)`);
    check(r.framesToRide === 1, `${what}: the ride starts in the first rendering update`);
    check(
      r.rootWrittenAfterRide && r.framesAtRoot > r.framesToRide,
      `${what}: the root is written in a later rendering update than the ride's first frame`
    );
    check(r.riding.rows, `${what}: the thread's rows ride`);
    // Reported, not asserted: the band's ride belongs to the base branch (section 6, owed).
    console.log(`     ${what}: the composer band ${r.riding.composer ? 'rides' : 'does NOT ride'}`);
    check(
      JSON.stringify(r.layoutAtRide) === JSON.stringify(r.layoutAfterRoot),
      `${what}: the root write moves no riding piece`
    );
    await cdp.eval('new Promise((r) => setTimeout(r, 600))');
  }

  const cost = await cdp.eval('window.__kbBench.styleCost()');
  console.log('\nforced style after one write, median ms (a shape, not a phone):');
  for (const [k, v] of Object.entries(cost)) console.log(`  ${k.padEnd(32)} ${v}`);
} finally {
  if (side) await closeChrome(side, { live });
  server.stop(true);
}

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nevery check passed');
