#!/usr/bin/env bun
/**
 * The photo posts of the demo on DEV (scenario.json `photoPosts`), published through the REAL
 * composer of the web client: the officer opens "Publier", picks the association in "Publier en tant
 * que", types the text, attaches a scene photo from `.photos/` (see photos.mjs) and presses Publier.
 * The media therefore goes through the app's own upload path and not through a database row.
 *
 *   bun post-seed.mjs --lang fr|en --ports third=9231,owner=9232,peer=9233,fourth=9234
 *
 * Same seats and the same dev-only door as chat-seed.mjs. Run `bun photos.mjs fetch` first.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_TAB, client, evaluate, realClick } from '../cross-client-harness/chat.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const scenario = JSON.parse(readFileSync(join(HERE, 'scenario.json'), 'utf8'));
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const lang = opt('lang', 'fr');
const ports = Object.fromEntries(opt('ports', '').split(',').filter(Boolean).map((p) => p.split('=')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const post of scenario.photoPosts) {
  const cx = await client(Number(ports[post.seat]), APP_TAB, { focus: false });
  await cx.send('Emulation.setDeviceMetricsOverride', { width: 430, height: 900, deviceScaleFactor: 2, mobile: true });
  await evaluate(cx, "location.assign('/posts')");
  await sleep(12000);
  await evaluate(cx, `document.querySelector('[aria-label="Publier"]')?.click()`);
  await sleep(3000);
  // The author: the association chosen by its exact name in the "Publier en tant que" menu.
  await realClick(cx, '[aria-label^="Publier en tant que"]');
  await sleep(1200);
  const picked = await evaluate(cx, `(() => { const el = [...document.querySelectorAll('[role=dialog] *, body *')].filter((e) => e.children.length === 0 && (e.textContent || '').trim() === ${JSON.stringify(post.association)} && e.getBoundingClientRect().width > 0).pop(); if (!el) return false; (el.closest('button,[role=menuitem],[role=option]') || el).click(); return true; })()`);
  if (picked !== true && picked !== 'true') throw new Error(`association "${post.association}" is not offered to ${post.seat}`);
  await sleep(1500);
  // The text: the composer is a contenteditable ("Quoi de neuf ?").
  await evaluate(cx, `(() => { const e = document.querySelector('[role=dialog] [contenteditable=true]'); e?.focus(); return !!e; })()`);
  await cx.send('Input.insertText', { text: post.text[lang] });
  await sleep(800);
  // The photo, set on the composer's own media input.
  const { result } = await cx.send('Runtime.evaluate', { expression: `[...document.querySelectorAll('input[type=file]')].find((i) => /image/.test(i.accept))` });
  await cx.send('DOM.setFileInputFiles', { objectId: result.objectId, files: [resolve(HERE, '.photos', post.photo)] });
  await sleep(5000);
  await realClick(cx, 'text=Publier');
  await sleep(1000);
  const closed = await evaluate(cx, `new Promise((r) => { const t0 = Date.now(); const i = setInterval(() => { if (!document.querySelector('[role=dialog]') || Date.now() - t0 > 60000) { clearInterval(i); r(!document.querySelector('[role=dialog]')); } }, 500); })`);
  console.log(`[post-seed] ${post.association} (${post.seat}): ${post.text[lang]} -> ${closed ? 'published' : 'composer still open'}`);
  await cx.send('Emulation.clearDeviceMetricsOverride');
  cx.close();
}
console.log('[post-seed] done');
process.exit(0);
