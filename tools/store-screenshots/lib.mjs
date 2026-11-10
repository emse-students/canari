// Shared pieces of the store-screenshot pipeline: a CDP session on one browser tab, a static file server
// for the compose page, and the PNG flattener (stores refuse an alpha channel; Chrome always writes one).
import { deflateSync, inflateSync } from 'node:zlib';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';

const MIME = { '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };

/** Serves one directory on a free loopback port, with real content types (fonts and images need them). */
export function serveDir(dir) {
  return Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const file = join(dir, decodeURIComponent(new URL(req.url).pathname).slice(1));
      if (!existsSync(file)) return new Response('not found', { status: 404 });
      return new Response(readFileSync(file), { headers: { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' } });
    },
  });
}

/** A CDP session on a NEW tab of the Chrome listening on `port` (the capture session's own, never a harness tab). */
export async function newTab(port, url = 'about:blank') {
  const tab = await (await fetch(`http://127.0.0.1:${port}/json/new?${url}`, { method: 'PUT' })).json();
  return session(tab.webSocketDebuggerUrl, tab.id, port);
}

/** A CDP session on the first existing page tab whose URL matches `match` (the logged-in app tab). */
export async function existingTab(port, match) {
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const t = tabs.find((x) => x.type === 'page' && match.test(x.url));
  if (!t) throw new Error(`no page matching ${match} on port ${port}: sign in first (README, step 1)`);
  return session(t.webSocketDebuggerUrl, null, port);
}

async function session(wsUrl, id, port) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let n = 0;
  const pend = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { const [ok, ko] = pend.get(m.id); pend.delete(m.id); m.error ? ko(new Error(m.error.message)) : ok(m.result); }
  };
  const send = (method, params = {}) => new Promise((ok, ko) => { const i = ++n; pend.set(i, [ok, ko]); ws.send(JSON.stringify({ id: i, method, params })); });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.text} ${expression.slice(0, 80)}`);
    return r.result?.value;
  };
  return {
    send, ev, sleep,
    async goto(url, settleMs = 4000) { await send('Page.navigate', { url }); await sleep(settleMs); },
    async png(clip) { const s = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) }); return Buffer.from(s.data, 'base64'); },
    async close() { ws.close(); if (id) await fetch(`http://127.0.0.1:${port}/json/close/${id}`).catch(() => {}); },
  };
}

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const t = Buffer.from(type), len = Buffer.alloc(4), crc = Buffer.alloc(4);
  len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
};

/** IHDR facts of a PNG: width, height, colour type (2 = RGB, 6 = RGBA). */
export function pngInfo(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bitDepth: buf[24], colorType: buf[25] };
}

/**
 * Re-encodes an 8-bit RGBA PNG as RGB (alpha dropped, the field behind it is opaque already) with no
 * ancillary chunk, so no metadata survives either. Throws on any other layout rather than guessing.
 */
export function flattenPng(buf) {
  const info = pngInfo(buf);
  if (info.colorType === 2) return buf;
  if (info.colorType !== 6 || info.bitDepth !== 8) throw new Error(`unsupported PNG layout ${JSON.stringify(info)}`);
  const idat = [];
  for (let p = 8; p < buf.length;) {
    const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8);
    if (type === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const { width: w, height: h } = info, stride = w * 4;
  const out = Buffer.alloc(h * (1 + w * 3));
  const prev = Buffer.alloc(stride), cur = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    raw.copy(cur, 0, y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? cur[i - 4] : 0, b = prev[i], c = i >= 4 ? prev[i - 4] : 0;
      let add = 0;
      if (ft === 1) add = a; else if (ft === 2) add = b; else if (ft === 3) add = (a + b) >> 1;
      else if (ft === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = (cur[i] + add) & 255;
    }
    const o = y * (1 + w * 3);
    out[o] = 0;
    for (let x = 0; x < w; x++) { out[o + 1 + x * 3] = cur[x * 4]; out[o + 2 + x * 3] = cur[x * 4 + 1]; out[o + 3 + x * 3] = cur[x * 4 + 2]; }
    cur.copy(prev);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(out, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * Page-side probe, run in the app's page: the page text, then one `[MEDIA] ...` line per kind of
 * visible placeholder - an initials avatar (`.avatar-placeholder`, what Avatar.svelte draws when
 * there is no photo) or an image that did not load. The verify step fails a shot with either: the
 * owner's rule is that no final shot shows an initials circle or an empty medium.
 */
/** @param {string[]} allowed initials of a GROUP or ASSOCIATION badge (an organisation mark, not a person): not reported */
export const pageProbe = (allowed = []) => `(() => {
  const allowed = ${JSON.stringify(allowed)};
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight; };
    // VISIBLE text only (what the shot shows), in reading order: text below the fold is not part of the image.
  const seen = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.textContent.trim();
    const el = n.parentElement;
    if (t && el && vis(el) && getComputedStyle(el).visibility !== 'hidden' && !['SCRIPT', 'STYLE'].includes(el.tagName)) seen.push(t);
  }
  const lines = [document.documentElement.lang, seen.join(String.fromCharCode(10))];
  const ph = [...document.querySelectorAll('.avatar-placeholder')].filter((e) => vis(e) && !allowed.includes(e.textContent.trim())).length;
  const broken = [...document.querySelectorAll('img')].filter((i) => vis(i) && i.complete && i.naturalWidth === 0).length;
  if (ph) lines.push('[MEDIA] ' + ph + ' initials avatar(s) on screen');
  if (broken) lines.push('[MEDIA] ' + broken + ' image(s) did not load');
  return lines.join(String.fromCharCode(10));
})()`;

/** Closes the "Environnement de test" banner of a dev page (its own close button). */
export const CLOSE_BANNER = `(()=>{const el=[...document.querySelectorAll('div,section,aside')].find(d=>d.children.length<=3&&/^(Environnement de test|Test environment)/.test(d.textContent.trim())&&d.querySelector('button'));el?.querySelector('button')?.click()})()`;

/**
 * The iOS counterpart of `pageProbe`, from WDA's flattened accessibility tree (`ios.mjs flat`): the
 * iPhone app has no inspector tab, so the page text is what the native tree reports. Same output
 * shape as `pageProbe` (a language line, the text, then `[MEDIA]` lines), so `shots.mjs verify`
 * reads both. An initials avatar is a short upper-case text (1-2 letters) drawn in a roughly square
 * box no larger than a avatar; a broken image is NOT detectable from the tree (the shot is looked at).
 * @param {{type?:string,text:string,rect:{x:number,y:number,width:number,height:number}}[]} flat
 * @param {string} lang the language the capture was set to
 * @param {number} windowHeight the window height in points; elements wholly below it are off screen
 * @param {string[]} allowedInitials initials of a group or association badge (an organisation mark, not a person): not reported
 * @param {number} topInset height in points of the status bar: an element wholly above it is under the bar, not visible
 */
export function treeProbe(flat, lang, windowHeight = 844, allowedInitials = [], topInset = 47) {
  // Content scrolled under the status bar (its bottom edge above `topInset`) is hidden by the bar's own blur: not on screen.
  const onScreen = flat.filter((e) => e.rect && e.rect.height > 0 && e.rect.width > 0 && e.rect.y < windowHeight && e.rect.y + e.rect.height > topInset);
  const ordered = [...onScreen].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  const initials = ordered.filter((e) => {
    const bare = String(e.type ?? '').replace(/^XCUIElementType/, '');
    const square = Math.abs(e.rect.width - e.rect.height) <= 6 && e.rect.width <= 80;
    return bare === 'StaticText' && /^\p{Lu}{1,2}$/u.test(e.text.trim()) && square;
  });
  const lines = [lang, ...ordered.map((e) => e.text)];
  if (initials.length) lines.push(`[MEDIA] ${initials.length} initials avatar(s) on screen`);
  return lines.join(String.fromCharCode(10));
}
