/**
 * The phone, as seen from a check: adb, app lifecycle, notifications, and the WebView.
 *
 * The serial is RESOLVED, never hard-coded: this device's IP has already changed subnet between
 * sessions, and its USB link drops on its own. USB is preferred here (the opposite of `watch.mjs`)
 * because the LIFE phase cuts the radios, and a wireless transport dies with the wifi it rides on.
 */
import { execFileSync } from 'node:child_process';

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
export let SERIAL = serial();
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
export function forwardDevtools(port = 9222) {
  const p = pid();
  if (!p) throw new Error('app is not running - nothing to forward to');
  adb(['forward', `tcp:${port}`, `localabstract:webview_devtools_remote_${p}`]);
  return p;
}

export const wake = () => {
  sh('input keyevent KEYCODE_WAKEUP');
  sh('wm dismiss-keyguard');
};

export const home = () => sh('input keyevent KEYCODE_HOME');
export const forceStop = () => sh(`am force-stop ${PKG}`);
/** The OS reclaiming the process, which keeps WorkManager state - not the user swiping it away. */
export const kill = () => sh(`am kill ${PKG}`);
export const launch = () => sh(`am start -n ${PKG}/.MainActivity`);

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
