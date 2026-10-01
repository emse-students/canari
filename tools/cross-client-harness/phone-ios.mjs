/**
 * The iPhone, as seen from a check - `phone.mjs`'s interface, name for name and sync for sync, over
 * WebDriverAgent (`tools/ios-device/ios.mjs`), `pymobiledevice3` and the WebKit inspector bridge.
 * Chosen by `CANARI_PHONE=ios` through `phone-any.mjs`; the device name is `I1`.
 *
 * WHAT EACH ANDROID CHANNEL BECOMES HERE, and the map is the point of the file:
 *
 * | Android                                   | iPhone                                                   |
 * | ----------------------------------------- | -------------------------------------------------------- |
 * | `adb forward` to `webview_devtools_<pid>` | `pymobiledevice3 webinspector cdp --port <PORTS.I1>`, a BENCH build only (`ios.yml` `local_url` adds `tauri/devtools`) |
 * | `pidof`, `dumpsys activity processes`     | WDA `apps/state` (1 dead, 2 suspended, 3 background, 4 front) and `activeAppInfo` |
 * | `am kill` (an OS death)                   | WDA `apps/terminate` (XCTest ends the process; not a user swipe) |
 * | `dumpsys notification` (the shade)        | Notification Center's accessibility tree, read through WDA with the centre pulled down |
 * | `uiautomator` + `input tap` on a row      | the same tree's rectangle + a W3C touch, in POINTS        |
 * | `logcat`                                  | `pymobiledevice3 syslog live`, captured to a file by {@link startSyslog} |
 * | `dumpsys trust` (keyguard)                | WDA `/wda/locked`                                        |
 *
 * WHAT HAS NO COUNTERPART, AND SAYS SO: the raw-shell escapes (`sh`, `adb`, `killAdbServer`) and the
 * FCM socket (`fcmSocket`, `refreshFcmLink`) THROW {@link NotOnIos} naming the iPhone's observable, so
 * a row that reaches for one fails at the call with the port it owes rather than measuring nothing.
 * The native-store readers return `{ error }`, which `phone.mjs` already uses for "the instrument
 * cannot see this" - the app's MLS state and Graine mirror live in the App Group container
 * (`group.fr.emse.canari`), which no lockdown service vends.
 *
 * WHAT ONLY THE iPHONE NEEDS, at the end of the file: the system screens a row drives through WDA
 * - Control Center (`setAirplaneMode`), the Network Link Conditioner (`setLinkConditioner`), the
 * app switcher (`forceQuit`), Settings (`setNotificationsAllowed`), a reboot (`reboot`), a fresh
 * install and the sign-in sheet (`freshInstall`, `signInThroughSheet`), a deep link
 * (`openDeepLink`), a notification's actions (`notificationAction`). The WebView's own input is not
 * here: it is the connection's (`webkit-input.mjs`).
 *
 * SYNCHRONOUS WHERE `phone.mjs` IS. Rows write `if (phone.pid() === null)`; an async `pid()` would
 * return a Promise, never null, and every death would read as a live process. WDA is HTTP, so the
 * sync calls go through a spawned `ios.mjs` - ~100 ms each, the price of keeping one interface.
 *
 * NOTHING HERE HAS RUN AGAINST THE iPHONE YET (2026-10-01: the device was in use by another
 * session). `phone-ios-selftest.mjs` pins every parser and every decision on fixtures; the shapes it
 * pins for Notification Center labels and syslog lines are the expected ones, and the first live read
 * re-pins them - see docs/wiki/cross-client-ios.md.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GENERIC_BODIES } from './notif-bodies.mjs';
import { spawnPin } from './pinspawn.mjs';

export { GENERIC_BODIES };

const HERE = dirname(fileURLToPath(import.meta.url));

const PYMD = process.env.PYMOBILEDEVICE3 || 'pymobiledevice3';

/** The bundle id - the same string as Android's package, which is why `PKG` keeps its name. */
export const PKG = 'fr.emse.canari';
/** The iPhone's WebView serves the app from `tauri://localhost` (Android: `http://tauri.localhost`). */
export const WEBVIEW_MATCH = 'tauri://localhost';
/** The name Notification Center shows a Canari notification under. */
const APP_NAME = process.env.IOS_APP_NAME || 'Canari';
/** The app's process name in the syslog. */
const APP_PROCESS = process.env.IOS_APP_PROCESS || 'canari';

/**
 * A call `phone.mjs` answers and the iPhone cannot, carrying WHAT TO USE INSTEAD. Typed so a runner
 * can tell "this row has not been ported" from a device failure without reading a message.
 */
export class NotOnIos extends Error {
  constructor(call, equivalent) {
    super(`${call}() is Android-only - on the iPhone: ${equivalent}`);
    this.name = 'NotOnIos';
    this.call = call;
    this.equivalent = equivalent;
  }
}

// ---------------------------------------------------------------------------------------------------
// The two transports, injectable so the self-test can drive every decision with no phone.
// ---------------------------------------------------------------------------------------------------

const io = {
  /** One `ios.mjs` command, synchronously; its stdout, trimmed. Throws with ios.mjs's own stderr. */
  ios(args, timeout = 90_000) {
    const r = spawnSync(process.execPath, [join(HERE, '..', 'ios-device', 'ios.mjs'), ...args.map(String)], { encoding: 'utf8', timeout });
    if (r.status !== 0) {
      const why = String(r.stderr || r.error?.message || '').trim().slice(0, 300);
      throw new Error(`ios.mjs ${args[0]} failed (exit ${r.status ?? 'none'}): ${why}`);
    }
    return String(r.stdout).trim();
  },
  /**
   * `ios.mjs type -` with `text` on STDIN - a credential typed into the sign-in sheet never becomes an
   * argv value a process list or a captured shell would show.
   */
  typeStdin(text, timeout = 60_000) {
    const r = spawnSync(process.execPath, [join(HERE, '..', 'ios-device', 'ios.mjs'), 'type', '-'], { input: text, encoding: 'utf8', timeout });
    if (r.status !== 0) throw new Error(`ios.mjs type - failed (exit ${r.status ?? 'none'}): ${String(r.stderr || r.error?.message || '').trim().slice(0, 300)}`);
  },
  /** Runs `sign-install.mjs` on an unsigned bench IPA (it signs AND installs); throws with its output. */
  signInstall(ipa, timeout = 600_000) {
    const r = spawnSync(process.execPath, [join(HERE, '..', 'ios-device', 'sign-install.mjs'), ipa], { encoding: 'utf8', timeout });
    if (r.status !== 0) throw new Error(`sign-install.mjs failed (exit ${r.status ?? 'none'}): ${String(r.stderr || r.stdout || '').trim().slice(-400)}`);
  },
  /** A GET, synchronously; the body, or null when nothing answered. */
  http(url, timeout = 5_000) {
    const script = `const r = await fetch(${JSON.stringify(url)}, { signal: AbortSignal.timeout(${timeout}) }); process.stdout.write(await r.text());`;
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: timeout + 5_000 });
    return r.status === 0 ? String(r.stdout) : null;
  },
  /** One `pymobiledevice3` command's stdout, or throws. */
  pymd(args, timeout = 30_000) {
    const r = spawnSync(PYMD, args, { encoding: 'utf8', timeout });
    if (r.status !== 0) throw new Error(`pymobiledevice3 ${args.join(' ')} failed: ${String(r.stderr || r.error?.message || '').trim().slice(0, 200)}`);
    return String(r.stdout);
  },
  /** Starts `syslog live` detached, appending to `file`; its pid. */
  startCapture(file) {
    const fd = openSync(file, 'a');
    const child = spawn(PYMD, ['syslog', 'live'], { detached: true, stdio: ['ignore', fd, fd] });
    child.unref();
    return child.pid;
  },
  /** Whether a process still exists. */
  alive(p) {
    try {
      process.kill(p, 0);
      return true;
    } catch {
      return false;
    }
  },
  now: () => Date.now(),
  sleepSync: (ms) => Bun.sleepSync(ms),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** Replaces transports for a test; returns the function that restores them. Never called by a row. */
export function __setIo(over) {
  const prev = { ...io };
  Object.assign(io, over);
  return () => Object.assign(io, prev);
}

/** `names.mjs`, loaded only when a value from it is needed - it is gitignored, and the gate imports this file. */
const names = () => createRequire(import.meta.url)('./names.mjs');

// ---------------------------------------------------------------------------------------------------
// Which iPhone.
// ---------------------------------------------------------------------------------------------------

/** Every UDID usbmux lists. */
export function attached() {
  try {
    return JSON.parse(io.pymd(['usbmux', 'list'])).map((d) => d.Identifier ?? d.UniqueDeviceID ?? d.SerialNumber).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * The one iPhone this run drives: `IOS_UDID` when bound, else the only one attached. Two attached
 * and none bound is an ERROR, for the reason `serial.mjs` gives - a guess drives the wrong phone.
 */
export function serial() {
  if (process.env.IOS_UDID) return process.env.IOS_UDID;
  const ids = attached();
  if (ids.length === 1) return ids[0];
  if (ids.length === 0) throw new Error('no iPhone on usbmux - plug it in and trust this computer');
  throw new Error(`${ids.length} iPhones attached and none bound - useDevice('I1') with UDID_OF in names.mjs`);
}

/** The bound UDID, or null - kept for the same name in `phone.mjs`. */
export let SERIAL = process.env.IOS_UDID ?? null;

/**
 * Binds this process (and every child: `IOS_UDID` is inherited) to one named iPhone.
 * NOTE: `wda-daemon.py` serves ONE phone on :8100, so with two iPhones the daemon must be started
 * for the same UDID - this binds the name, it cannot move the daemon.
 */
export function useDevice(name) {
  const want = names().UDID_OF?.[name];
  if (!want) {
    throw new Error(`no UDID known for device ${name} - add it to UDID_OF in the out-of-tree names.mjs (template: names.example.mjs)`);
  }
  const ids = attached();
  if (!ids.includes(want)) throw new Error(`device ${name} is not attached - usbmux lists: ${ids.join(' ') || '(nothing)'}`);
  process.env.IOS_UDID = want;
  SERIAL = want;
  return want;
}

// ---------------------------------------------------------------------------------------------------
// The raw escapes, which have no iPhone meaning.
// ---------------------------------------------------------------------------------------------------

export function sh() {
  throw new NotOnIos('sh', 'there is no shell; use the named function this module exports for the fact the row wanted');
}
export const adb = () => {
  throw new NotOnIos('adb', 'WDA (tools/ios-device/ios.mjs) for the screen, pymobiledevice3 for the device');
};
export function killAdbServer() {
  throw new NotOnIos(
    'killAdbServer',
    'the iPhone reaches the estate over the Wi-Fi, not a USB tunnel - take it off with Control Center airplane mode through WDA',
  );
}

// ---------------------------------------------------------------------------------------------------
// The native stores - in the App Group container, which nothing outside the app can list.
// ---------------------------------------------------------------------------------------------------

const APP_GROUP_BLIND =
  'iOS: the native stores live in the App Group container group.fr.emse.canari, which no lockdown ' +
  'service (house_arrest included) vends - the observable owed is the app reporting COUNTS of it ' +
  'through its own WebView (docs/wiki/cross-client-ios.md)';

export const nativeResidue = () => ({ error: APP_GROUP_BLIND });
export const nativeFootprint = () => ({ error: APP_GROUP_BLIND });
export const graineMirrorSessions = () => ({ error: APP_GROUP_BLIND });
export const forgetGraineMirror = () => ({ error: APP_GROUP_BLIND });

// ---------------------------------------------------------------------------------------------------
// The process.
// ---------------------------------------------------------------------------------------------------

/** WDA's state number for the app, or null when WDA cannot be asked. */
function appState() {
  try {
    return Number(io.ios(['state', PKG]));
  } catch {
    return null;
  }
}

const STATE_NAME = { 2: 'IOS_SUSPENDED', 3: 'IOS_BACKGROUND', 4: 'IOS_FOREGROUND' };

/**
 * The app's pid as a string, or null when it is not running.
 *
 * A BACKGROUND APP HAS NO pid WDA CAN READ - `activeAppInfo` names only the app in front. Its value
 * is then `ios-state-<n>`, which answers the question every caller asks (null = dead) and says why
 * it is not a number; nothing on the iPhone compares pids, because no forward is named after one.
 */
export const pid = () => {
  const s = appState();
  if (s === null || s <= 1) return null;
  if (s === 4) {
    try {
      const a = JSON.parse(io.ios(['active']));
      if (a.bundleId === PKG && a.pid) return String(a.pid);
    } catch {
      /* the state is the answer below */
    }
  }
  return `ios-state-${s}`;
};

/** The state as `phone.mjs` reports Android's (`IOS_SUSPENDED` is the cached analogue), or null when dead. */
export function procState() {
  const s = appState();
  return s === null || s <= 1 ? null : (STATE_NAME[s] ?? `IOS_STATE_${s}`);
}

export const foregrounded = () => {
  try {
    return JSON.parse(io.ios(['active'])).bundleId === PKG;
  } catch {
    return false;
  }
};

/** True when the lock screen is up, false when not, null when WDA cannot say - never "unlocked" by default. */
export function deviceLocked() {
  try {
    return JSON.parse(io.ios(['locked'])) === true;
  } catch {
    return null;
  }
}

/** Screen on and the swipe-up; against a passcode it RAISES the prompt, which only a human answers. */
export const wake = () => io.ios(['unlock']);
export const home = () => io.ios(['button', 'home']);
export const launch = () => io.ios(['launch', PKG]);
/**
 * The process ended so the next start is COLD - what every caller of Android's `force-stop` wants
 * (COMM-18's cold deep link). NOT the app-switcher swipe: on iOS that is a user force-quit, after
 * which the system stops waking the app for background pushes, and LIFE-3 must make that gesture
 * itself, through WDA, because it is the subject of the row.
 */
export const forceStop = () => io.ios(['terminate', PKG]);

/**
 * Sends the app to the background and waits for iOS to SUSPEND it - the analogue of Android's
 * cached state, which a kill must start from for the same reason (a kill of an app still running in
 * front measures a different path).
 */
export async function evictToCache(timeoutMs = 20_000) {
  home();
  const t0 = io.now();
  let state = procState();
  while (io.now() - t0 < timeoutMs) {
    state = procState();
    if (state === null || state === 'IOS_SUSPENDED') break;
    await io.sleep(500);
  }
  return state;
}

/** The OS ending the process from the background (WDA terminate), never the user's switcher swipe. */
export async function kill() {
  const state = await evictToCache();
  io.ios(['terminate', PKG]);
  return state;
}

/** {@link kill}, and then PROOF the process is gone - a kill that missed reads exactly like one that worked. */
export async function killAndProveDead(timeoutMs = 20_000) {
  const stateAtKill = await kill();
  const t0 = io.now();
  while (io.now() - t0 < timeoutMs) {
    if (pid() === null) return { deadInMs: io.now() - t0, stateAtKill };
    await io.sleep(1_000);
  }
  throw new Error(`WDA terminate (state at kill: ${stateAtKill}) did not end the app - it reads ${pid()}`);
}

// ---------------------------------------------------------------------------------------------------
// The WebView, through the WebKit inspector bridge.
// ---------------------------------------------------------------------------------------------------

/** The pages the bridge on `port` lists, [] when nothing answers there. */
export function bridgeTargets(port) {
  const body = io.http(`http://127.0.0.1:${port}/json/list`);
  if (body === null) return [];
  try {
    return JSON.parse(body);
  } catch {
    return [];
  }
}

const appPage = (targets) => targets.find((t) => String(t.url ?? '').startsWith(WEBVIEW_MATCH));

/**
 * Checks the bridge on `port` lists the app's page. There is no forward to RE-POINT on the iPhone -
 * the bridge follows the app across restarts - so this is the check half of Android's function.
 * @returns the pid, as {@link pid} spells it
 */
export function forwardDevtools(port) {
  if (!port) throw new Error('forwardDevtools needs a port - pass PORTS.I1');
  const p = pid();
  if (!p) throw new Error('app is not running - nothing to inspect');
  if (!appPage(bridgeTargets(port))) {
    throw new Error(
      `the inspector bridge on ${port} lists no ${WEBVIEW_MATCH} page - run \`${PYMD} webinspector cdp --port ${port}\`, ` +
        'and install a BENCH build (ios.yml with local_url): a store build is not inspectable',
    );
  }
  return p;
}

/**
 * The IdP hop. On the iPhone it is an ASWebAuthenticationSession - a system sheet the inspector does
 * not reach - so the answer is the same `{ ok: false, reason }` Android gives for "no browser open",
 * with the route that DOES reach it.
 */
export function forwardIdpBrowser(port) {
  if (!port) throw new Error('forwardIdpBrowser needs a port');
  return {
    ok: false,
    reason:
      'the iPhone signs in through ASWebAuthenticationSession, a system sheet no inspector reaches - type ' +
      'the login through WDA (docs/wiki/phone-comparison.md, "Signing in on a RELEASE IPA")',
  };
}

const iosPort = (port) => {
  if (port) return port;
  const p = names().PORTS?.I1;
  if (!p) throw new Error('no PORTS.I1 in names.mjs - the inspector bridge port (names.example.mjs)');
  return p;
};

/**
 * Brings the iPhone to a state a check can measure, or explains why it cannot - never throws for
 * "the phone is not here". Same ladder as Android's: awake, app running, app IN FRONT (a backgrounded
 * WebView answers nothing), and success only once the inspector has listed the page.
 *
 * @returns `{ ok, how, pid, reason }`, `how` always 'usb' (WDA rides usbmux)
 */
export async function ensure({ port, timeoutMs = 20_000, keepIntent = false } = {}) {
  const target = iosPort(port);
  const locked = deviceLocked();
  if (locked === null) return { ok: false, how: null, reason: 'WDA does not answer - run tools/ios-device/wda-daemon.py' };
  try {
    if (locked) wake();
    if (deviceLocked()) return { ok: false, how: 'usb', reason: 'the lock screen is up behind a passcode - a human unlocks it' };
    if (!pid() && !keepIntent) launch();
    const until = io.now() + timeoutMs;
    while (!pid() && io.now() < until) await io.sleep(500);
    if (!pid()) return { ok: false, how: 'usb', reason: 'app would not start' };
    // Same exception as Android's: a caller that has JUST started the app on a link of its own must
    // not have it re-launched over that link.
    if (!keepIntent) {
      launch();
      await io.sleep(1500);
    }
    const deadline = io.now() + timeoutMs;
    while (io.now() < deadline) {
      if (appPage(bridgeTargets(target))) return { ok: true, how: 'usb', pid: pid() };
      await io.sleep(500);
    }
    return { ok: false, how: 'usb', reason: `the app is up but the inspector bridge on ${target} never listed ${WEBVIEW_MATCH}` };
  } catch (e) {
    return { ok: false, how: 'usb', reason: String(e.message || e).slice(0, 160) };
  }
}

/** Awake, in front, inspectable - or throws. */
export async function foreground({ port, timeoutMs = 45_000 } = {}) {
  wake();
  launch();
  const up = await ensure({ port, timeoutMs });
  if (!up.ok) throw new Error(`the iPhone is not measurable after being brought forward: ${up.reason}`);
  return up;
}

/** Unlocks the encryption PIN through the bridge; see `pinspawn.mjs`. The account is I1's. */
export function unlockPin(port) {
  const n = names();
  const account = n.ACCOUNT_OF?.I1;
  if (!account) throw new Error('no ACCOUNT_OF.I1 in names.mjs');
  return spawnPin({ port: iosPort(port), account, match: WEBVIEW_MATCH });
}

// ---------------------------------------------------------------------------------------------------
// Notification Center - the iPhone's shade.
// ---------------------------------------------------------------------------------------------------

/** A relative time Notification Center appends ("maintenant", "il y a 2 min", "10:42", "now", "2m ago"). */
const RELATIVE_TIME = /^(maintenant|now|à l.instant|hier|yesterday|il y a .+|.+ ago|\d+\s?(s|min|m|h|j|d)|\d{1,2}:\d{2})$/i;

/**
 * Canari's notifications out of a FLAT tree (`ios.mjs flat`), in `phone.mjs`'s record shape.
 *
 * A notification is an element whose label STARTS with the app's name; the label is
 * `<app>, <title>, <body>[, <time>]`, comma-joined, with the time anywhere. `full` is the whole label
 * - what a row matches on, as on Android. `channel`, `template` and `inboxLines` are Android
 * concepts and stay empty: iOS files nothing under a channel, and what the tree reads IS what is
 * drawn (see {@link bodyIsDrawn}).
 */
export function parseNotificationCenter(flat, appName = APP_NAME) {
  const head = new RegExp(`^${appName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*,`, 'i');
  const seen = new Set();
  const out = [];
  for (const e of flat ?? []) {
    const label = String(e.text ?? '').split(' | ')[0].trim();
    if (!head.test(label)) continue;
    const at = `${label}@${e.rect?.y ?? ''}`;
    if (seen.has(at)) continue;
    seen.add(at);
    const parts = label.split(/,\s*/).slice(1).filter((p) => !RELATIVE_TIME.test(p.trim()));
    out.push({
      full: label,
      text: label.slice(0, 900),
      title: parts[0] ?? '',
      body: parts.slice(1).join(', '),
      channel: '',
      key: label,
      updatedAt: 0,
      template: '',
      inboxLines: -1,
      rect: e.rect ?? null,
    });
  }
  return out;
}

let SCREEN = null;
const screen = () => (SCREEN ??= JSON.parse(io.ios(['size'])));

/** Pulls Notification Center down from the top-LEFT edge (the top-right one is Control Center). */
function openCentre() {
  const { width, height } = screen();
  const x = Math.round(width * 0.25);
  io.ios(['swipe', x, 2, x, Math.round(height * 0.6), 0.05]);
  io.sleepSync(800);
}

/** Pushes it back up from the bottom edge. */
function closeCentre() {
  const { width, height } = screen();
  const x = Math.round(width / 2);
  io.ios(['swipe', x, height - 2, x, Math.round(height * 0.2), 0.05]);
  io.sleepSync(500);
}

/**
 * WHEN EACH NOTIFICATION WAS FIRST SEEN BY THIS PROCESS - Notification Center prints a relative time,
 * never an instant, so `updatedAt` is the first observation. {@link deviceNowMs} marks everything on
 * screen at that moment as OLD (0), which is what makes a `sinceMs` floor mean on the iPhone what it
 * means on Android: only a notification that appeared after it counts.
 */
const FIRST_SEEN = new Map();

function annotate(list) {
  for (const n of list) {
    if (!FIRST_SEEN.has(n.key)) FIRST_SEEN.set(n.key, io.now());
    n.updatedAt = FIRST_SEEN.get(n.key);
  }
  return list;
}

const readCentre = () => annotate(parseNotificationCenter(JSON.parse(io.ios(['flat']))));

/** Every Canari notification in Notification Center. Opens it, reads it, closes it. */
export function notifications() {
  openCentre();
  try {
    return readCentre();
  } finally {
    closeCentre();
  }
}

/**
 * ALWAYS TRUE, AND THAT IS A STRONGER STATEMENT THAN ANDROID'S. Android reads a dump, which carries
 * a body InboxStyle may not draw; here the record IS the accessibility tree of the drawn screen.
 */
export const bodyIsDrawn = () => true;

/** The undecrypted fallbacks on screen - the matched PATTERN only, never the line. */
export const undecryptedInShade = () =>
  notifications()
    .map((n) => GENERIC_BODIES.findIndex((re) => re.test(n.body)))
    .filter((i) => i >= 0)
    .map((i) => String(GENERIC_BODIES[i]));

/**
 * A floor for {@link awaitNotification}: marks what is ALREADY in Notification Center as old and
 * returns the host clock. Costs one open/close of the centre (~2 s) - take it before the send, as
 * on Android, and not while the app is in front (pulling the centre down makes the app inactive).
 */
export const deviceNowMs = () => {
  openCentre();
  try {
    for (const n of parseNotificationCenter(JSON.parse(io.ios(['flat'])))) FIRST_SEEN.set(n.key, 0);
  } finally {
    closeCentre();
  }
  return io.now();
};

/**
 * Waits until a notification containing `needle` appears, first seen at or after `sinceMs`; the
 * elapsed ms, or null. The centre is held OPEN for the wait - it updates live - and closed at the end.
 */
export async function awaitNotification(needle, timeoutMs = 45_000, sinceMs = 0) {
  const t0 = io.now();
  openCentre();
  try {
    while (io.now() - t0 < timeoutMs) {
      if (readCentre().some((n) => n.full.includes(needle) && n.updatedAt >= sinceMs)) return io.now() - t0;
      await io.sleep(2_000);
    }
    return null;
  } finally {
    closeCentre();
  }
}

/**
 * Taps the notification carrying `needle`, resolved by element. Same three outcomes as Android's:
 * `dumped: false` is an instrument fault, `found: false` the row's answer, `ok: true` the tap.
 * Coordinates are POINTS, read out of the element's own rectangle.
 */
export function tapNotification(needle) {
  openCentre();
  let list;
  try {
    list = readCentre();
  } catch (e) {
    closeCentre();
    return { ok: false, dumped: false, why: `the Notification Center tree could not be read - ${String(e.message || e).slice(0, 200)}` };
  }
  const hit = list.find((n) => n.full.includes(needle));
  if (!hit) {
    closeCentre();
    return { ok: false, dumped: true, found: false, why: `no notification contains ${needle}`, texts: list.map((n) => n.title).slice(0, 25) };
  }
  if (!hit.rect) {
    closeCentre();
    return { ok: false, dumped: true, found: true, why: 'the matching element carries no rectangle' };
  }
  const { x: x1, y: y1, width, height } = hit.rect;
  const x = Math.round(x1 + width / 2);
  const y = Math.round(y1 + height / 2);
  io.ios(['tap', `${x},${y}`]);
  return { ok: true, dumped: true, found: true, x, y, bounds: [x1, y1, x1 + width, y1 + height] };
}

// ---------------------------------------------------------------------------------------------------
// The push transport - APNs, which the phone does not expose as a socket.
// ---------------------------------------------------------------------------------------------------

const APNS_INSTEAD =
  'APNs is held by apsd and has no socket to read or renew - prove each delivery instead: the ' +
  "delivery service's `[PUSH_SEND] ... platform=ios` line (srvLines) and the syslog `apsd` receipt (syslogSince)";

export function fcmSocket() {
  throw new NotOnIos('fcmSocket', APNS_INSTEAD);
}
export async function refreshFcmLink() {
  throw new NotOnIos('refreshFcmLink', APNS_INSTEAD);
}

// ---------------------------------------------------------------------------------------------------
// The native log - the syslog, captured to a file because `syslog live` only streams.
// ---------------------------------------------------------------------------------------------------

const SYSLOG_FILE = process.env.IOS_SYSLOG_FILE || join(tmpdir(), 'canari-ios-syslog.log');
const SYSLOG_PID = `${SYSLOG_FILE}.pid`;
const SYSLOG_MARK = `${SYSLOG_FILE}.mark`;

/**
 * Starts the background `syslog live` capture if it is not running, and returns its pid. The file is
 * outside the repository: a syslog line can carry conversation text.
 */
export function startSyslog() {
  const known = existsSync(SYSLOG_PID) ? Number(readFileSync(SYSLOG_PID, 'utf8')) : 0;
  if (known && io.alive(known)) return known;
  const started = io.startCapture(SYSLOG_FILE);
  writeFileSync(SYSLOG_PID, String(started));
  return started;
}

/**
 * One syslog line, or null when the line is not one (a continuation, a banner). The shape is
 * `pymobiledevice3 syslog live`'s: `<date> <time> <process>{<image>}[<pid>] <<level>>: <message>`,
 * colour codes stripped. The time is the DEVICE's local time.
 */
export function parseSyslogLine(line) {
  // eslint-disable-next-line no-control-regex
  const clean = String(line).replace(/\x1b\[[0-9;]*m/g, '');
  const m = /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+([^\s{[]+)(?:\{([^}]*)\})?\[(\d+)\]\s+<(\w+)>:\s?(.*)$/.exec(clean);
  if (!m) return null;
  return { at: new Date(m[1].replace(' ', 'T').slice(0, 23)).getTime(), process: m[2], image: m[3] ?? '', pid: Number(m[4]), level: m[5], message: m[6] };
}

/** The capture's lines after the last {@link clearLogcat} mark. */
function capturedLines() {
  if (!existsSync(SYSLOG_FILE)) return [];
  const mark = existsSync(SYSLOG_MARK) ? Number(readFileSync(SYSLOG_MARK, 'utf8')) : 0;
  const all = readFileSync(SYSLOG_FILE);
  return all.subarray(Math.min(mark, all.length)).toString('utf8').split(/\r?\n/).filter(Boolean);
}

/**
 * Every captured syslog line at or after `sinceMs` - Android's `logcatSince`. Unfiltered on purpose,
 * as logcat is: `apsd` and SpringBoard lines are evidence for a push row, not noise.
 */
export function syslogSince(sinceMs) {
  return capturedLines().filter((l) => {
    const p = parseSyslogLine(l);
    return p && p.at >= sinceMs - 1_500;
  });
}

/**
 * The `apsd` lines naming this app since `sinceMs` - the DEVICE half of "did APNs deliver", which a
 * push row on the iPhone records beside the server's `[PUSH_SEND] ... platform=ios` line in place of
 * Android's link renewal. Empty means apsd said nothing about the app in the window, which is
 * evidence, not a verdict: what separates "Apple did not deliver" from "the app did not notify".
 */
export function apnsReceipts(sinceMs) {
  return syslogSince(sinceMs).filter((l) => {
    const p = parseSyslogLine(l);
    return p?.process === 'apsd' && p.message.includes(PKG);
  });
}

/** Forgets what was captured so far (by MARKING the file, never truncating a file another process appends to). */
export const clearLogcat = () => {
  startSyslog();
  writeFileSync(SYSLOG_MARK, String(existsSync(SYSLOG_FILE) ? statSync(SYSLOG_FILE).size : 0));
};

/** The app's own lines - Android's `Tauri/Console` read - from the last `sinceLines` captured. */
export function console_(sinceLines = 3000) {
  return capturedLines()
    .slice(-sinceLines)
    .map(parseSyslogLine)
    .filter((p) => p && p.process === APP_PROCESS)
    .map((p) => p.message);
}

// ---------------------------------------------------------------------------------------------------
// The system's own screens - the WDA-only observables (docs/wiki/cross-client-ios.md O3, O6-O11).
//
// EVERY ONE ENDS IN A PROOF READ BACK FROM THE DEVICE, never in "the tap was sent": a switch is
// re-read after it is flipped, a force-quit waits for the process to be gone, an install asks the
// device what is installed. A gesture that missed reads exactly like one that worked otherwise.
//
// THE LABELS ARE THE EXPECTED ONES, French first (the bench iPhone's language) then English. Nothing
// here has run on the iPhone yet; the first live session re-pins them (cross-client-ios.md).
// ---------------------------------------------------------------------------------------------------

const readFlat = () => JSON.parse(io.ios(['flat']));
const labelOf = (e) => String(e?.label || String(e?.text ?? '').split(' | ')[0]).trim();
const centreOf = (r) => ({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
const tapRect = (r) => {
  const c = centreOf(r);
  io.ios(['tap', `${c.x},${c.y}`]);
  return c;
};

/**
 * The first element whose label IS one of `labels` (exact, case-insensitive) and that has a
 * rectangle; `type` narrows to an XCUIElementType suffix (`Button`, `Switch`, `TextField`).
 */
export function findLabelled(flat, labels, { type } = {}) {
  const want = labels.map((l) => l.toLowerCase());
  return (
    (flat ?? []).find(
      (e) => e.rect && want.includes(labelOf(e).toLowerCase()) && (!type || String(e.type ?? '').endsWith(type)),
    ) ?? null
  );
}

/** A switch's state from its accessibility value: true on, false off, null when it is not a switch. */
export function switchState(e) {
  const v = String(e?.value ?? '').trim().toLowerCase();
  if (v === '1' || v === 'on' || v === 'true') return true;
  if (v === '0' || v === 'off' || v === 'false') return false;
  return null;
}

/** Flips the switch labelled one of `labels` to `on` if it is not, then RE-READS it. */
function setSwitch(labels, on, where) {
  const before = findLabelled(readFlat(), labels);
  if (!before) throw new Error(`${where}: no control labelled ${labels.join(' / ')} on screen`);
  const was = switchState(before);
  if (was === null) throw new Error(`${where}: "${labelOf(before)}" is not a switch (value ${JSON.stringify(before.value)})`);
  if (was !== on) {
    tapRect(before.rect);
    io.sleepSync(900);
  }
  const after = switchState(findLabelled(readFlat(), labels));
  if (after !== on) throw new Error(`${where}: "${labelOf(before)}" reads ${after} after the tap - wanted ${on}`);
  return { before: was, after };
}

/** Scrolls the front screen down until an element labelled one of `labels` is ON it; the element. */
function scrollTo(labels, where, maxScrolls = 10) {
  const { width, height } = screen();
  const x = Math.round(width / 2);
  for (let i = 0; i <= maxScrolls; i++) {
    const hit = findLabelled(readFlat(), labels);
    if (hit && hit.rect.y >= 0 && hit.rect.y + hit.rect.height <= height) return hit;
    io.ios(['swipe', x, Math.round(height * 0.75), x, Math.round(height * 0.3), 0.05]);
    io.sleepSync(500);
  }
  throw new Error(`${where}: nothing labelled ${labels.join(' / ')} after ${maxScrolls} scrolls`);
}

// --- O3 - network conditions ------------------------------------------------------------------------

export const AIRPLANE_LABELS = ['Mode Avion', 'Airplane Mode'];
export const WIFI_LABELS = ['Wi-Fi'];

/** Pulls Control Center down from the top-RIGHT edge (the top-left one is Notification Center). */
function openControlCentre() {
  const { width, height } = screen();
  const x = Math.round(width * 0.9);
  io.ios(['swipe', x, 2, x, Math.round(height * 0.6), 0.05]);
  io.sleepSync(900);
}

/**
 * O3 OFFLINE - the phone off every network, through Control Center, the way its user does it.
 * `Network.emulateNetworkConditions` does not exist in WebKit, and cutting the WebView alone would
 * leave the NSE and APNs on the air - which is not what "offline" means to a push row.
 *
 * AIRPLANE MODE IS NOT ENOUGH ON ITS OWN, AND THAT IS WHY WI-FI IS SET TOO. iOS remembers a Wi-Fi
 * turned back on inside airplane mode and restores it the next time, so `airplane on` can leave the
 * phone on the bench's Wi-Fi - which is exactly the network the estate is reached on. Offline is
 * therefore BOTH switches read back off; online is airplane off and Wi-Fi read back on. WDA rides
 * usbmux (the cable), so it keeps answering while the radios are down.
 *
 * @param {boolean} on true = offline
 * @returns {{ airplane: {before, after}, wifi: {before, after} }}
 */
export function setAirplaneMode(on) {
  openControlCentre();
  try {
    const airplane = setSwitch(AIRPLANE_LABELS, on, 'Control Center');
    const wifi = setSwitch(WIFI_LABELS, !on, 'Control Center');
    return { airplane, wifi };
  } finally {
    closeCentre();
  }
}

export const SETTINGS_BUNDLE = 'com.apple.Preferences';
export const DEVELOPER_LABELS = ['Développeur', 'Developer'];
export const LINK_CONDITIONER_LABELS = ['Network Link Conditioner'];
export const LINK_CONDITIONER_ENABLE_LABELS = ['Enable', 'Activer'];

/**
 * O3 THROTTLE - the Developer menu's Network Link Conditioner (the iPhone's only throttle: WebKit has
 * no network emulation). `profile` is the row's name as Settings lists it ("3G", "Very Bad Network",
 * "100% Loss", ...); null switches the conditioner OFF. The Developer menu exists only on a phone that
 * has had a developer build installed - the bench has.
 *
 * The ENABLE switch is read back; the profile row is tapped and NOT proven (a selected cell carries no
 * value the tree exposes), which is the first thing the first live run re-pins.
 */
export function setLinkConditioner(profile) {
  openSettings([DEVELOPER_LABELS, LINK_CONDITIONER_LABELS]);
  try {
    if (profile) {
      tapRect(scrollTo([profile], 'Network Link Conditioner').rect);
      io.sleepSync(600);
    }
    const enable = setSwitch(LINK_CONDITIONER_ENABLE_LABELS, Boolean(profile), 'Network Link Conditioner');
    return { profile: profile ?? null, enable };
  } finally {
    home();
  }
}

// --- O6 - the user's force-quit -----------------------------------------------------------------------

/**
 * The app's card in the open app switcher: labelled with the app's name, and TALL - a card is most of
 * the screen's height, which is what tells it apart from the home screen's icon of the same name
 * (the gesture that opens the switcher can fall short and leave the home screen up).
 */
export function switcherCard(flat, screenHeight, appName = APP_NAME) {
  return (
    (flat ?? []).find(
      (e) =>
        e.rect &&
        labelOf(e).toLowerCase() === appName.toLowerCase() &&
        !String(e.type ?? '').endsWith('Icon') &&
        e.rect.height >= screenHeight * 0.3,
    ) ?? null
  );
}

/**
 * O6 - THE USER'S FORCE-QUIT: the app switcher (a slow drag up from the bottom edge, held mid-screen)
 * and the app's card flicked off the top. Not {@link forceStop}: on iOS this gesture is what stops the
 * system from waking the app for background pushes, which is LIFE-3's subject.
 *
 * PROVEN DEAD, or it throws: a flick that missed the card leaves the app suspended, which reads
 * exactly like a quit to anything that does not ask.
 */
export async function forceQuit(timeoutMs = 10_000) {
  const stateBefore = procState();
  if (stateBefore === null) throw new Error('forceQuit: the app is not running - there is no card to flick');
  const { width, height } = screen();
  const x = Math.round(width / 2);
  io.ios([
    'gesture',
    JSON.stringify([
      { type: 'pointerMove', duration: 0, x, y: height - 2 },
      { type: 'pointerDown', button: 0 },
      { type: 'pointerMove', duration: 450, x, y: Math.round(height * 0.55) },
      { type: 'pause', duration: 900 },
      { type: 'pointerUp', button: 0 },
    ]),
  ]);
  io.sleepSync(900);
  const flat = readFlat();
  const card = switcherCard(flat, height);
  if (!card) {
    home();
    throw new Error(
      `forceQuit: the app switcher shows no ${APP_NAME} card - on screen: ${flat.map(labelOf).filter(Boolean).slice(0, 15).join(' | ')}`,
    );
  }
  const c = centreOf(card.rect);
  io.ios([
    'gesture',
    JSON.stringify([
      { type: 'pointerMove', duration: 0, x: c.x, y: c.y },
      { type: 'pointerDown', button: 0 },
      { type: 'pointerMove', duration: 120, x: c.x, y: 10 },
      { type: 'pointerUp', button: 0 },
    ]),
  ]);
  io.sleepSync(800);
  home();
  const t0 = io.now();
  while (io.now() - t0 < timeoutMs) {
    if (pid() === null) return { stateBefore, deadInMs: io.now() - t0 };
    await io.sleep(500);
  }
  throw new Error(`forceQuit: the card was flicked and the app still reads ${procState()} after ${timeoutMs} ms`);
}

// --- O7 - the Settings app --------------------------------------------------------------------------

/**
 * Opens Settings at its ROOT (ended first, so the path never starts on whatever page was left open)
 * and taps down a path, each step a list of the labels that step may carry; the labels it took.
 */
export function openSettings(steps) {
  io.ios(['terminate', SETTINGS_BUNDLE]);
  io.ios(['launch', SETTINGS_BUNDLE]);
  io.sleepSync(1200);
  const took = [];
  for (const labels of steps) {
    const hit = scrollTo(labels, `Settings > ${took.join(' > ') || '(root)'}`);
    tapRect(hit.rect);
    took.push(labelOf(hit));
    io.sleepSync(900);
  }
  return took;
}

/** iOS 18 lists every app under ONE root row, "Apps"; earlier iOS lists them on the root itself. */
export const APPS_LABELS = ['Apps'];

/** Settings > (Apps >) Canari - whichever the phone's iOS has, decided by which row the root shows. */
export function openAppSettings() {
  const took = openSettings([]);
  const first = scrollTo([APP_NAME, ...APPS_LABELS], 'Settings (root)');
  tapRect(first.rect);
  took.push(labelOf(first));
  io.sleepSync(900);
  if (APPS_LABELS.includes(labelOf(first))) {
    tapRect(scrollTo([APP_NAME], 'Settings > Apps').rect);
    took.push(APP_NAME);
    io.sleepSync(900);
  }
  return took;
}

export const ALLOW_NOTIFICATIONS_LABELS = ['Autoriser les notifications', 'Allow Notifications'];

/**
 * O7 - THE NOTIFICATION PERMISSION, where the user changes it: Settings > Canari > Notifications >
 * the "Allow Notifications" switch, read back. LIFE-7's subject.
 */
export function setNotificationsAllowed(allowed) {
  const path = openAppSettings();
  try {
    tapRect(scrollTo(['Notifications'], `Settings > ${path.join(' > ')}`).rect);
    io.sleepSync(900);
    return { path: [...path, 'Notifications'], ...setSwitch(ALLOW_NOTIFICATIONS_LABELS, allowed, 'Settings > Canari > Notifications') };
  } finally {
    home();
  }
}

// --- O8 - a reboot ----------------------------------------------------------------------------------

/**
 * O8 - REBOOTS THE iPHONE and proves both halves: usbmux LOSES it (the restart was taken - a refused
 * one returns at once and looks like a fast reboot) and then FINDS it again.
 *
 * IT STOPS AT "BEFORE FIRST UNLOCK", deliberately. A rebooted iPhone has no WDA (the runner died with
 * it, and `wda-daemon.py` can only start it again once the phone is unlocked) and its data protection
 * keeps the app's stores sealed until a human enters the passcode - which is LIFE-5's precondition,
 * not the rig's to pass. `wda` reports whether WDA answers yet.
 */
export async function reboot({ downTimeoutMs = 90_000, upTimeoutMs = 300_000 } = {}) {
  const udid = serial();
  io.pymd(['diagnostics', 'restart', '--udid', udid], 60_000);
  const t0 = io.now();
  while (attached().includes(udid)) {
    if (io.now() - t0 > downTimeoutMs) throw new Error(`reboot: usbmux still lists ${udid} ${downTimeoutMs} ms after the restart was asked - it was not taken`);
    await io.sleep(2_000);
  }
  const downInMs = io.now() - t0;
  while (!attached().includes(udid)) {
    if (io.now() - t0 > upTimeoutMs) throw new Error(`reboot: ${udid} went down and did not come back within ${upTimeoutMs} ms`);
    await io.sleep(3_000);
  }
  const locked = deviceLocked();
  return {
    udid,
    downInMs,
    backInMs: io.now() - t0,
    wda: locked === null ? 'down' : 'up',
    locked,
    owed: 'the first unlock is a human passcode (Before First Unlock); then restart wda-daemon.py',
  };
}

// --- O9 - a fresh device ----------------------------------------------------------------------------

/** Whether the app is installed, asked of the device (`pymobiledevice3 apps list`, user apps). */
export function isInstalled() {
  const apps = JSON.parse(io.pymd(['apps', 'list', '--udid', serial()], 60_000));
  return Array.isArray(apps) ? apps.some((a) => a?.CFBundleIdentifier === PKG) : Object.hasOwn(apps ?? {}, PKG);
}

/**
 * Removes the app and PROVES it gone. On the iPhone this is the whole of a wipe: the App Group
 * container (MLS state, Graine mirror) and the WebView's storage go with the last app of the group.
 */
export function uninstall() {
  if (!isInstalled()) return { wasInstalled: false };
  io.pymd(['apps', 'uninstall', PKG, '--udid', serial()], 120_000);
  if (isInstalled()) throw new Error(`uninstall: ${PKG} is still listed after pymobiledevice3 apps uninstall`);
  return { wasInstalled: true };
}

/**
 * O9 - A FRESH DEVICE: uninstall (proven), then `sign-install.mjs` on the unsigned BENCH IPA (it
 * signs and installs), then the device asked again. The sign-in that follows is `login.mjs --device
 * I1`, which drives {@link signInThroughSheet}.
 */
export function freshInstall(ipa) {
  if (!ipa) throw new Error('freshInstall needs the unsigned bench IPA ios.yml (local_url) produced');
  const { wasInstalled } = uninstall();
  io.signInstall(ipa);
  if (!isInstalled()) throw new Error(`freshInstall: sign-install.mjs exited 0 and ${PKG} is not installed`);
  return { wasInstalled, installed: true };
}

/** The consent alert ASWebAuthenticationSession raises before the sheet ("... souhaite utiliser ..."). */
export const CONSENT_LABELS = ['Continuer', 'Continue'];

/**
 * Which stage the sign-in sheet shows: 'consent' (the system alert), 'identifier' or 'password' (the
 * IdP's form, inside the sheet), or null when none is up.
 *
 * THE FORM COUNTS ONLY WHILE THE SHEET IS UP, named by an IdP HOST somewhere on screen (the sheet's
 * bar shows it): Canari's own WebView has text fields too, and the search box of a signed-in app
 * read as an "identifier stage" would have a login typed into it. The consent button counts only
 * inside an ALERT, for the same reason - "Continuer" is also a word the app itself uses.
 */
export function signInStage(flat, hosts) {
  const list = flat ?? [];
  const has = (suffix) => list.some((e) => String(e.type ?? '').endsWith(suffix));
  if (has('Alert') && findLabelled(list, CONSENT_LABELS, { type: 'Button' })) return 'consent';
  const sheetUp = list.some((e) => hosts.some((h) => String(e.text ?? '').includes(h)));
  if (!sheetUp) return null;
  if (has('SecureTextField')) return 'password';
  if (has('TextField')) return 'identifier';
  return null;
}

/** Focuses `field`, deletes what it holds, and types `text` + Return - Return, never the IdP's button. */
function fillField(field, text) {
  tapRect(field.rect);
  io.sleepSync(400);
  // A secure field reads as dots and an empty one as its placeholder: deleting that many characters
  // clears the first and is harmless to the second. Typed through stdin - see `typeStdin`.
  const held = String(field.value ?? '').length;
  io.typeStdin(`${'\b'.repeat(held)}${text}\n`);
}

/**
 * O9 - SIGNS IN THROUGH THE ASWebAuthenticationSession SHEET, by WDA alone: the consent alert
 * ("Continuer"), then the IdP's identifier and password stages, each typed and ended with RETURN.
 * Return and not the form's button: tapping "Continuer" in the form added a character to the password
 * each time (phone-comparison.md, 2026-09-30). The sheet is a system view no inspector reaches, so
 * this is the only route to it.
 *
 * ENDS ON A FACT: `settled()` (the caller's proof - `login.mjs` asks the app whether it holds a
 * session) or the sheet gone after it was answered. An IdP that kept its session closes the sheet by
 * itself after the consent, and that is a success with nothing typed.
 *
 * @param {{ username: string, password: string }} creds never printed, never an argv value
 * @param {{ hosts: string[], settled?: () => Promise<boolean>, timeoutMs?: number }} opts
 */
export async function signInThroughSheet(creds, { hosts, settled = async () => false, timeoutMs = 60_000 } = {}) {
  if (!hosts?.length) throw new Error('signInThroughSheet needs the IdP hosts the sheet shows');
  const answered = [];
  const t0 = io.now();
  while (io.now() - t0 < timeoutMs) {
    if (await settled()) return { stages: answered, inMs: io.now() - t0 };
    const flat = readFlat();
    const stage = signInStage(flat, hosts);
    if (stage === 'consent') {
      tapRect(findLabelled(flat, CONSENT_LABELS, { type: 'Button' }).rect);
      answered.push('consent');
    } else if (stage === 'identifier' || stage === 'password') {
      // A stage answered once and still on screen is the IdP REFUSING it, not a slow page: typing
      // the same credential again would only add to the refusals counted against the account.
      if (!answered.includes(stage)) {
        const field = flat.find((e) => e.rect && String(e.type ?? '').endsWith(stage === 'password' ? 'SecureTextField' : 'TextField'));
        fillField(field, stage === 'password' ? creds.password : creds.username);
        answered.push(stage);
      } else if (io.now() - t0 > timeoutMs / 2) {
        throw new Error(`signInThroughSheet: the ${stage} stage was answered and is still on screen`);
      }
    } else if (answered.length) {
      return { stages: answered, inMs: io.now() - t0 };
    }
    await io.sleep(700);
  }
  throw new Error(`signInThroughSheet: no session after ${timeoutMs} ms - answered: ${answered.join(', ') || 'nothing (the sheet never appeared)'}`);
}

// --- O10 - a deep link ------------------------------------------------------------------------------

/** The confirmation Safari raises before handing a custom scheme to an app. */
export const OPEN_LABELS = ['Ouvrir', 'Open'];

/**
 * O10 - OPENS A DEEP LINK THE WAY THE SYSTEM DOES (`fr.emse.canari://chat/<id>`, COMM-18), with
 * nothing launched first, so a link into a dead app is a COLD start - `cold` says which it was. An
 * "Open in Canari?" confirmation is answered. Ends when the app is in FRONT, or throws; whether the
 * app then routed the link is the row's measurement (`[notifNav] deep link received`).
 */
export async function openDeepLink(url, timeoutMs = 20_000) {
  const before = appState();
  const cold = before === null ? null : before <= 1;
  io.ios(['url', url]);
  let confirmed = false;
  const t0 = io.now();
  while (io.now() - t0 < timeoutMs) {
    if (foregrounded()) return { url, cold, confirmed, inFrontInMs: io.now() - t0 };
    const ask = findLabelled(readFlat(), OPEN_LABELS, { type: 'Button' });
    if (ask) {
      tapRect(ask.rect);
      confirmed = true;
    }
    await io.sleep(500);
  }
  throw new Error(`openDeepLink: ${PKG} never came to the front within ${timeoutMs} ms of ${url}`);
}

// --- O11 - a notification's actions -----------------------------------------------------------------

const STRINGS_DIR = join(HERE, '..', '..', 'frontend', 'src-tauri', 'gen', 'apple', 'canari_iOS');

/** `"key" = "value";` lines of an Apple `.strings` file, as a Map. */
export function parseStrings(src) {
  const out = new Map();
  for (const m of String(src).matchAll(/^\s*"([^"]+)"\s*=\s*"((?:[^"\\]|\\.)*)"\s*;/gm)) out.set(m[1], m[2]);
  return out;
}

/**
 * The titles the app gives its notification actions (`canari_push.mm` registers them), read from the
 * app's OWN `Localizable.strings` in every language it ships - one source, so a renamed action cannot
 * leave the rig looking for the old word.
 */
export function notificationActionTitles(dir = STRINGS_DIR) {
  const titles = { reply: [], send: [], mark_read: [] };
  for (const lang of ['fr', 'en']) {
    const strings = parseStrings(readFileSync(join(dir, `${lang}.lproj`, 'Localizable.strings'), 'utf8'));
    for (const k of Object.keys(titles)) {
      const v = strings.get(`notif.action.${k}`);
      if (v) titles[k].push(v);
    }
  }
  for (const [k, v] of Object.entries(titles)) if (!v.length) throw new Error(`no notif.action.${k} title in ${dir}`);
  return titles;
}

/**
 * O11 - A NOTIFICATION'S ACTION, as its user takes it: Notification Center, a LONG PRESS on the
 * notification carrying `needle` (which expands it and shows its actions), then the action - and for
 * a reply, `text` typed into the field iOS opens and its send button.
 *
 * Same outcome shape as {@link tapNotification}: `found: false` is the row's answer, `ok: false` with
 * `found: true` names the step that did not happen. `ok: true` means the action was TAKEN - its
 * button is gone from the screen; what it then did (the reply delivered, the conversation read) is
 * the row's measurement, on the server and the peer.
 *
 * @param {'reply' | 'mark_read'} action
 */
export async function notificationAction(needle, action, { text } = {}) {
  if (action !== 'reply' && action !== 'mark_read') throw new Error(`notificationAction: unknown action ${action}`);
  if (action === 'reply' && !text) throw new Error('notificationAction: a reply needs its text');
  const titles = notificationActionTitles();
  openCentre();
  try {
    const hit = readCentre().find((n) => n.full.includes(needle));
    if (!hit) return { ok: false, found: false, why: `no notification contains ${needle}` };
    if (!hit.rect) return { ok: false, found: true, why: 'the matching element carries no rectangle' };
    const c = centreOf(hit.rect);
    io.ios(['long', c.x, c.y, 900]);
    io.sleepSync(900);
    const flat = readFlat();
    const button = findLabelled(flat, titles[action], { type: 'Button' });
    if (!button) {
      return {
        ok: false,
        found: true,
        why: `the long press showed no ${titles[action].join(' / ')} action`,
        seen: flat.map(labelOf).filter(Boolean).slice(0, 20),
      };
    }
    tapRect(button.rect);
    io.sleepSync(800);
    if (action === 'reply') {
      io.typeStdin(text);
      const send = findLabelled(readFlat(), titles.send, { type: 'Button' });
      if (!send) return { ok: false, found: true, why: `the reply field shows no ${titles.send.join(' / ')} button` };
      tapRect(send.rect);
      io.sleepSync(800);
    }
    const still = findLabelled(readFlat(), [...titles[action], ...titles.send], { type: 'Button' });
    if (still) return { ok: false, found: true, why: `"${labelOf(still)}" is still on screen after the tap` };
    return { ok: true, found: true, action, x: c.x, y: c.y };
  } finally {
    closeCentre();
  }
}
