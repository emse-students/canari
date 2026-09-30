#!/usr/bin/env bun
/**
 * The Android phone's WebView, every route AND every overlay the page can open, audited against the
 * real system bars - in whichever navigation mode the phone is in. Run it once per mode:
 *
 *   adb shell cmd overlay enable-exclusive com.android.internal.systemui.navbar.gestural    (gestures)
 *   adb shell cmd overlay enable-exclusive com.android.internal.systemui.navbar.threebutton (buttons)
 *   bun insets.mjs [route-prefix] --mode gestural|threebutton
 *   bun insets.mjs [route-prefix] --mode ios --ios   (the iPhone, over pymobiledevice3's CDP bridge)
 *   add --deep to also open the first detail page each list route links to (a post, an event, a list)
 *
 * What it reports for each state (a route, or a dialog/sheet/menu opened from it):
 *   insets   env(safe-area-inset-*) and the visual viewport, so a mode change is visible as a number
 *   top/bot  where the topmost and bottommost fixed element sit - the margin to the screen edge
 *   X        an interactive element inside a system-bar zone (under the status bar / nav bar inset)
 *   O        an element that leaves the viewport sideways or whose bottom is past it (a clipped sheet)
 *   B        an interactive element under a fixed bottom bar it is not part of
 * Overlays are opened ONLY by controls whose label is an OPENING verb (menu, filters, settings, new, add,
 * see, react ...); nothing submits, deletes, signs out or touches the PIN.
 * Results: RUNS/insets-<mode>.ndjson and screenshots RUNS/ins/<mode>/ - outside the repo.
 */
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluate, listTargets, connect } from '../cross-client-harness/cdp.mjs';
import { armIfPhone, resolveDevice } from '../cross-client-harness/device.mjs';

const RUNS = process.env.BENCH_RUNS ?? 'F:/Programmation/canari-harness/ios-bench/runs';
const argv = process.argv.slice(2);
const modeIdx = argv.indexOf('--mode');
const MODE = modeIdx >= 0 ? argv[modeIdx + 1] : 'unspecified';
const fromArg = argv.indexOf('--from');
const prefix = argv.find((a, i) => !a.startsWith('--') && i !== modeIdx + 1 && i !== fromArg + 1) ?? '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROUTES = [
  'posts', 'chat', 'communities', 'notifications', 'dashboard', 'profile', 'settings', 'shop',
  'associations', 'associations/new', 'calendar', 'events', 'forms', 'forms/create', 'lists', 'lists/new',
  'directory', 'account/purchases', 'legal/cgu',
];

/** Labels that OPEN something. Anything not matching is left alone; nothing here is a verb that commits. */
const OPENS = /(plus d.actions|menu|filtr|param|r[ée]glage|nouveau|nouvelle|ajouter|cr[ée]er|voir|g[ée]rer|r[ée]agi|r[ée]action|partager|modifier|rechercher|profil|notifs|autres sites|commenter|r[ée]pondre|d[ée]tails|options|emoji|pi[èe]ce|joindre|publier$|photo|canal)/i;
const NEVER = /(supprimer|d[ée]connex|quitter|r[ée]voquer|r[ée]initial|envoyer|confirmer|valider|enregistrer|payer|acheter|pin|effacer|bloquer|signaler|retirer|bannir)/i;

// `--ios` reads the iPhone instead, through `pymobiledevice3 webinspector cdp --port 9444` (a bench
// build is inspectable, .github/workflows/ios.yml): same audit, so the two phones answer one question.
const IOS = argv.includes('--ios');
/** `--deep` also opens the first detail page each list route links to. */
const DEEP = argv.includes('--deep');
const dev = IOS ? { port: Number(process.env.IOS_CDP_PORT ?? 9444) } : resolveDevice(['--android']);
if (!IOS) await armIfPhone(dev, 'insets');
/** The WebView can list stale hidden pages next to the live one (a click that opened a window, a
 * prerender): attach to the VISIBLE page and close the rest, or every later call talks to a page nobody sees. */
async function attach() {
  for (const t of await listTargets(dev.port)) {
    const c = connect(t.webSocketDebuggerUrl);
    await c.ready;
    const r = await c.send('Runtime.evaluate', { expression: 'document.visibilityState', returnByValue: true });
    if (r.result.value === 'visible') return { cx: c, id: t.id };
  }
  throw new Error('no visible page on the WebView');
}
async function closeStale(keepId) {
  for (const t of await listTargets(dev.port)) {
    if (t.id !== keepId) await fetch(`http://localhost:${dev.port}/json/close/${t.id}`).catch(() => {});
  }
}
const first = await attach();
const cx = first.cx;
await closeStale(first.id);
await cx.send('Runtime.enable');
await cx.send('Page.enable');

const PROBE = `(() => {
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;visibility:hidden;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
  document.body.appendChild(d); const s = getComputedStyle(d);
  const ins = { t: parseFloat(s.paddingTop), r: parseFloat(s.paddingRight), b: parseFloat(s.paddingBottom), l: parseFloat(s.paddingLeft) }; d.remove();
  return { ins, W: innerWidth, H: innerHeight, vvH: Math.round(visualViewport.height), dpr: devicePixelRatio, screenH: screen.height };
})()`;

const AUDIT = `(() => {
  const W = innerWidth, H = innerHeight;
  const vis = (e) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0.05; };
  const name = (e) => { const t = (e.getAttribute('aria-label') || e.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 26); return e.tagName.toLowerCase() + (t ? ' "' + t + '"' : ''); };
  const all = [...document.querySelectorAll('body *')].filter(vis);
  const inter = all.filter((e) => e.matches('a[href],button,[role=button],[role=tab],input:not([type=hidden]),select,textarea,[tabindex]:not([tabindex="-1"])'));
  const fixed = all.filter((e) => getComputedStyle(e).position === 'fixed');
  const tops = fixed.map((e) => e.getBoundingClientRect().top).filter((v) => v > -5 && v < H / 3);
  const bots = fixed.map((e) => e.getBoundingClientRect().bottom).filter((v) => v > H * 2 / 3 && v < H + 40);
  const insets = (() => { const d = document.createElement('div'); d.style.cssText = 'position:fixed;visibility:hidden;padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom) 0'; document.body.appendChild(d); const s = getComputedStyle(d); const r = [parseFloat(s.paddingTop), parseFloat(s.paddingBottom)]; d.remove(); return r; })();
  const out = { X: [], O: [], B: [] };
  for (const e of inter) { const r = e.getBoundingClientRect(); if (r.height === 0) continue;
    if ((insets[0] > 0 && r.top < insets[0] - 1 && r.bottom > 0) || (insets[1] > 0 && r.bottom > H - insets[1] + 1 && r.top < H)) out.X.push(name(e) + ' ' + Math.round(r.top) + '..' + Math.round(r.bottom)); }
  for (const e of all) { const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
    if (s.position === 'fixed' && (r.right > W + 1 || r.left < -1 || r.bottom > H + 1)) out.O.push(name(e) + ' ' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.right) + ',' + Math.round(r.bottom)); }
  const bars = fixed.filter((e) => { const r = e.getBoundingClientRect(); return r.bottom >= H - 8 && r.height < 200 && r.width > W * 0.5; });
  for (const b of bars) { const br = b.getBoundingClientRect();
    for (const e of inter) { if (b.contains(e)) continue; const r = e.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (cx > br.left && cx < br.right && cy > br.top && cy < br.bottom) out.B.push(name(e) + ' under ' + name(b)); } }
  const res = { topGap: tops.length ? Math.round(Math.min(...tops)) : null, botGap: bots.length ? Math.round(H - Math.max(...bots)) : null };
  for (const k of Object.keys(out)) res[k] = { n: out[k].length, ex: out[k].slice(0, 3) };
  return res; })()`;

const OVERLAY_COUNT = `document.querySelectorAll('[role=dialog],[aria-modal=true],[data-overlay],dialog[open]').length + [...document.querySelectorAll('body *')].filter((e)=>{const s=getComputedStyle(e);const r=e.getBoundingClientRect();return s.position==='fixed'&&r.width>innerWidth*0.6&&r.height>innerHeight*0.3&&r.top>0}).length`;

mkdirSync(join(RUNS, 'ins', MODE), { recursive: true });
const log = (row) => appendFileSync(join(RUNS, `insets-${MODE}.ndjson`), JSON.stringify({ ts: new Date().toISOString(), mode: MODE, ...row }) + '\n');

async function snap(label) {
  const probe = await evaluate(cx, PROBE);
  const audit = await evaluate(cx, AUDIT);
  const file = join(RUNS, 'ins', MODE, label.replace(/[^\w-]+/g, '_').slice(0, 90) + '.png');
  // WebKit's inspector bridge may not implement the capture: the numbers are the result, the picture is a convenience.
  try {
    const png = await cx.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(file, Buffer.from(png.data, 'base64'));
  } catch (err) {
    console.warn(`[insets] no screenshot for ${label}: ${err.message}`);
  }
  return { probe, audit };
}

async function go(path) {
  await evaluate(cx, `(() => { const a = document.createElement('a'); a.href = '/${path}'; document.body.appendChild(a); a.click(); a.remove(); })()`);
  await sleep(2200);
  return evaluate(cx, 'location.pathname');
}

async function closeOverlay() {
  await evaluate(cx, `(() => { const b = [...document.querySelectorAll('button,[role=button]')].find((e) => /^(fermer|annuler|close)/i.test((e.getAttribute('aria-label') || e.textContent || '').trim())); if (b) b.click(); })()`);
  await cx.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cx.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(500);
}

const fromIdx = argv.indexOf('--from');
const from = fromIdx >= 0 ? ROUTES.indexOf(argv[fromIdx + 1]) : 0;
for (const route of ROUTES.slice(Math.max(from, 0)).filter((r) => r.startsWith(prefix))) {
  const landed = await go(route);
  const base = await snap(`${route}--page`);
  log({ route, state: 'page', landed, ...base });
  const labels = await evaluate(cx, `(() => { const seen = new Set(); return [...document.querySelectorAll('button,[role=button]')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top >= 0 && r.top < innerHeight; }).map((e) => (e.getAttribute('aria-label') || e.textContent || '').trim().replace(/\\s+/g, ' ')).filter((t) => t && !seen.has(t) && seen.add(t)); })()`);
  const todo = labels.filter((t) => OPENS.test(t) && !NEVER.test(t)).slice(0, 8);
  let opened = 0;
  for (const label of todo) {
    const before = await evaluate(cx, OVERLAY_COUNT);
    const esc = JSON.stringify(label);
    await evaluate(cx, `(() => { const b = [...document.querySelectorAll('button,[role=button]')].find((e) => (e.getAttribute('aria-label') || e.textContent || '').trim().replace(/\\s+/g, ' ') === ${esc}); if (b) b.click(); })()`);
    await sleep(700);
    const path = await evaluate(cx, 'location.pathname');
    const after = await evaluate(cx, OVERLAY_COUNT);
    if (path !== landed) {
      log({ route, state: `navigated by "${label}"`, landed: path });
      await evaluate(cx, 'history.back()');
      await sleep(1500);
      continue;
    }
    if (after > before) {
      opened++;
      const s = await snap(`${route}--${label}`);
      log({ route, state: `overlay "${label}"`, landed, ...s });
      await closeOverlay();
      await closeStale(first.id);
    }
  }
  const a = base.audit;
  console.log(`${route.padEnd(20)} ${MODE} insets t${base.probe.ins.t} b${base.probe.ins.b} H${base.probe.H} topGap ${a.topGap} botGap ${a.botGap} X${a.X.n} O${a.O.n} B${a.B.n} overlays ${opened}/${todo.length}`);
  if (DEEP) {
    // The detail page a list route links to (a post, an event, a list...): the screens the plain routes
    // never reach, found in the data the local stack already holds instead of created. Same-origin
    // relative links only, so nothing here can leave the app (an external link opened the iOS browser
    // chooser once); `new` and `create` are forms, not details, and have routes of their own above.
    const details = await evaluate(cx, `(() => { const base = '/${route}/'; return [...new Set([...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).filter((h) => { if (!h || !h.startsWith(base)) return false; const seg = h.slice(base.length).split(/[/?#]/)[0]; return seg && seg !== 'new' && seg !== 'create'; }))].slice(0, 1); })()`);
    for (const href of details) {
      const landed = await go(href.slice(1));
      const d = await snap(`${route}--detail`);
      log({ route: href, state: 'detail', landed, ...d });
      const b = d.audit;
      console.log(`${('> ' + route + '/<id>').padEnd(20)} ${MODE} insets t${d.probe.ins.t} b${d.probe.ins.b} H${d.probe.H} topGap ${b.topGap} botGap ${b.botGap} X${b.X.n} O${b.O.n} B${b.B.n}`);
    }
    if (!details.length) console.log(`${('> ' + route + '/<id>').padEnd(20)} ${MODE} no detail link on the page`);
  }
}
console.log('done', MODE);
process.exit(0);
