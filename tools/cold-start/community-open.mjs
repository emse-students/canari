/**
 * OPENING A COMMUNITY ON A PHONE: THE HUB, ITS SALONS, A SALON'S MESSAGES - ON ONE AXIS.
 *
 * What it answers: how long a member waits between tapping "Communautes" and seeing the rail, the
 * salon list and then a salon's messages - cold (process killed) or warm (backgrounded) - and WHAT
 * that wait is made of: the WebView's requests (CDP `Network`), the native IPC calls (on Android
 * every Tauri `invoke` is a request to `http://ipc.localhost/<command>`, so the same domain sees
 * them, named), long tasks, main-thread gaps, the app's own console lines and the native logcat.
 *
 * One run is the gesture a member makes, every milestone timed in the page from the frame it holds:
 *   1. (cold) force-stop, `am start`; (warm) Feed tab, HOME, 10 s, `am start` (a resume);
 *   2. tap "Communautes" AS SOON AS the bottom nav is on screen - the impatient member, the case
 *      that shows what the hub waits on (`--settle <ms>` waits first instead);
 *   3. the rail (one community button), then the salon list (one `data-channel-row`);
 *   4. if the hub shows another community, tap `--community` in the rail and wait for ITS salons;
 *   5. tap its first salon: the pane (composer) and the messages (one `msg-*` bubble);
 *   6. back, tap ANOTHER community, wait for its salons, open its first salon (the pane only: a
 *      salon may be empty);
 *   7. back, `--community` again, its first salon again - the in-session reopen.
 *
 *   bun tools/cold-start/community-open.mjs --community Bench126 --runs 5 --start cold --net none --cpu 1 --out <dir>
 *
 *   --start cold|warm     killed process vs backgrounded one (default cold)
 *   --net none|slow3g|airplane
 *                         slow3g ADDS 400 ms and 400 kbit/s (bytes / 50 000 B/s) to every response
 *                         of a call made through `window.fetch` to the API - see `SLOW_LINK` for why
 *                         it is a shim and not CDP's network emulation. `airplane` turns Wi-Fi and
 *                         mobile data off on the device (`svc`) before the launch - the only true
 *                         offline - and back on after the run.
 *   --cpu 1|4|6           CDP `Emulation.setCPUThrottlingRate` (the WebView renderer only)
 *   --settle <ms>         wait this long after the nav appears before the first tap (default 0)
 *   --timeout <ms>        per milestone (default 60000)
 *   --profile             a V8 CPU profile (200 us sampling) from the tab tap to the salon rows,
 *                         written to `<out>/profile-<label>-<run>.cpuprofile` - what the first
 *                         mount of the page is made of (`profile-summary.mjs` reads it)
 *   --before-tap <js>     an expression evaluated in the page once the nav is on screen, before the
 *                         tap: a CSS or DOM change tried on the INSTALLED build (an APK carries its
 *                         own bundle, so this is the only way to read a candidate on the phone
 *                         before a pre-release). Label such a run as the emulation it is.
 *   --trace               the renderer's trace over the same window (`trace-<label>-<run>.json`):
 *                         input dispatch, script, style, layout, paint - what a profile files under
 *                         `(program)` (`trace-summary.mjs` reads it)
 *
 * WHAT A COLD RUN CANNOT THROTTLE: everything before the attach (~350 ms after `timeOrigin` on the
 * Mi 9T). `attach` is printed so a reader knows how much ran unthrottled.
 *
 * `ANDROID_SERIAL` picks the handset. Rows go to `<out>/runs.ndjson` (one JSON per run, with the
 * raw console, requests and logcat), medians and worsts to `<out>/summary-<label>.json`. The
 * evidence holds a bench account's conversations at most - keep it off the repository all the same.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, evaluate, listTargets } from '../cross-client-harness/cdp.mjs';
import { adb, deviceSerial, forceStop, launch, pidOf, waitMs } from './device.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const RUNS = Number(opt('runs', 5));
const START = opt('start', 'cold');
const NET = opt('net', 'none');
const CPU = Number(opt('cpu', 1));
const SETTLE = Number(opt('settle', 0));
const TIMEOUT = Number(opt('timeout', 60000));
const TARGET = opt('community', null);
const LABEL = opt('label', `${START}-${NET}-cpu${CPU}`);
const OUT = opt('out', join(tmpdir(), `community-open-${Date.now()}`));
const PORT = Number(opt('port', 9333));
const PROFILE = args.includes('--profile');
const BEFORE_TAP = opt('before-tap', null);
const TRACE = args.includes('--trace');
/** What `--trace` records: the renderer's timeline (input, script, style, layout, paint) and V8's script work. */
const TRACE_CATEGORIES = [
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'v8.execute',
  'v8',
  'blink.user_timing',
  'loading',
  'input',
  'latencyInfo',
].join(',');
mkdirSync(OUT, { recursive: true });

const NETWORKS = { none: null, slow3g: { rtt: 400, bps: 50000 }, airplane: null };
if (!(NET in NETWORKS)) throw new Error(`--net ${NET}: one of ${Object.keys(NETWORKS).join(', ')}`);
if (!TARGET)
  throw new Error('--community <name>: the community whose salon is opened and reopened');

const serial = await deviceSerial();
console.log(`device ${serial}, ${RUNS} run(s), ${LABEL}, target ${TARGET}, evidence in ${OUT}`);

/**
 * A SLOW LINK, EMULATED WHERE THE APP'S REQUESTS ACTUALLY GO.
 *
 * CDP's `Network.emulateNetworkConditions` is the wrong tool on this app and was measured to be:
 * on Tauri Android `hooks.client.ts` routes every first-party `/api` call through `plugin-http`
 * (reqwest, in Rust), so the WebView's network stack carries only the bundled assets, the IPC
 * itself (`http://ipc.localhost/<command>`) and the odd `<img>`. Throttling it delays every IPC
 * call and every local chunk - a phone that never existed - and leaves the API untouched.
 *
 * So `window.fetch` is wrapped, through an accessor so the app's own later assignment of the
 * routed fetch is wrapped too: a response from an `https://...canari...` origin is handed back
 * `rtt + bytes / bps` ms after it really arrived. ADDED to the real link, never instead of it. Not
 * delayed: `TauriMlsService`'s own `plugin-http` calls (the MLS delivery: key packages, commits,
 * welcomes), the native WebSocket, and `<img>` avatars.
 */
const SLOW_LINK = (cfg) => `(function (cfg) {
  if (window.__cobNet) { window.__cobNet.cfg = cfg; window.__cobNet.log = []; return 'updated'; }
  var N = window.__cobNet = { cfg: cfg, log: [], depth: 0 };
  // ONE RECORD AND ONE DELAY PER CALL. The app assigns \`window.fetch\` more than once and its router
  // hands some calls to the fetch it found before, which is a wrapper too: without this guard a
  // refresh POST was recorded (and delayed) three times. The inner call is synchronous, so a depth
  // counter around it is exact.
  function wrap(f) {
    return function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || String(input);
      if (N.depth > 0 || !/^https:[/][/][^/]*canari/.test(url)) return f.call(window, input, init);
      var rec = [url.replace(/^https:[/][/][^/]+/, '').slice(0, 160), Math.round(performance.now()), null, null, (init && init.method) || 'GET'];
      N.log.push(rec);
      var p;
      N.depth++;
      try { p = f.call(window, input, init); } finally { N.depth--; }
      return p.then(function (res) {
        rec[5] = Math.round(performance.now());
        return res.clone().arrayBuffer().then(function (b) {
          rec[3] = b.byteLength;
          var c = N.cfg;
          var wait = c ? c.rtt + (b.byteLength * 1000) / c.bps : 0;
          return new Promise(function (r) { setTimeout(function () { rec[2] = Math.round(performance.now()); r(res); }, wait); });
        }, function () { rec[2] = Math.round(performance.now()); return res; });
      }, function (e) { rec[2] = Math.round(performance.now()); rec[3] = 'failed'; throw e; });
    };
  }
  var inner = window.fetch;
  var wrapped = wrap(inner);
  Object.defineProperty(window, 'fetch', { configurable: true, get: function () { return wrapped; }, set: function (v) { inner = v; wrapped = wrap(v); } });
  return 'installed';
})(${JSON.stringify(cfg)})`;

/**
 * The page half: a 50 ms heartbeat, a long-task observer, a touch recorder and a per-frame
 * milestone watcher (a mark is the `requestAnimationFrame` in which its predicate first held, so a
 * blocked main thread delays the mark exactly as it delays the paint). Re-armed every run.
 */
const PROBE = `(function () {
  window.__cob = { marks: {}, watch: {}, hb: [], lt: [], taps: [] };
  if (window.__cobHb) clearInterval(window.__cobHb);
  window.__cobHb = setInterval(function () { window.__cob.hb.push(Math.round(performance.now())); }, 50);
  // ONE observer per page: a warm run re-arms this probe, and a second observer doubled every entry.
  if (!window.__cobLt) try {
    window.__cobLt = true;
    new PerformanceObserver(function (l) {
      l.getEntries().forEach(function (e) { window.__cob.lt.push([Math.round(e.startTime), Math.round(e.duration)]); });
    }).observe({ type: 'longtask', buffered: true });
  } catch (e) { window.__cob.ltError = String(e); }
  if (!window.__cobTouch) {
    window.__cobTouch = true;
    addEventListener('touchstart', function (e) { window.__cob.taps.push(Math.round(e.timeStamp)); }, { capture: true, passive: true });
  }
  (function frame() {
    var c = window.__cob;
    // A watch marks the first frame its condition holds AFTER a frame where it did not (see arm()).
    Object.keys(c.watch).forEach(function (k) {
      try {
        var w = c.watch[k];
        if (!w.f()) w.low = true;
        else if (w.low) { c.marks[k] = Math.round(performance.now()); delete c.watch[k]; }
      } catch (e) {}
    });
    if (c === window.__cob) requestAnimationFrame(frame);
  })();
  return JSON.stringify({ origin: performance.timeOrigin, now: performance.now() });
})()`;

const VISIBLE = `function (el) { if (!el) return false; var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight; }`;
/** The first VISIBLE match: the layout keeps collapsed 0x0 copies of the nav and of some buttons. */
const firstVisible = (selector) =>
  `[].find.call(document.querySelectorAll(${JSON.stringify(selector)}), function (e) { return e.getBoundingClientRect().width > 0; })`;
const ADD = 'button[aria-label="Ajouter une communauté"]';
const PRED = {
  nav: `!!${firstVisible('a[href="/communities"]')}`,
  rail: `(function (v) { var add = ${firstVisible(ADD)}; return !!add && [].some.call(add.parentElement.querySelectorAll('button[title]'), function (b) { return b !== add && v(b); }); })(${VISIBLE})`,
  salons: `(function (v) { return [].some.call(document.querySelectorAll('[data-channel-row]'), v); })(${VISIBLE})`,
  pane: `(function (v) { return v(document.querySelector('.chat-composer-footer')); })(${VISIBLE})`,
  messages: `(function (v) { return [].some.call(document.querySelectorAll('[id^="msg-"]'), v); })(${VISIBLE})`,
};
const hubOf = (name) =>
  `(function (v) { return [].some.call(document.querySelectorAll('h2'), function (e) { return v(e) && e.textContent.trim() === ${JSON.stringify(name)}; }) && [].some.call(document.querySelectorAll('[data-channel-row]'), v); })(${VISIBLE})`;
const NAV_TAB = firstVisible('a[href="/communities"]');
const FEED_TAB = firstVisible('a[href="/posts"]');
const FIRST_ROW = firstVisible('[data-channel-row]');
const BACK = firstVisible('button[aria-label="Retour au menu"]');
const HUB_NAME = `(function () { var h = ${firstVisible('h2')}; return h ? h.textContent.trim() : null; })()`;
const RAIL_NAMES = `(function () { var add = ${firstVisible(ADD)}; return JSON.stringify(add ? [].filter.call(add.parentElement.querySelectorAll('button[title]'), function (b) { return b !== add; }).map(function (b) { return b.title; }) : []); })()`;
const railButton = (name) => firstVisible(`button[title=${JSON.stringify(name)}]`);

/** Attaches to THIS app's WebView (the socket named after its pid), polling until it exists. */
async function attach() {
  for (let i = 0; i < 400; i++) {
    const pid = await pidOf(serial);
    if (pid) {
      const unix = await adb(serial, ['shell', 'cat', '/proc/net/unix']).catch(() => '');
      if (unix.includes(`webview_devtools_remote_${pid}`)) {
        await adb(serial, [
          'forward',
          `tcp:${PORT}`,
          `localabstract:webview_devtools_remote_${pid}`,
        ]);
        const targets = await listTargets(PORT).catch(() => []);
        const page = targets.find((t) => t.url.startsWith('http://tauri.localhost'));
        if (page) {
          const cx = connect(page.webSocketDebuggerUrl);
          await cx.ready;
          return { cx, pid };
        }
      }
    }
    await waitMs(50);
  }
  throw new Error('the app WebView never opened a devtools socket');
}

/**
 * Arms a page-side watch: from the next frame on, the page marks the frame in which it first holds.
 *
 * ARMED BEFORE THE TAP THAT CAUSES IT, together with every mark the same tap produces. Until
 * 2026-10-15 each watch was armed by `until` after the previous mark had been POLLED (every 100 ms,
 * plus a CDP round trip), so `salons` could not be marked before ~100 ms after `rail` even when the
 * rows were drawn in the same frame - measured on the Mi 9T: rows on screen from the rail's frame,
 * marked 120 ms later. `messages` after `pane` carried the same floor.
 *
 * AN EDGE, NOT A LEVEL. Arming early has its own lie: a condition ALREADY true when it is armed
 * (the previous salon's composer and bubbles still on screen during the back animation, before a
 * reopen) would mark at once, before the tap, and report a zero or negative duration as real. So a
 * watch marks only the first frame its condition holds AFTER a frame where it did not. A condition
 * that never goes false times out as `null` - a missing number, never a wrong one.
 *
 * `edge: false` is for the one LEVEL question, `nav` ("is the bar there yet"), which no tap causes
 * and which a warm resume finds already true.
 */
async function arm(cx, name, predicate, edge = true) {
  await evaluate(
    cx,
    `window.__cob.watch[${JSON.stringify(name)}] = { f: function () { return ${predicate}; }, low: ${!edge} }, 1`
  );
}

/**
 * Arms a page-side watch (unless already armed) and polls for its mark; null after `--timeout`.
 *
 * `after` is the tap the mark measures from. A mark that precedes it is REFUSED (null, and said):
 * the edge in `arm` should make that impossible, and a measurement tool that reports one anyway is
 * lying about the run, so it never reaches the row.
 */
async function until(cx, name, predicate, after = null, edge = true) {
  if (predicate) await arm(cx, name, predicate, edge);
  const deadline = Date.now() + TIMEOUT;
  while (Date.now() < deadline) {
    const m = JSON.parse(await evaluate(cx, 'JSON.stringify(window.__cob.marks)'));
    if (m[name] !== undefined) {
      if (after !== null && m[name] < after) {
        console.log(`  REFUSED mark ${name}: ${m[name]} precedes its tap at ${after}`);
        return null;
      }
      return m[name];
    }
    await waitMs(100);
  }
  return null;
}

/** A CDP touch at an element's centre. Returns the page's own `touchstart` time, or null. */
async function tap(cx, elementExpr) {
  const rect = JSON.parse(
    await evaluate(
      cx,
      `(function () { var e = ${elementExpr}; if (!e) return 'null'; var r = e.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`
    )
  );
  if (!rect) return null;
  const before = Number(await evaluate(cx, 'window.__cob.taps.length'));
  await cx.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: rect.x, y: rect.y, id: 1 }],
  });
  await waitMs(60);
  await cx.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  for (let i = 0; i < 80; i++) {
    const taps = JSON.parse(await evaluate(cx, 'JSON.stringify(window.__cob.taps)'));
    if (taps.length > before) return taps[before];
    await waitMs(25);
  }
  return null;
}

async function setNetwork(on) {
  for (const svc of [
    ['svc', 'wifi', on ? 'enable' : 'disable'],
    ['svc', 'data', on ? 'enable' : 'disable'],
  ]) {
    await adb(serial, ['shell', ...svc]).catch((e) =>
      console.log(`  ${svc.join(' ')}: ${e.message}`)
    );
  }
}

/** Opens `name`'s first salon from the hub; returns [tap, pane, messages?]. */
async function openFirstSalon(cx, key, withMessages) {
  await arm(cx, `${key}Pane`, PRED.pane);
  if (withMessages) await arm(cx, `${key}Messages`, PRED.messages);
  const tapped = await tap(cx, FIRST_ROW);
  const pane = await until(cx, `${key}Pane`, null, tapped);
  const messages = withMessages ? await until(cx, `${key}Messages`, null, tapped) : null;
  return [tapped, pane, messages];
}

async function backToHub(cx, key) {
  await tap(cx, BACK);
  return until(cx, `${key}Hub`, PRED.salons);
}

async function oneRun(index, warmCx) {
  const t0 = Date.now();
  const say = (m) => process.env.COB_VERBOSE && console.log(`  [${Date.now() - t0} ms] ${m}`);
  let cx = warmCx;
  let pid;
  if (START === 'cold') {
    await forceStop(serial);
    await waitMs(1500);
    await adb(serial, ['logcat', '-c']);
    if (NET === 'airplane') {
      await setNetwork(false);
      await waitMs(3000);
    }
    await launch(serial);
    ({ cx, pid } = await attach());
  } else {
    pid = await pidOf(serial);
    // A salon open hides the bottom nav on a phone: back to the hub first, then the Feed tab, so the
    // resume lands where a member's would and the nav is there to tap.
    await tap(cx, BACK);
    await waitMs(600);
    if ((await tap(cx, FEED_TAB)) === null)
      throw new Error('no Feed tab to leave the communities by');
    await waitMs(1500);
    await adb(serial, ['shell', 'input', 'keyevent', '3']);
    await waitMs(10000);
    await adb(serial, ['logcat', '-c']);
    if (NET === 'airplane') {
      await setNetwork(false);
      await waitMs(3000);
    }
  }
  const row0 = {};
  for (const domain of ['Runtime.enable', 'Log.enable', 'Network.enable']) await cx.send(domain);
  row0.link = await evaluate(cx, SLOW_LINK(NETWORKS[NET]));
  await cx.send('Emulation.setCPUThrottlingRate', { rate: CPU });
  const eventsFrom = cx.events.length;
  const armed = JSON.parse(await evaluate(cx, PROBE));
  if (START === 'warm') await launch(serial);
  const timeOrigin = armed.origin;
  const row = {
    ...row0,
    label: LABEL,
    run: index,
    start: START,
    net: NET,
    cpu: CPU,
    pid,
    at: new Date().toISOString(),
  };
  row.attachMs = Math.round(armed.now);
  say(`attached pid ${pid} at +${row.attachMs}`);

  row.nav = await until(cx, 'nav', PRED.nav, null, false);
  if (BEFORE_TAP) row.beforeTap = await evaluate(cx, BEFORE_TAP);
  if (SETTLE) await waitMs(SETTLE);
  if (PROFILE) {
    await cx.send('Profiler.enable');
    await cx.send('Profiler.setSamplingInterval', { interval: 200 });
    await cx.send('Profiler.start');
  }
  const traceFrom = cx.events.length;
  if (TRACE)
    await cx.send('Tracing.start', { categories: TRACE_CATEGORIES, transferMode: 'ReportEvents' });
  await arm(cx, 'rail', PRED.rail);
  await arm(cx, 'salons', PRED.salons);
  row.tapHub = await tap(cx, NAV_TAB);
  row.rail = await until(cx, 'rail', null, row.tapHub);
  row.salons = await until(cx, 'salons', null, row.tapHub);
  row.hubName = await evaluate(cx, HUB_NAME);
  say(`hub ${row.hubName}: rail ${row.rail} salons ${row.salons}`);
  if (row.hubName !== TARGET) {
    await arm(cx, 'targetSalons', hubOf(TARGET));
    row.tapTarget = await tap(cx, railButton(TARGET));
    row.targetSalons = await until(cx, 'targetSalons', null, row.tapTarget);
  } else {
    row.targetSalons = row.salons;
  }
  // The capture spans the tab tap to the TARGET's salons: what the first mount leaves running is
  // paid by the member's next tap, so it belongs in the same picture.
  if (PROFILE) {
    const { profile } = await cx.send('Profiler.stop');
    writeFileSync(join(OUT, `profile-${LABEL}-${index}.cpuprofile`), JSON.stringify(profile));
  }
  if (TRACE) {
    await cx.send('Tracing.end');
    for (
      let i = 0;
      i < 200 && !cx.events.slice(traceFrom).some((e) => e.method === 'Tracing.tracingComplete');
      i++
    )
      await waitMs(50);
    const traceEvents = cx.events
      .slice(traceFrom)
      .filter((e) => e.method === 'Tracing.dataCollected')
      .flatMap((e) => e.params.value);
    const marks = {
      tapHub: row.tapHub,
      rail: row.rail,
      salons: row.salons,
      tapTarget: row.tapTarget,
      targetSalons: row.targetSalons,
      timeOrigin,
    };
    writeFileSync(
      join(OUT, `trace-${LABEL}-${index}.json`),
      JSON.stringify({ traceEvents, marks })
    );
  }
  [row.tapSalon, row.pane, row.messages] = await openFirstSalon(cx, 'first', true);
  say(`salon pane ${row.pane} messages ${row.messages}`);

  // ANOTHER COMMUNITY: the in-session switch.
  await backToHub(cx, 'b1');
  const other = JSON.parse(await evaluate(cx, RAIL_NAMES)).find((n) => n !== TARGET) ?? null;
  row.other = other;
  if (other) {
    await arm(cx, 'otherSalons', hubOf(other));
    row.tapOther = await tap(cx, railButton(other));
    row.otherSalons = await until(cx, 'otherSalons', null, row.tapOther);
    [row.tapOtherSalon, row.otherPane] = await openFirstSalon(cx, 'other', false);
    // THE SAME SALON AGAIN: what a member pays for a salon already opened in this session.
    await backToHub(cx, 'b2');
    await tap(cx, railButton(TARGET));
    await until(cx, 'targetAgain', hubOf(TARGET));
    [row.tapReopen, row.reopenPane, row.reopenMessages] = await openFirstSalon(cx, 'reopen', true);
  }
  say('collecting');
  await waitMs(1500);

  const page = JSON.parse(
    await evaluate(
      cx,
      'JSON.stringify({ api: window.__cobNet ? window.__cobNet.log : [], hb: window.__cob.hb, lt: window.__cob.lt, res: performance.getEntriesByType("resource").map(function (e) { return [e.name, Math.round(e.startTime)]; }) })'
    )
  );
  const ev = cx.events.slice(eventsFrom);
  row.console = ev
    .filter((e) => e.method === 'Runtime.consoleAPICalled' || e.method === 'Log.entryAdded')
    .map((e) =>
      e.method === 'Log.entryAdded'
        ? [
            Math.round(e.params.entry.timestamp - timeOrigin),
            e.params.entry.level,
            e.params.entry.text,
          ]
        : [
            Math.round(e.params.timestamp - timeOrigin),
            e.params.type,
            e.params.args.map((a) => a.value ?? a.description ?? '').join(' '),
          ]
    )
    .sort((a, b) => a[0] - b[0]);
  // Requests: `wallTime` (epoch s) anchors each one on the page's axis; its monotonic timestamps
  // give the rest. `dataReceived` is summed because `encodedDataLength` reads 0 on this WebView.
  const reqs = new Map();
  for (const e of ev) {
    const p = e.params;
    const r = reqs.get(p?.requestId);
    if (e.method === 'Network.requestWillBeSent') {
      reqs.set(p.requestId, {
        url: p.request.url,
        method: p.request.method,
        start: Math.round(p.wallTime * 1000 - timeOrigin),
        mono: p.timestamp,
        bytes: 0,
      });
    } else if (!r) continue;
    else if (e.method === 'Network.responseReceived') r.status = p.response.status;
    else if (e.method === 'Network.dataReceived') r.bytes += p.dataLength ?? 0;
    else if (e.method === 'Network.loadingFinished' || e.method === 'Network.loadingFailed') {
      r.end = Math.round(r.start + (p.timestamp - r.mono) * 1000);
      if (e.method === 'Network.loadingFailed') r.failed = p.errorText;
    }
  }
  row.requests = [...reqs.values()].map(({ mono: _mono, ...r }) => r);
  // [path, start, handed back, bytes, method, headers in] of every first-party call through window.fetch.
  row.api = page.api;
  row.longTasks = page.lt;
  row.gaps = [];
  for (let i = 1; i < page.hb.length; i++) {
    const g = page.hb[i] - page.hb[i - 1];
    if (g > 150) row.gaps.push([page.hb[i - 1], g]);
  }
  row.resourcesBeforeAttach = page.res.filter((r) => r[1] < row.attachMs).length;
  const log = await adb(serial, ['logcat', '-d', '-v', 'epoch', '--pid', String(pid ?? '')]).catch(
    () => ''
  );
  row.logcat = log
    .split('\n')
    .map((l) => {
      const m = l.match(/^\s*(\d+\.\d+)\s+(.*)$/);
      return m ? [Math.round(Number(m[1]) * 1000 - timeOrigin), m[2].slice(0, 400)] : null;
    })
    .filter(Boolean);
  if (NET === 'airplane') await setNetwork(true);
  appendFileSync(join(OUT, 'runs.ndjson'), JSON.stringify(row) + '\n');
  console.log(
    `run ${index}: ${Object.entries(derive(row))
      .map(([k, v]) => `${k}=${v ?? 'TIMEOUT'}`)
      .join(' ')}`
  );
  if (START === 'cold') cx.close();
  return row;
}

/** Kind of a request: a server call, a native IPC command (named), or a bundled asset. */
export function kindOf(url) {
  if (url.startsWith('http://ipc.localhost/'))
    return `ipc:${decodeURIComponent(url.slice(21).split('?')[0])}`;
  if (url.startsWith('http://tauri.localhost/')) return 'asset';
  return 'api';
}

/** The numbers of one run, each relative to the tap that asked for it. */
function derive(r) {
  const d = (a, b) => (a == null || b == null ? null : a - b);
  const end = r.messages ?? (r.tapHub ?? 0) + TIMEOUT;
  const inOpen = (t) => r.tapHub != null && t >= r.tapHub && t <= end;
  const reqs = r.requests.filter((q) => inOpen(q.start));
  const api = r.api.filter(([, start]) => inOpen(start));
  return {
    attach: r.attachMs,
    nav: r.nav,
    'tap>rail': d(r.rail, r.tapHub),
    'tap>salons': d(r.salons, r.tapHub),
    'tap>target salons': d(r.targetSalons, r.tapHub),
    'salon>pane': d(r.pane, r.tapSalon),
    'salon>msgs': d(r.messages, r.tapSalon),
    'switch>salons': d(r.otherSalons, r.tapOther),
    'switch salon>pane': d(r.otherPane, r.tapOtherSalon),
    'reopen>msgs': d(r.reopenMessages, r.tapReopen),
    'api calls': api.length,
    'api kB': Math.round(api.reduce((s, q) => s + (Number(q[3]) || 0), 0) / 1024),
    'ipc calls': reqs.filter((q) => kindOf(q.url).startsWith('ipc:') && q.method !== 'OPTIONS')
      .length,
    'longtask ms': r.longTasks.filter(([s]) => inOpen(s)).reduce((s, [, dur]) => s + dur, 0),
    'max gap': Math.max(0, ...r.gaps.filter(([t]) => inOpen(t)).map(([, g]) => g)),
  };
}

const rows = [];
let warmCx = null;
if (START === 'warm') {
  await forceStop(serial);
  await waitMs(1500);
  await launch(serial);
  ({ cx: warmCx } = await attach());
  await evaluate(warmCx, PROBE);
  await until(warmCx, 'ready', PRED.nav);
  // The session lists its communities and opens nothing: the runs measure a process that is up.
  await waitMs(8000);
}
for (let i = 1; i <= RUNS; i++) {
  try {
    rows.push(await oneRun(i, warmCx));
  } catch (e) {
    console.log(`run ${i} FAILED: ${e.message}`);
    if (NET === 'airplane') await setNetwork(true);
  }
}
if (warmCx) warmCx.close();

const table = rows.length
  ? Object.keys(derive(rows[0])).map((metric) => {
      const vals = rows.map((r) => derive(r)[metric]);
      const ok = vals.filter((v) => v != null).sort((a, b) => a - b);
      return {
        metric,
        median: ok.length ? ok[Math.floor((ok.length - 1) / 2)] : null,
        worst: vals.includes(null) ? 'TIMEOUT' : ok.at(-1),
        n: ok.length,
      };
    })
  : [];
console.log(`\n${LABEL} - ${rows.length} run(s)`);
console.table(table);
writeFileSync(join(OUT, `summary-${LABEL}.json`), JSON.stringify(table, null, 2));
process.exit(0);
