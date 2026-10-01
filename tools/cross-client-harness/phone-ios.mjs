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
