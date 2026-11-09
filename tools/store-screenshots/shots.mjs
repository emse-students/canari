#!/usr/bin/env bun
/**
 * Store screenshots: capture the real app on the dev estate, then compose the final images.
 *
 *   bun shots.mjs capture [--port 9231] [--lang fr,en] [--work DIR] [--site URL] [--open "conversation title"]
 *   bun shots.mjs verify  [--work DIR]
 *   bun shots.mjs compose [--work DIR] [--out DIR] [--port 9231] [--allow-dirty]
 *   bun shots.mjs all     (capture, verify, compose)
 *
 * The browser is a Chrome already signed in on dev and unlocked (README step 1); this tool only opens
 * its own tabs in it. DEV ONLY: any site that is not dev.canari-emse.fr is refused.
 * See README.md and docs/wiki/store-listings.md section 9.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLOSE_BANNER, PAGE_PROBE, flattenPng, newTab, pngInfo, serveDir } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const scenario = JSON.parse(readFileSync(join(HERE, 'scenario.json'), 'utf8'));
const cfg = JSON.parse(readFileSync(join(HERE, 'sizes.json'), 'utf8'));

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? d : argv[i + 1];
};
const port = Number(opt('port', 9231));
const langs = opt('lang', 'fr,en').split(',');
const work = resolve(opt('work', join(HERE, '.work')));
const out = resolve(opt('out', join(HERE, 'out')));
const site = opt('site', 'https://dev.canari-emse.fr');
const allowDirty = argv.includes('--allow-dirty');
/** Where a captured PNG comes from. ONLY the two phones are native; `web` is a layout preview and never yields a final file. */
const NATIVE = ['android', 'ios'];
const sourceOf = (size) => (size.store === 'apple' ? 'ios' : 'android');
const log = (...a) => console.log('[store-shots]', ...a);

if (new URL(site).hostname !== 'dev.canari-emse.fr') throw new Error(`refused: ${site} is not the dev estate`);

/** Real pointer click on the smallest visible element showing `text`. */
async function clickText(tab, text) {
  const box = await tab.ev(`(()=>{const t=${JSON.stringify(text)};const c=[...document.querySelectorAll('a,button,[role=button],li,div,span')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&(e.textContent||'').includes(t)}).sort((a,b)=>a.querySelectorAll('*').length-b.querySelectorAll('*').length)[0];if(!c)return null;c.scrollIntoView({block:'center'});const r=c.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  if (!box) throw new Error(`click: "${text}" not on screen`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
    await tab.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await tab.sleep(1500);
}

/** Opens each route of the scenario in each language on a phone-sized light page and stores the PNG and the page text. */
async function capture() {
  const tab = await newTab(port, `${site}/chat`);
  const { cssWidth: w, cssHeight: h, deviceScaleFactor: dpr } = cfg.capture;
  await tab.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dpr, mobile: true });
  await tab.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  try {
    await tab.goto(`${site}/chat`, 3000);
    for (const lang of langs) {
      await tab.ev(
        `localStorage.setItem('canari-theme','light');localStorage.setItem('PARAGLIDE_LOCALE',${JSON.stringify(lang)});document.cookie='PARAGLIDE_LOCALE=${lang}; path=/; max-age=31536000'`,
      );
      for (const shot of scenario.shots) {
        await tab.goto(`${site}${shot.route}`);
        const locked = await tab.ev(`/^\\/(login|auth)/.test(location.pathname)||!!document.querySelector('input[type=password]')`);
        if (locked) throw new Error('signed out or locked: redo README step 1');
        await tab.ev(
          `(()=>{const el=[...document.querySelectorAll('div,section,aside')].find(d=>d.children.length<=3&&/^(Environnement de test|Test environment)/.test(d.textContent.trim())&&d.querySelector('button'));el?.querySelector('button')?.click()})()`,
        );
        await tab.sleep(400);
        const target = shot.open ? (opt('open', null) ?? shot.open[lang]) : null;
        if (target) await clickText(tab, target);
        await tab.ev('window.scrollTo(0,0)');
        const text = await tab.ev(PAGE_PROBE);
        if (/Environnement de test|Test environment/.test(text)) throw new Error('the dev banner is still on screen');
        mkdirSync(join(work, 'web', lang), { recursive: true });
        writeFileSync(join(work, 'web', lang, `${shot.id}.txt`), text);
        writeFileSync(join(work, 'web', lang, `${shot.id}.png`), await tab.png());
        log('captured', lang, shot.id);
      }
    }
  } finally {
    await tab.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
    await tab.close();
  }
}

/** The demo content must be on screen and nothing from the forbidden list: returns the problems. */
function verify(source = opt('source', 'web')) {
  const problems = [];
  for (const lang of langs)
    for (const shot of scenario.shots) {
      const f = join(work, source, lang, `${shot.id}.txt`);
      if (!existsSync(f)) {
        problems.push(`${source}/${lang}/${shot.id}: not captured`);
        continue;
      }
      const text = readFileSync(f, 'utf8');
      for (const s of shot.expect[lang]) if (!text.includes(s)) problems.push(`${source}/${lang}/${shot.id}: missing demo text "${s}"`);
      for (const l of text.split(String.fromCharCode(10)).filter((x) => x.startsWith('[MEDIA]'))) problems.push(`${source}/${lang}/${shot.id}: ${l.slice(8)}`);
      for (const s of scenario.forbiddenOnScreen) if (text.includes(s)) problems.push(`${source}/${lang}/${shot.id}: forbidden text on screen "${s}"`);
    }
  return problems;
}

/** The app's own Fredoka (the fontsource package that app.css imports). */
function fontFile() {
  const rel = 'frontend/node_modules/@fontsource-variable/fredoka/files/fredoka-latin-wght-normal.woff2';
  for (const f of [process.env.STORE_SHOTS_FONT, join(REPO, rel)]) if (f && existsSync(f)) return f;
  throw new Error('Fredoka not found: run "bun install" in frontend/ (the app\'s own font package) or set STORE_SHOTS_FONT to the .woff2');
}

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** The HTML of one composed image. Layout is in units of the canvas width so every size shares one design. */
function page(size, caption, sub, img) {
  const { width: W, height: H } = size;
  const { field, ink } = cfg.look;
  const feature = size.kind === 'feature';
  const u = feature ? H : W;
  const css = `@font-face{font-family:Fredoka;src:url(fredoka.woff2);font-weight:300 700}
*{margin:0;box-sizing:border-box}html,body{width:${W}px;height:${H}px;overflow:hidden;background:${field}}
body{position:relative;font-family:Fredoka,sans-serif;color:${ink}}
.cap{position:absolute;${
    feature
      ? `left:${0.09 * W}px;top:50%;transform:translateY(-50%);width:${0.5 * W}px`
      : `left:${0.08 * W}px;right:${0.08 * W}px;top:${0.085 * W}px;text-align:center`
  }}
.cap h1{font-weight:700;font-size:${feature ? 0.17 * H : 0.083 * W}px;line-height:1.1}
.cap p{margin-top:${0.035 * u}px;font-weight:500;font-size:${feature ? 0.075 * H : 0.04 * W}px;opacity:.78}
.ui{position:absolute;overflow:hidden;background:#fff;border-radius:${feature ? 0.06 * H : 0.05 * W}px;box-shadow:0 ${0.01 * u}px ${0.04 * u}px rgba(21,27,44,.22);
 ${
   feature
     ? `left:${0.64 * W}px;width:${0.27 * W}px;top:${0.1 * H}px;height:${H}px`
     : `left:${0.07 * W}px;width:${0.86 * W}px;top:${sub ? 0.4 * W : 0.34 * W}px;height:${H}px`
 }}
.ui img{display:block;width:100%;height:auto}`;
  return `<!doctype html><meta charset=utf-8><style>${css}</style><div class=cap><h1>${esc(caption)}</h1>${sub && !feature ? `<p>${esc(sub)}</p>` : ''}</div><div class=ui><img src="${img}"></div>`;
}

/** Composes every size and language from the captured PNGs; refuses unverified demo content unless told. */
async function compose() {
  const problems = [...NATIVE.flatMap((src) => (existsSync(join(work, src)) ? verify(src) : [`${src}: no native capture (bun native.mjs --platform ${src})`]))];
  if (problems.length && !allowDirty) {
    for (const p of problems) log('NOT READY', p);
    throw new Error(`${problems.length} problem(s): fix the demo content on dev, or pass --allow-dirty for a PREVIEW- set that must never be uploaded`);
  }
  const stage = join(work, 'stage');
  mkdirSync(stage, { recursive: true });
  copyFileSync(fontFile(), join(stage, 'fredoka.woff2'));
  const srv = serveDir(stage);
  const tab = await newTab(port);
  
  try {
    for (const lang of langs)
      for (const size of cfg.sizes) {
        const dir = join(out, size.id, lang);
        mkdirSync(dir, { recursive: true });
        const items =
          size.kind === 'feature'
            ? [{ id: 'feature-graphic', caption: scenario.featureGraphic.caption[lang], sub: null, shot: scenario.featureGraphic.shot }]
            : scenario.shots.map((s) => ({ id: s.id, caption: s.caption[lang], sub: s.sub?.[lang] ?? null, shot: s.id }));
        for (const it of items) {
          // A final file needs a NATIVE source with no problem of its own; anything else is a PREVIEW.
          const native = sourceOf(size);
          const hasNative = existsSync(join(work, native, lang, `${it.shot}.png`));
          const src = hasNative ? native : 'web';
          const prefix = hasNative && !problems.some((p) => p.startsWith(`${native}/`)) ? '' : 'PREVIEW-';
          if (!existsSync(join(work, src, lang, `${it.shot}.png`))) {
            log('SKIPPED (no capture)', size.id, lang, it.id);
            continue;
          }
          const imgName = `${lang}-${src}-${it.shot}.png`;
          copyFileSync(join(work, src, lang, `${it.shot}.png`), join(stage, imgName));
          writeFileSync(join(stage, 'c.html'), page(size, it.caption, it.sub, imgName));
          await tab.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false });
          await tab.goto(`http://127.0.0.1:${srv.port}/c.html`, 600);
          await tab.ev('document.fonts.ready.then(()=>Promise.all([...document.images].map(i=>i.decode())))');
          const png = flattenPng(await tab.png({ x: 0, y: 0, width: size.width, height: size.height, scale: 1 }));
          const info = pngInfo(png);
          if (info.width !== size.width || info.height !== size.height || info.colorType !== 2)
            throw new Error(`${size.id} ${it.id}: wrong output ${JSON.stringify(info)}`);
          writeFileSync(join(dir, `${prefix}${it.id}.png`), png);
          log('composed', size.id, lang, it.id);
        }
      }
  } finally {
    await tab.close();
    srv.stop();
  }
}

if (cmd === 'capture') await capture();
else if (cmd === 'verify') {
  const p = verify();
  p.forEach((x) => log('PROBLEM', x));
  log(p.length ? `${p.length} problem(s)` : 'demo content verified');
  process.exit(p.length ? 1 : 0);
} else if (cmd === 'compose') await compose();
else if (cmd === 'all') {
  await capture();
  await compose();
} else {
  console.error('usage: bun shots.mjs capture|verify|compose|all (see header)');
  process.exit(2);
}
