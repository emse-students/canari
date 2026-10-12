#!/usr/bin/env bun
/**
 * Every route x every screen size, audited in the DOM - the half of "adapts to every screen" that does
 * not need a phone. The logged-in W1 browser (see tools/cross-client-harness) is resized in place with
 * `Emulation.setDeviceMetricsOverride`, each route is reached by a client-side navigation (an anchor
 * click, so the session and the unlocked MLS store survive), and a DOM audit runs at each size.
 *
 *   bun viewports.mjs [route-prefix] [--only vp1,vp2]
 *
 * Classes of finding, each one a thing a user sees:
 *   H  horizontal overflow: the page scrolls sideways, or an element pokes past the right edge
 *   C  clipped text: overflow hidden with no ellipsis and more text than room
 *   T  small tap target: an interactive element whose HIT box (its ::before for a `.tap-target`) is
 *      under 44 px in its shortest side (touch sizes only)
 *   Z  stolen tap: a point of a control's own drawing lands in ANOTHER control's `.tap-target` hit box
 *   B  covered control: an interactive element whose centre is under a fixed bottom bar it is not part of
 *   S  tiny text: text under 11 px
 * Results: RUNS/viewports.ndjson (one row per route x size), RUNS/viewports-summary.md (the matrix),
 * screenshots in RUNS/vp/ - all OUTSIDE the repo, because a screenshot of a campaign account is not for
 * a public repository. Nothing here submits, deletes, signs out or touches the PIN.
 */
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { client } from '../cross-client-harness/chat.mjs';
import { evaluate } from '../cross-client-harness/cdp.mjs';

const RUNS = process.env.BENCH_RUNS ?? 'F:/Programmation/canari-harness/ios-bench/runs';
const PORT = 9224; // W1
const SITE = 'localhost:8081';

/** name, width, height, touch. Sizes are CSS px; the first seven are the phones and foldables. */
export const VIEWPORTS = [
  ['fold-cover', 280, 653, true],
  ['se-1', 320, 568, true],
  ['android-small', 360, 640, true],
  ['iphone-12', 390, 844, true],
  ['mi-9t', 393, 851, true],
  // What the Mi 9T's WebView REALLY reports (measured over CDP): 1080 px / 2.477, not / 2.75 - MIUI's display size.
  ['mi-9t-real', 436, 945, true],
  ['iphone-max', 430, 932, true],
  ['phone-landscape', 844, 390, true],
  ['tablet-portrait', 768, 1024, true],
  ['tablet-landscape', 1024, 768, true],
  ['laptop', 1366, 768, false],
  ['desktop', 1920, 1080, false],
  // Text zoom: the root font size is scaled, which is what the OS "larger text" setting does to rem.
  ['iphone-12-x150', 390, 844, true, 1.5],
  ['android-small-x200', 360, 640, true, 2],
  ['se-1-x150', 320, 568, true, 1.5],
];

/** Static routes only; the ones that need an id or a token are reached by the phone tour instead. */
export const ROUTES = [
  'dashboard', 'posts', 'chat', 'communities', 'notifications', 'profile', 'settings', 'shop',
  'associations', 'associations/new', 'calendar', 'events', 'forms', 'forms/create', 'lists', 'lists/new',
  'documents', 'directory', 'account/purchases', 'legal/cgu', 'legal/privacy', 'legal/child-safety',
  'admin', 'admin/agenda', 'admin/carte', 'admin/cercle', 'admin/document-reviewers',
  'admin/legacy-cotisations', 'admin/moderation', 'admin/platform', 'admin/status', 'admin/storage', 'admin/users',
];

/** Runs in the page. Returns counts plus up to three examples per class. */
const AUDIT = `(() => {
  const W = innerWidth, H = innerHeight, touch = matchMedia('(pointer: coarse)').matches;
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0.05 && r.bottom > 0 && r.right > 0 && r.top < H * 4; };
  const name = (e) => { const t = (e.getAttribute('aria-label') || e.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 28);
    return e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (t ? ' "' + t + '"' : ''); };
  const scrollerAbove = (e) => { for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
    const o = getComputedStyle(p).overflowX; if ((o === 'auto' || o === 'scroll' || o === 'hidden') && p.scrollWidth > p.clientWidth + 1) return true; } return false; };
  const out = { H: [], C: [], T: [], Z: [], B: [], S: [] };
  const all = [...document.querySelectorAll('body *')].filter(vis);
  const pageOverflow = document.documentElement.scrollWidth - W;
  if (pageOverflow > 1) out.H.push('page scrolls sideways by ' + pageOverflow + 'px');
  for (const e of all) { const r = e.getBoundingClientRect();
    if (r.right > W + 1 && !scrollerAbove(e) && getComputedStyle(e).position !== 'fixed') out.H.push(name(e) + ' ends at ' + Math.round(r.right)); }
  for (const e of all) { const s = getComputedStyle(e);
    if ((s.overflow === 'hidden' || s.overflowX === 'hidden') && s.textOverflow !== 'ellipsis' && !e.closest('#bottom-nav') && e.scrollWidth > e.clientWidth + 2 && e.children.length === 0 && e.textContent.trim()) out.C.push(name(e) + ' ' + e.scrollWidth + '>' + e.clientWidth); }
  const inter = all.filter((e) => e.matches('a[href],button,[role=button],[role=tab],input:not([type=hidden]),select,textarea,[tabindex]:not([tabindex="-1"])'));
  // The HIT box, not the drawing: a \`.tap-target\` carries an invisible ::before that is the real touch area.
  const hit = (e) => { const r = e.getBoundingClientRect(); const b = getComputedStyle(e, '::before');
    if (b.content === 'none' || b.position !== 'absolute') return [r.width, r.height];
    return [Math.max(r.width, parseFloat(b.width) || 0), Math.max(r.height, parseFloat(b.height) || 0)]; };
  if (touch) for (const e of inter) { const r = e.getBoundingClientRect(); const [hw, hh] = hit(e); if (Math.min(hw, hh) < 44 && r.top < H && r.bottom > 0) out.T.push(name(e) + ' ' + Math.round(hw) + 'x' + Math.round(hh)); }
  // A hit box that grows past its drawing can swallow a NEIGHBOUR's drawing: on the Mi 9T a stacked list
  // of \`.tap-target\` links opened section N+1 on a tap on N. Probe each control's own drawn area.
  if (touch) for (const e of inter) { const r = e.getBoundingClientRect(); if (r.top < 0 || r.bottom > H) continue;
    for (const y of [r.top + 2, r.top + r.height / 2, r.bottom - 2]) { const p = document.elementFromPoint(r.left + r.width / 2, y);
      const thief = p && p.closest('.tap-target'); if (thief && thief !== e && !e.contains(thief) && !thief.contains(e)) { out.Z.push(name(e) + ' taken by ' + name(thief)); break; } } }
  const bars = all.filter((e) => { const s = getComputedStyle(e), r = e.getBoundingClientRect(); return s.position === 'fixed' && r.bottom >= H - 8 && r.height < 200 && r.width > W * 0.5; });
  for (const b of bars) { const br = b.getBoundingClientRect();
    for (const e of inter) { if (b.contains(e)) continue; const r = e.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (cx > br.left && cx < br.right && cy > br.top && cy < br.bottom && r.width > 0) out.B.push(name(e) + ' under ' + name(b)); } }
  for (const e of all) { if (e.children.length === 0 && e.textContent.trim() && parseFloat(getComputedStyle(e).fontSize) < 11) out.S.push(name(e) + ' ' + getComputedStyle(e).fontSize); }
  const res = {};
  for (const k of Object.keys(out)) res[k] = { n: out[k].length, ex: out[k].slice(0, 3) };
  return res; })()`;

const argv = process.argv.slice(2);
const onlyIdx = argv.indexOf('--only');
const prefix = argv.find((a, i) => !a.startsWith('--') && i !== onlyIdx + 1) ?? '';
const only = onlyIdx >= 0 ? argv[onlyIdx + 1].split(',') : null;
const vps = VIEWPORTS.filter(([n]) => (only ? only.includes(n) : !n.includes('-x')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(join(RUNS, 'vp'), { recursive: true });
const cx = await client(PORT, SITE);
await cx.send('Page.enable');

async function setViewport([, w, h, touch, scale = 1]) {
  await evaluate(cx, `document.documentElement.style.fontSize = ${scale === 1 ? "''" : `'${scale * 100}%'`}`);
  await cx.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: touch });
  await cx.send('Emulation.setTouchEmulationEnabled', { enabled: touch });
  await sleep(350);
}

/** Client-side navigation: an anchor click is intercepted by the SvelteKit router, a reload is not. */
async function go(path) {
  await evaluate(cx, `(() => { const a = document.createElement('a'); a.href = '/${path}'; document.body.appendChild(a); a.click(); a.remove(); })()`);
  await sleep(2200);
  return evaluate(cx, 'location.pathname');
}

const table = [];
await setViewport(VIEWPORTS[3]);
for (const route of ROUTES.filter((r) => r.startsWith(prefix))) {
  const landed = await go(route);
  const row = { route, landed, cells: {} };
  for (const vp of vps) {
    await setViewport(vp);
    const a = await evaluate(cx, AUDIT);
    const shot = join(RUNS, 'vp', `${route.replace(/\//g, '_')}--${vp[0]}.png`);
    const png = await cx.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(shot, Buffer.from(png.data, 'base64'));
    row.cells[vp[0]] = a;
    appendFileSync(join(RUNS, 'viewports.ndjson'), JSON.stringify({ ts: new Date().toISOString(), route, landed, viewport: vp[0], w: vp[1], h: vp[2], audit: a }) + '\n');
  }
  table.push(row);
  const worst = vps.map((v) => [v[0], Object.values(row.cells[v[0]]).reduce((s, c) => s + c.n, 0)]).sort((x, y) => y[1] - x[1])[0];
  console.log(`${route.padEnd(26)} landed ${landed.padEnd(24)} worst ${worst[0]} (${worst[1]})`);
}

// The matrix: per route and size, the letters of the classes that fired with their counts.
const head = `| route | landed | ${vps.map((v) => v[0]).join(' | ')} |\n|---|---|${vps.map(() => '---').join('|')}|\n`;
const lines = table.map((r) => `| ${r.route} | ${r.landed} | ${vps.map((v) => Object.entries(r.cells[v[0]]).filter(([, c]) => c.n).map(([k, c]) => k + c.n).join(' ') || '-').join(' | ')} |`);
writeFileSync(join(RUNS, only ? `viewports-summary-${only.join('+')}.md` : 'viewports-summary.md'), head + lines.join('\n') + '\n');
await setViewport(VIEWPORTS[3]);
await evaluate(cx, "document.documentElement.style.fontSize = ''");
await cx.send('Emulation.clearDeviceMetricsOverride');
console.log('summary written');
process.exit(0);
