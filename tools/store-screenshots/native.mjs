#!/usr/bin/env bun
/**
 * NATIVE capture: the installed dev app on a bench phone, with its real chrome. These are the only
 * pixels `shots.mjs compose` accepts for a final file (owner, 2026-11-09).
 *
 *   bun native.mjs --platform android [--lang fr,en] [--work DIR] [--open "conversation title"]
 *   bun native.mjs --platform ios     [--lang fr,en] [--work DIR]
 *
 * ANDROID (Mi 9T, adb serial from the rig's names): the app's WebView is reached over CDP (the rig's
 * `phone.mjs` arms the forward), the theme and the language are set where the app reads them
 * (`localStorage` of the WebView) and the page is reloaded, each route is opened from inside the
 * WebView, and the PIXELS are `adb exec-out screencap` of the whole screen - never a CDP screenshot.
 * System UI demo mode gives a clean status bar (clock 12:00, full battery, no notification icon) and
 * is switched off at the end.
 *
 * iOS (iPhone 12): the pixels are WDA's screenshot (`tools/ios-device/ios.mjs shot`); the WebKit
 * inspector is not reachable on the dev app, so taps navigate and the accessibility tree is the
 * probe (`treeProbe`, per-shot `ios` steps in scenario.json). The status bar CANNOT be forced from here (the OS
 * keeps its clock, signal dots and battery), so the shot shows the device's real one.
 *
 * The bench phones are a sandbox; the owner's personal phone is NEVER used (the rig's serial map
 * names the bench Android only).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { armIfPhone, resolveDevice } from '../cross-client-harness/device.mjs';
import { client, evaluate } from '../cross-client-harness/chat.mjs';
import { SERIAL_OF } from '../cross-client-harness/names.mjs';
import { CLOSE_BANNER, PAGE_PROBE, treeProbe } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const scenario = JSON.parse(readFileSync(join(HERE, 'scenario.json'), 'utf8'));
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const platform = opt('platform', 'android');
const langs = opt('lang', 'fr,en').split(',');
const work = resolve(opt('work', join(HERE, '.work')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[native]', ...a);
if (!['android', 'ios'].includes(platform)) throw new Error('--platform android|ios');

const adb = (...a) => execFileSync('adb', ['-s', SERIAL_OF.A1, ...a], { maxBuffer: 1 << 28 });
const demo = (...kv) => adb('shell', 'am', 'broadcast', '-a', 'com.android.systemui.demo', ...kv);

/** Clicks the smallest visible element showing `text`, from inside the page. */
const clickExpr = (text) => `(() => { const t = ${JSON.stringify(text)}; const c = [...document.querySelectorAll('a,button,[role=button],li,div,span')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (e.textContent || '').includes(t); }).sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)[0]; if (!c) return false; c.click(); return true; })()`;

async function screenshot() {
  if (platform === 'android') return execFileSync('adb', ['-s', SERIAL_OF.A1, 'exec-out', 'screencap', '-p'], { maxBuffer: 1 << 28 });
  const out = join(work, '_ios.png');
  execFileSync(process.execPath, [join(HERE, '..', 'ios-device', 'ios.mjs'), 'shot', out]);
  return readFileSync(out);
}

/**
 * The iOS run: the dev app has no inspector tab, so navigation is taps (the native tab bar by
 * position, in-app links by text, per `shot.ios` in scenario.json) and the probe is the
 * accessibility tree (`treeProbe`). Theme and language are set beforehand in Settings > Preferences;
 * the tree's language line is the one asked for, and `verify` reads the text.
 */
async function runIos() {
  const ios = await import('../ios-device/ios.mjs');
  const sid = await ios.session();
  const win = await ios.size(sid);
  for (const lang of langs) {
    for (const shot of scenario.shots) {
      for (const step of shot.ios ?? []) {
        if (step.tab !== undefined) {
          const bar = await ios.tabs(sid);
          const t = bar[step.tab];
          if (!t) throw new Error(`tab ${step.tab} not on screen (${bar.length} tabs): is the app signed in?`);
          await ios.tapAt(sid, Math.round(t.x + t.width / 2), Math.round(t.y + t.height / 2));
        } else {
          await ios.tapText(sid, step.tap[lang]);
        }
        await sleep(3000);
      }
      // The banner's close cross (owner, 2026-11-09): tapped when the tree shows the banner; verify still fails a shot that shows it.
      const hits = [...(await ios.find(sid, 'Environnement de test')), ...(await ios.find(sid, 'Test environment'))];
      if (hits.length) {
        const y0 = hits[0].rect.y;
        const close = ios.flatten(await ios.tree(sid)).find((e) => /^(Fermer|Close)/.test(e.label) && Math.abs(e.rect.y - y0) <= 40);
        if (close) await ios.tapAt(sid, Math.round(close.rect.x + close.rect.width / 2), Math.round(close.rect.y + close.rect.height / 2));
        await sleep(800);
      }
      const dir = join(work, 'ios', lang);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${shot.id}.txt`), treeProbe(ios.flatten(await ios.tree(sid)), lang, win.height));
      writeFileSync(join(dir, `${shot.id}.png`), await screenshot());
      log('captured', platform, lang, shot.id);
    }
  }
}

if (platform === 'ios') {
  await runIos();
  process.exit(0);
}

const target = resolveDevice(['--android']);
await armIfPhone(target, 'store-shots');
const cx = await client(target.port, null, { focus: false });
if (platform === 'android') {
  adb('shell', 'settings', 'put', 'global', 'sysui_demo_allowed', '1');
  demo('-e', 'command', 'enter');
  demo('-e', 'command', 'clock', '-e', 'hhmm', '1200');
  demo('-e', 'command', 'battery', '-e', 'level', '100', '-e', 'plugged', 'false');
  demo('-e', 'command', 'network', '-e', 'wifi', 'show', '-e', 'level', '4');
  demo('-e', 'command', 'notifications', '-e', 'visible', 'false');
}
try {
  for (const lang of langs) {
    await evaluate(cx, `localStorage.setItem('canari-theme','light');localStorage.setItem('PARAGLIDE_LOCALE',${JSON.stringify(lang)});document.cookie='PARAGLIDE_LOCALE=${lang}; path=/; max-age=31536000'`);
    for (const shot of scenario.shots) {
      await evaluate(cx, `location.assign(${JSON.stringify(shot.route)})`);
      await sleep(7000);
      await evaluate(cx, CLOSE_BANNER);
      await sleep(500);
      const target2 = shot.open ? (opt('open', null) ?? shot.open[lang]) : null;
      if (target2) {
        if (!(await evaluate(cx, clickExpr(target2)))) throw new Error(`"${target2}" not on screen`);
        await sleep(3000);
      }
      // The banner comes back after a route change or a tap: closed again right before the pixels (owner, 2026-11-09).
      await evaluate(cx, CLOSE_BANNER);
      await sleep(600);
      await evaluate(cx, 'window.scrollTo(0,0)');
      const text = await evaluate(cx, PAGE_PROBE);
      const dir = join(work, platform, lang);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${shot.id}.txt`), text);
      writeFileSync(join(dir, `${shot.id}.png`), await screenshot());
      log('captured', platform, lang, shot.id);
    }
  }
} finally {
  if (platform === 'android') demo('-e', 'command', 'exit');
  cx.close();
}
process.exit(0);
