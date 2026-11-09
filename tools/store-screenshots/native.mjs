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
 * inspector bridge carries the same page script. The status bar CANNOT be forced from here (the OS
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
import { CLOSE_BANNER, PAGE_PROBE } from './lib.mjs';

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

if (platform === 'ios') {
  throw new Error('iOS capture: the WebKit inspector bridge (rig device I1) is not wired in this tool yet - see README, "What is blocked"');
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
