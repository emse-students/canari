/**
 * The phone, as seen from a check: adb, app lifecycle, notifications, and the WebView.
 *
 * The serial is RESOLVED, never hard-coded: this device's IP has already changed subnet between
 * sessions, and its USB link drops on its own. USB is preferred here (the opposite of `watch.mjs`)
 * because the LIFE phase cuts the radios, and a wireless transport dies with the wifi it rides on.
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { A1_WIFI, PORTS } from './names.mjs';

/** The USB serial if there is one, else the wireless entry. */
export function serial() {
  const out = execFileSync('adb', ['devices'], { encoding: 'utf8' });
  const ids = out
    .split('\n')
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p[1] === 'device')
    .map((p) => p[0]);
  const usb = ids.find((id) => !id.includes(':'));
  const id = usb || ids[0];
  if (!id) throw new Error('no adb device');
  return id;
}

// Exported so that the NATIVE driver (`a1.py`, uiautomator2) is pointed at the SAME transport this
// module is using. When both a USB and a wireless entry are attached - which is the normal state of
// this phone during a long run - `u2.connect()` with no serial raises rather than choosing, and it
// aborted a NOTIF-7 run at the tap with the notification already found and sitting in the shade.
//
// RESOLVED SAFELY AT IMPORT, because this used to throw here. A module that throws while being
// imported cannot be caught by the caller's logic - so with the phone unplugged, merely importing
// this file took down the whole runner, and every browser-only phase with it. The phone being absent
// must cost the phone's phases and nothing else. `run()` re-resolves (and throws properly) the first
// time anything actually needs the device.
export let SERIAL = (() => {
  try {
    return serial();
  } catch {
    return null;
  }
})();
export const PKG = 'fr.emse.canari';

// `dumpsys notification --noredact` on this phone is over a megabyte, which is exactly Node's
// default `maxBuffer` - so the call THROWS ENOBUFS and the check dies with a stack trace instead of
// a verdict. A dump that cannot be read is not "no notification".
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * One adb invocation, RE-RESOLVING the serial once if the transport it was using has gone.
 *
 * The serial is resolved at import, and this phone's USB link drops on its own mid-run - after which
 * every `adb -s <dead serial>` fails with `device '...' not found`. That is not a device that has
 * gone away, it is a device now reachable under a DIFFERENT name (the wireless entry), so a check
 * dying there is a harness fault: it happened, and it hung `notif7.mjs` and a probe after it. One
 * re-resolve, one retry; if the second attempt fails too the device really is gone and the error
 * must reach the caller.
 */
function run(args, timeout) {
  if (!SERIAL) SERIAL = serial(); // throws 'no adb device' with the real reason, at use rather than at import
  try {
    return execFileSync('adb', ['-s', SERIAL, ...args], { encoding: 'utf8', timeout, maxBuffer: MAX_BUFFER });
  } catch (e) {
    const gone = /not found|device offline|no devices/i.test(String(e.stderr || e.message));
    if (!gone) throw e;
    const next = serial(); // throws if there is genuinely nothing attached
    if (next === SERIAL) throw e;
    process.stderr.write(`[phone] transport ${SERIAL} is gone; retrying on ${next}\n`);
    SERIAL = next;
    return execFileSync('adb', ['-s', SERIAL, ...args], { encoding: 'utf8', timeout, maxBuffer: MAX_BUFFER });
  }
}

/** One adb shell command, returning stdout. */
export function sh(cmd, timeout = 30_000) {
  return run(['shell', cmd], timeout);
}

export const adb = (args, timeout = 60_000) => run(args, timeout);

/**
 * The app's pid, or null when it is not running.
 *
 * `pidof` EXITS 1 when nothing matches, so the un-caught form threw exactly in the case the LIFE
 * phase exists to create - the check died on the kill instead of measuring it.
 */
export const pid = () => {
  try {
    return sh(`pidof ${PKG}`).trim() || null;
  } catch {
    return null;
  }
};

/**
 * (Re)points the devtools forward at the CURRENT process.
 *
 * The abstract socket carries the pid, so every process death - a force-stop, an `am kill`, a
 * reboot - leaves the old forward pointing at nothing. A check that forgets this does not fail: it
 * talks to a dead socket and reports the app as unresponsive.
 */
export function forwardDevtools(port) {
  // NO DEFAULT, deliberately. It used to be 9222 - the port A1 has not used since the two browser
  // profiles took 9223/9224 - so a caller that forgot the argument did not fail: it forwarded to a
  // port nothing reads and reported the app as unresponsive. A missing argument must be an error,
  // never a guess at which device was meant.
  if (!port) throw new Error('forwardDevtools needs a port - pass PORTS.A1');
  const p = pid();
  if (!p) throw new Error('app is not running - nothing to forward to');
  adb(['forward', `tcp:${port}`, `localabstract:webview_devtools_remote_${p}`]);
  return p;
}

/**
 * Brings the phone to a state a check can actually measure, or explains why it cannot - and NEVER
 * throws for "the phone is not here".
 *
 * The ladder is USB, then wireless, then give up, in that order and for a reason: the LIFE phase
 * cuts the radios, so a wireless transport would die inside the very check that needs it. Wireless
 * is a way to finish a run whose cable has dropped, not a way to run.
 *
 * Every step below is one that has silently produced a wrong verdict:
 *
 *   - the device listed but the APP not running - the forward points at a dead socket and the app
 *     reads as unresponsive;
 *   - the app running but in the BACKGROUND - its WebView keeps the devtools socket listed and the
 *     `adb forward` succeeds, and CDP never answers, which reads as "not debuggable";
 *   - the forward left over from a previous pid, pointing at nothing or at another app's socket.
 *
 * So this does not report success until something has actually answered on the port.
 *
 * @returns `{ ok, how, pid, reason }` - `how` is 'usb' | 'wifi', `reason` is set only when `ok`.
 */
export async function ensure({ port, wifi, timeoutMs = 20_000 } = {}) {
  const target = port ?? PORTS.A1;
  const address = wifi ?? A1_WIFI;

  let how = 'usb';
  try {
    SERIAL = serial();
    if (SERIAL.includes(':')) how = 'wifi';
  } catch {
    try {
      execFileSync('adb', ['connect', address], { encoding: 'utf8', timeout: 15_000 });
      SERIAL = serial();
      how = 'wifi';
    } catch {
      return { ok: false, how: null, reason: `no adb device on USB, and ${address} did not answer` };
    }
  }

  try {
    wake();
    if (!pid()) launch();
    const until = Date.now() + timeoutMs;
    while (!pid() && Date.now() < until) await new Promise((r) => setTimeout(r, 500));
    if (!pid()) return { ok: false, how, reason: 'app would not start' };

    // Foreground it unconditionally rather than testing first: `launch()` on an app already in front
    // is a no-op, and `foregrounded()` reads a dumpsys line whose format has changed under us before.
    launch();
    await new Promise((r) => setTimeout(r, 1500));

    const p = forwardDevtools(target);

    // THE PROOF. Everything above can succeed against a phone that will never answer.
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://127.0.0.1:${target}/json/version`);
        if (r.ok) return { ok: true, how, pid: p };
      } catch {
        /* not yet */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return { ok: false, how, reason: `forward is up but CDP never answered on ${target}` };
  } catch (e) {
    return { ok: false, how, reason: String(e.message || e).slice(0, 160) };
  }
}

export const wake = () => {
  sh('input keyevent KEYCODE_WAKEUP');
  sh('wm dismiss-keyguard');
};

export const home = () => sh('input keyevent KEYCODE_HOME');
export const forceStop = () => sh(`am force-stop ${PKG}`);
export const launch = () => sh(`am start -n ${PKG}/.MainActivity`);

/**
 * The app's current OOM state as Android names it (`CAC*` cached, `LAST` previous, `FGS`, ...), or
 * null when the process is gone or the dump cannot be read.
 *
 * The dump lists the WebView's sandboxed renderer under this package's uid as well, so the process
 * is matched on `<pid>:fr.emse.canari/` specifically - the renderer's own state answers a different
 * question and is usually one rung apart.
 */
export function procState() {
  let out;
  try {
    out = sh(`dumpsys activity processes ${PKG}`);
  } catch {
    return null;
  }
  const lines = out.split('\n');
  const own = new RegExp(`\\d+:${PKG.replace(/\./g, '\\.')}/`);
  for (let i = 0; i < lines.length; i++) {
    if (!own.test(lines[i])) continue;
    // The state sits on its own line just under the `Proc #` line it belongs to.
    for (let j = i; j < Math.min(i + 4, lines.length); j++) {
      const m = lines[j].match(/state:\s*cur=(\S+)/);
      if (m) return m[1];
    }
  }
  return null;
}

/**
 * Drops the app to CACHED, which is the precondition `am kill` has and HOME does not establish.
 *
 * `am kill` RECLAIMS A CACHED PROCESS AND NOTHING ELSE. After HOME the app holds Android's
 * "previous" slot - `state: cur=LAST` - whose adj sits below the threshold the command uses, so the
 * kill succeeds, prints nothing, and the process lives. That reads exactly like a kill the framework
 * ignored, and it cost NOTIF-4 its first run on 2026-08-16: `am kill did not kill the app`, with the
 * process measured at `LAST` two seconds after HOME, which is precisely how long the sleep was.
 *
 * Opening any OTHER app displaces it from that slot and it falls to cached. That is a STATE, so it
 * is polled for rather than slept on - the delay depends on what else the phone is doing, and a
 * fixed wait here is the same guess that failed above.
 *
 * `am force-stop` is not the alternative and must never become one: a force-stopped package sits in
 * Android's STOPPED state, where the framework cancels every FCM broadcast to it - destroying the
 * one thing every push check exists to measure.
 */
export async function evictToCache(timeoutMs = 20_000) {
  home();
  try {
    // Settings is the neutral displacer: present on every Android, and it starts without network,
    // account or notification state of its own that a later assertion could trip over.
    sh('am start -a android.settings.SETTINGS');
  } catch {
    // A device without it still reaches cached on its own eventually; the poll below decides.
  }
  const t0 = Date.now();
  let state = procState();
  while (Date.now() - t0 < timeoutMs) {
    state = procState();
    if (state === null || /^CAC/.test(state)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  home();
  return state;
}

/**
 * The OS reclaiming the process, which keeps WorkManager state - not the user swiping it away.
 *
 * Establishes its own precondition (see {@link evictToCache}) rather than trusting the caller to
 * have slept long enough, because every caller had written the same two lines and all three were
 * wrong in the same way.
 *
 * @returns the state the process was in when the kill was issued - evidence for a kill that misses.
 */
export async function kill() {
  const state = await evictToCache();
  sh(`am kill ${PKG}`);
  return state;
}

export const foregrounded = () => /fr\.emse\.canari/.test(sh('dumpsys window | grep mCurrentFocus'));

/**
 * Every notification this app currently shows, as flat text.
 *
 * `--noredact` matters: without it the OS hides the text of notifications it considers sensitive,
 * and the check then reports "no content" for a notification that was perfectly decrypted.
 */
export function notifications() {
  const out = adb(['shell', 'dumpsys', 'notification', '--noredact'], 45_000);
  const blocks = out.split(/NotificationRecord\(/).slice(1);
  return blocks
    .filter((b) => b.includes(PKG))
    .map((b) => ({
      // `full` is what checks MATCH on; `text` is only what they PRINT. Matching on the truncated
      // form made LIFE-2 report "no notification" for a notification whose title and body were
      // right there in the same dump - the marker simply sat past the 900th character.
      full: b.replace(/\s+/g, ' '),
      text: b.replace(/\s+/g, ' ').slice(0, 900),
      title: (b.match(/android\.title=(?:String \()?([^\n)]*)/) || [])[1]?.trim() ?? '',
      body: (b.match(/android\.text=(?:String \()?([^\n)]*)/) || [])[1]?.trim() ?? '',
    }));
}

/** Waits until some notification's text contains `needle`; returns the elapsed ms or null. */
export async function awaitNotification(needle, timeoutMs = 45_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (notifications().some((n) => n.full.includes(needle))) return Date.now() - t0;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return null;
}

/** The app's own console, from logcat - the only way to read it while the WebView is unreachable. */
export function console_(sinceLines = 3000) {
  return adb(['logcat', '-d', '-t', String(sinceLines)], 60_000)
    .split('\n')
    .filter((l) => l.includes('Tauri/Console'))
    .map((l) => l.replace(/^.*Msg: /, ''));
}

export const clearLogcat = () => adb(['logcat', '-c']);

// Run directly => bring the phone to a measurable state and print what it took. This is the ONLY
// entry point for the forward: `a1forward.mjs` used to be a second one, and it declared its own bare
// `adb` with no `-s`, so with both a USB and a wireless transport attached - the normal state of this
// phone during a long run - it died on `more than one device/emulator` while `run()` right here was
// selecting the transport correctly. A duplicated primitive does not drift slowly; it is simply
// missing whatever the original learnt.
//
// `pathToFileURL` rather than a hand-built `file://`: on Windows the hand-built form is
// `file://C:/...` where `import.meta.url` is `file:///C:/...`, so the guard never matched and the
// script printed nothing, which looks exactly like a run that succeeded.
// `process.argv[1]` is UNDEFINED under `node -e` / `node --eval`, and `pathToFileURL(undefined)`
// throws - at IMPORT time, in a module every browser-only runner imports. That is the same fault the
// SERIAL resolution above was written to avoid, arriving through a different door.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // THE PORT IS POSITIONAL, AND A FLAG IN ITS PLACE USED TO BECOME NaN IN SILENCE. `node phone.mjs
  // --ensure --port 9333` read `--ensure` as the port, `Number` gave NaN, and `forwardDevtools`
  // reported "needs a port - pass PORTS.A1" - an error about the API, raised by a mistake in the
  // command line, which cost a cycle on 2026-08-22. There are no flags here and there is no reason
  // for any; the only argument is a port, so an argument that is not one says so.
  const raw = process.argv[2];
  if (raw !== undefined && !/^\d+$/.test(raw)) {
    console.error(`phone.mjs takes ONE optional argument, a port number - got "${raw}".`);
    console.error(`Usage: node phone.mjs [port]   (default ${PORTS.A1})`);
    process.exit(2);
  }
  const port = Number(raw || PORTS.A1);
  const state = await ensure({ port });
  console.log(JSON.stringify({ port, serial: SERIAL, ...state }, null, 1));
  if (!state.ok) process.exit(1);
}
