/**
 * WP-RELOAD-DL-1 - a WebView reload must NOT replay the launch deep link.
 *
 * `getCurrent()` answers "the last deep link this PROCESS was handed" and the Rust plugin holds it
 * for the life of the process. The guard against re-processing it used to be a module variable,
 * which a reload wipes - so a reload re-published `notifNav` and yanked the user into the launch
 * conversation. Measured 2026-08-07 with a launch URL FIFTEEN MINUTES old whose target had already
 * been consumed.
 *
 * The launch here is an explicit VIEW intent rather than a notification tap. That is deliberate and
 * not a shortcut: the defect lives in `checkCurrentUrl` -> `getCurrent()`, which is the same code
 * path whatever created the intent, and driving it directly removes FCM, decryption and the shade
 * from a check that is about none of them. (`force-stop` is likewise safe HERE only because nothing
 * in this check depends on FCM, which Android's STOPPED state would cancel.)
 *
 * The assertion is the negative one: after being parked on the feed, the app STAYS there.
 */
import { listTargets, connect, evaluate, until } from './cdp.mjs';
import { execFileSync } from 'node:child_process';

const SERIAL = process.env.ANDROID_SERIAL || '192.168.1.100:5555';
const GROUP = '00000000-0000-0000-0000-000000000000';
const PKG = 'fr.emse.canari';

const sh = (cmd) =>
  execFileSync('adb', ['-s', SERIAL, 'shell', cmd], { encoding: 'utf8', timeout: 60_000 }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const stage = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(3)}s] ${m}`);
const out = { check: 'WP-RELOAD-DL-1 (device)' };

/**
 * `pidof` EXITS 1 WHEN THE PROCESS IS ABSENT, which is precisely the answer this check wants after
 * a kill - so `execFileSync` throws exactly when the measurement succeeds. A blanket try/catch would
 * be worse than the bug: it turns "adb is gone" into "the app is dead" and every kill assertion
 * passes for free. Only pidof's own empty-output-exit-1 is treated as "not running".
 */
const pid = () => {
  try {
    const p = sh(`pidof ${PKG}`).trim();
    return p ? Number(p.split(/\s+/)[0]) : null;
  } catch (e) {
    if (e.status === 1 && !String(e.stdout || '').trim() && !String(e.stderr || '').trim()) return null;
    throw e;
  }
};

async function attach() {
  const p = pid();
  if (!p) throw new Error('the app is not running');
  execFileSync('adb', ['-s', SERIAL, 'forward', 'tcp:9222', `localabstract:webview_devtools_remote_${p}`], {
    timeout: 30_000,
  });
  for (let i = 0; i < 20; i++) {
    const ts = await listTargets(9222).catch(() => []);
    const t = ts.find((x) => String(x.url).includes('tauri.localhost'));
    if (t) {
      const cx = connect(t.webSocketDebuggerUrl);
      await cx.ready;
      await cx.send('Runtime.enable');
      return cx;
    }
    await sleep(1_000);
  }
  throw new Error('no WebView target after 20 s');
}

const unlock = () => {
  try {
    return execFileSync(
      process.execPath,
      ['pin.mjs', '--port', '9222', '--account', 'owner', '--match', 'tauri.localhost'],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 180_000 }
    )
      .trim()
      .split('\n')
      .pop();
  } catch (e) {
    if (e.status === 2) return 'no modal';
    return `pin.mjs failed: ${String(e.stdout || e.message).slice(0, 160)}`;
  }
};

const look = async (cx) =>
  JSON.parse(
    await evaluate(
      cx,
      `JSON.stringify({ url: location.href,
                        composer: !!document.querySelector('.chat-composer-footer .chat-composer-editor'),
                        gate: (!!document.querySelector('#encryption-pin') || document.body.innerText.indexOf('PIN de chiffrement') !== -1) })`
    )
  );

// ── 1. cold start FROM a deep link ──────────────────────────────────────────
stage('killing the app');
sh(`am force-stop ${PKG}`);
await sleep(2_000);
out.pidAfterKill = pid();
if (out.pidAfterKill !== null) throw new Error('the app survived the kill - a warm start proves nothing here');

stage('launching by VIEW intent on the DM');
sh(`am start -a android.intent.action.VIEW -d "${PKG}://chat/${GROUP}" ${PKG}/.MainActivity`);
await sleep(9_000);
out.pidCold = pid();

let cx = await attach();
out.afterLaunch = await look(cx);
stage(`after launch: ${JSON.stringify(out.afterLaunch)}`);

if (out.afterLaunch.gate) {
  out.unlock = unlock();
  stage(`unlock -> ${out.unlock}`);
  cx.close();
  cx = await attach();
}
await until(cx, `!!document.querySelector('.chat-composer-footer .chat-composer-editor')`, 60_000).catch(() => null);
out.landed = await look(cx);
stage(`landed on the conversation: ${JSON.stringify(out.landed)}`);
out.deepLinkWorked = out.landed.composer === true;

// ── 2. park on the feed - which is itself a reload ───────────────────────────
stage('parking on /posts (Page.navigate = a real reload)');
await cx.send('Page.navigate', { url: 'http://tauri.localhost/posts' });
await until(cx, `document.readyState === 'complete'`, 30_000).catch(() => null);
await sleep(3_000);
out.rightAfterPark = await look(cx);
stage(`right after park: ${JSON.stringify(out.rightAfterPark)}`);

// ── 3. THE ASSERTION: it stays parked ───────────────────────────────────────
stage('watching for 20 s that it does NOT bounce back');
out.samples = [];
for (let i = 0; i < 10; i++) {
  await sleep(2_000);
  const s = await look(cx);
  out.samples.push(`${i * 2 + 2}s ${s.url}${s.composer ? ' +composer' : ''}`);
  if (s.composer || /\/chat/.test(s.url)) break;
}
out.finalState = await look(cx);
stage(`samples: ${JSON.stringify(out.samples)}`);

out.stayedParked = out.finalState.composer === false && !/\/chat/.test(out.finalState.url);
out.verdict = out.deepLinkWorked && out.stayedParked ? 'PASS' : 'FAIL';
out.why = !out.deepLinkWorked
  ? 'the deep link did not open the conversation - nothing to test the reload against'
  : out.stayedParked
    ? 'the reload did not replay the launch deep link'
    : 'THE RELOAD REPLAYED THE LAUNCH DEEP LINK - the app navigated itself back into the conversation';

console.log(JSON.stringify(out, null, 2));
cx.close();
process.exit(0);
