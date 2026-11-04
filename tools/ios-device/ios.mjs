#!/usr/bin/env bun
/**
 * The iPhone's counterpart of `adb`, for the cross-client campaign: plain W3C WebDriver against the
 * WebDriverAgent that `wda-daemon.py` keeps alive and forwards to localhost:8100.
 *
 *   bun tools/ios-device/ios.mjs launch [bundle]        start/attach the app (default fr.emse.canari)
 *   bun tools/ios-device/ios.mjs shot <file.png>        screenshot
 *   bun tools/ios-device/ios.mjs tree                   the visible accessibility tree, one line each
 *   bun tools/ios-device/ios.mjs find <text>            elements whose label/name/value contain text
 *   bun tools/ios-device/ios.mjs tap <text | x,y> [--over-keyboard | --no-guard=<reason>]
 *                                                       tap a Button/Link/... by text (an ambiguity is refused and
 *                                                       listed), or a point; refused in the keyboard band unless the flag
 *   bun tools/ios-device/ios.mjs type <text> [--submit] REPLACE the focused field's value in one call, read it back
 *                                                       (exact, or length for a secure field), then Return if --submit;
 *                                                       prints { length, secure, submitted }
 *   bun tools/ios-device/ios.mjs type - --keys          raw key events, no read-back: the device passcode keypad and fields of a
 *                                                       foreign process (a notification reply). A value that is itself
 *                                                       `--submit` or `--keys` cannot be typed as an argv: use stdin `-`.
 *   bun tools/ios-device/ios.mjs swipe x1 y1 x2 y2 [s]  drag, in POINTS (see `size`)
 *   bun tools/ios-device/ios.mjs button <home|volumeUp|volumeDown>
 *   bun tools/ios-device/ios.mjs size                   window size in points
 *   bun tools/ios-device/ios.mjs state [bundle]         1 not running, 2 suspended, 3 background, 4 foreground
 *   bun tools/ios-device/ios.mjs active                 the foreground app: { pid, bundleId, name }
 *   bun tools/ios-device/ios.mjs terminate [bundle]     end the process (an OS death, not a user swipe)
 *   bun tools/ios-device/ios.mjs locked                 whether the device lock screen is up
 *   bun tools/ios-device/ios.mjs unlock                 screen on + swipe up (raises the passcode if one is set)
 *   bun tools/ios-device/ios.mjs flat                   the visible tree as one JSON array
 *   bun tools/ios-device/ios.mjs type -                 type stdin into the focused field (secrets)
 *   bun tools/ios-device/ios.mjs long x y [ms]          press and hold a point
 *   bun tools/ios-device/ios.mjs gesture '<json>'       one W3C touch sequence (pointerMove/Down/Up, pause)
 *   bun tools/ios-device/ios.mjs webview                the app's WKWebView rectangle, in points
 *   bun tools/ios-device/ios.mjs url <url>              open a URL / deep link without launching anything first
 *
 * Coordinates are POINTS, not pixels: the iPhone 12 is 390x844 points for 1170x2532 pixels, so a
 * screenshot pixel divided by 3 is the point to tap. It is the one unit difference from adb.
 *
 * Every function is exported so the campaign scripts can `import` them rather than shell out - a
 * script that spawns this one per action pays a process start each time.
 */

const BASE = process.env.WDA_URL || 'http://127.0.0.1:8100';
export const DEFAULT_APP = 'fr.emse.canari';

/** A WDA refusal, typed: `.status` is the HTTP status, so a caller classifies on it and never on the prose. */
export class WdaError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'WdaError';
    this.status = status;
  }
}

/** One WDA request. Throws a `WdaError` with WDA's own message on a non-2xx, never returns an error object. */
export async function wda(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`WDA ${method} ${path} answered non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok || json?.value?.error) {
    throw new WdaError(`WDA ${method} ${path} failed (${res.status}): ${json?.value?.message ?? text.slice(0, 200)}`, res.status);
  }
  return json;
}

/**
 * The current session, creating one (which launches `bundle`) when there is none. WDA has no
 * session list: `/status` carries the live session id at its top level. An existing session is
 * reused because creating one relaunches the app, which would throw away the screen a script is
 * standing on; `launch()` is the way to bring ANOTHER app up inside it.
 */
export async function session(bundle = DEFAULT_APP) {
  const status = await wda('GET', '/status');
  if (status.sessionId) return status.sessionId;
  // `null` attaches to whatever is on screen and launches nothing - what a question about the app's
  // STATE needs, since a session created with a bundle id would resurrect the app it asks about.
  const caps = bundle ? { bundleId: bundle } : {};
  const created = await wda('POST', '/session', { capabilities: { alwaysMatch: caps }, desiredCapabilities: caps });
  return created.sessionId ?? created.value.sessionId;
}

/** Brings `bundle` to the foreground inside the current session, launching it when needed. */
export async function launch(sid, bundle = DEFAULT_APP) {
  await wda('POST', `/session/${sid}/wda/apps/launch`, { bundleId: bundle });
}

/** Window size in points. */
export async function size(sid) {
  return (await wda('GET', `/session/${sid}/window/size`)).value;
}

/** Saves a PNG screenshot. */
export async function screenshot(sid, file) {
  const { value } = await wda('GET', `/session/${sid}/screenshot`);
  await Bun.write(file, Buffer.from(value, 'base64'));
  return file;
}

/** The accessibility tree as JSON. */
export async function tree(sid) {
  return (await wda('GET', `/session/${sid}/source?format=json`)).value;
}

/**
 * Flattens the tree into the visible elements that say something, in reading order.
 *
 * `label` and `value` travel beside the joined `text` because a SWITCH is answered by its value
 * (`'1'` on, `'0'` off - Control Center's airplane toggle, Settings' notification switch), and a
 * caller that had to split `text` back apart would be guessing which segment was which.
 */
export function flatten(node, out = []) {
  if (!node) return out;
  const text = [node.label, node.name, node.value].filter((s) => typeof s === 'string' && s).join(' | ');
  if (text && node.isVisible !== '0' && node.rect) {
    out.push({
      type: node.type,
      text,
      rect: node.rect,
      label: typeof node.label === 'string' ? node.label : '',
      value: node.value === undefined || node.value === null ? null : String(node.value),
    });
  }
  for (const child of node.children ?? []) flatten(child, out);
  return out;
}

/**
 * The native tab bar's buttons, left to right: `{ x, y, width, height, selected }` in points.
 *
 * ASKED BY CLASS CHAIN, NOT READ OFF `flatten`. The app's tab items carry NO title - icons only,
 * a decision recorded in `NativeTabBar.svelte` - so three of the four have no label, name or value
 * and `flatten` drops them as saying nothing; only the selected one survives, by its value `"1"`.
 * Measured on the iPhone 12, 2026-10-01: four buttons, 95-96 pt wide, at y 765.
 */
export async function tabs(sid) {
  const found = await wda('POST', `/session/${sid}/elements`, {
    using: 'class chain',
    value: '**/XCUIElementTypeTabBar/**/XCUIElementTypeButton',
  });
  const out = [];
  for (const el of found.value ?? []) {
    const id = el.ELEMENT ?? el['element-6066-11e4-a52e-4f735466cecf'];
    const rect = (await wda('GET', `/session/${sid}/element/${id}/rect`)).value;
    const value = (await wda('GET', `/session/${sid}/element/${id}/attribute/value`)).value;
    out.push({ ...rect, selected: value === '1' || value === 1 });
  }
  return out.sort((a, b) => a.x - b.x);
}

/** Elements whose label, name or value contains `text`, case-insensitively. */
export async function find(sid, text) {
  const needle = text.toLowerCase();
  return flatten(await tree(sid)).filter((e) => e.text.toLowerCase().includes(needle));
}

/**
 * Taps a point, in points, as a W3C touch action. This WDA build has no `/wda/tap`, and the W3C
 * endpoint is the one every WebDriver implementation shares, so it is the one not to be surprised by.
 */
export async function tapAt(sid, x, y) {
  await wda('POST', `/session/${sid}/actions`, {
    actions: [
      {
        type: 'pointer',
        id: 'finger1',
        parameters: { pointerType: 'touch' },
        actions: [
          { type: 'pointerMove', duration: 0, x, y },
          { type: 'pointerDown', button: 0 },
          { type: 'pause', duration: 60 },
          { type: 'pointerUp', button: 0 },
        ],
      },
    ],
  });
}

/** The element types a finger acts on. A StaticText or Other carrying the same words does not. */
const TAPPABLE = new Set(['Button', 'Link', 'Cell', 'Switch', 'TextField', 'SecureTextField', 'SearchField', 'Tab', 'MenuItem', 'Toggle']);

/** An element type without WDA's `XCUIElementType` prefix: the tree spells it bare, class lookups spell it long. */
export const bareType = (t) => String(t ?? '').replace(/^XCUIElementType/, '');

/**
 * Chooses what `tap <text>` taps, or throws. PREFERS an interactive element (Button, Link, ...) over
 * a label that merely says the same thing (the first match used to win, and it was a StaticText
 * under the button: "Deverrouiller", "Preferences"). Among the candidates of the winning class it
 * wants EXACTLY ONE distinct rectangle (the tree repeats a node and its text child on one rect), and
 * REFUSES otherwise, listing them: guessing which of two buttons was meant is a tap on the wrong one.
 * Several interactive candidates are first narrowed to those whose label equals `text` exactly.
 * When NOTHING interactive matches, the label itself is tapped and one stderr line says so.
 */
export function pickTapTarget(hits, text) {
  if (!hits.length) throw new Error(`nothing on screen says "${text}"`);
  const interactive = hits.filter((h) => TAPPABLE.has(bareType(h.type)));
  if (!interactive.length) console.error(`[ios] no Button/Link/field says "${text}"; tapping the non-interactive label`);
  let pool = interactive.length ? interactive : hits;
  if (pool.length > 1) {
    const exact = pool.filter((h) => h.label.toLowerCase() === text.toLowerCase());
    if (exact.length) pool = exact;
  }
  const distinct = new Map();
  for (const h of pool) distinct.set(`${h.rect.x},${h.rect.y},${h.rect.width},${h.rect.height}`, h);
  if (distinct.size > 1) {
    const list = [...distinct.values()].map((h) => `  ${bareType(h.type)} ${h.rect.x},${h.rect.y} ${h.rect.width}x${h.rect.height} "${h.label || h.text}"`);
    throw new Error(`"${text}" is ambiguous (${distinct.size} ${interactive.length ? 'interactive' : 'non-interactive'} candidates); tap by coordinates or a longer text:\n${list.join('\n')}`);
  }
  return [...distinct.values()][0];
}

/** Text inputs whose focus raises the keyboard. */
const TEXT_INPUTS = new Set(['TextField', 'SecureTextField', 'SearchField', 'TextView']);

/**
 * Where the top of the keyboard (suggestion bar included) sits, as a fraction of the window height:
 * 519 of 844 pt on the iPhone 12 in PORTRAIT, measured 2026-11-04 - a bound for that phone, not a
 * read. The keyboard is a separate process the app-scoped accessibility tree does not contain (no
 * `XCUIElementTypeKeyboard` node, and `/elements` finds none), so its presence is read from a text
 * input being the FOCUSED ELEMENT (`element/active`). WebKit keeps that focus after the keyboard is dismissed, so the guard can
 * refuse a tap that was safe (a visible refusal naming the override), never allow one silently.
 */
export const KEYBOARD_TOP = 0.615;

/** Whether an element type is a text input, in either spelling. */
export const isTextInput = (t) => TEXT_INPUTS.has(bareType(t));

/**
 * Whether a text input holds focus, which is when the keyboard is up: ONE request for the focused
 * element and one for its type, where reading `/source` for `isFocused` cost 3.4 s on the feed
 * (measured 2026-11-04). A 404 is "nothing focused"; any other failure propagates (fail closed).
 */
export async function keyboardUp(sid) {
  let active;
  try {
    active = await wda('GET', `/session/${sid}/element/active`);
  } catch (e) {
    if (e instanceof WdaError && e.status === 404) return false;
    throw e;
  }
  const id = elementId(active?.value);
  if (!id) return false;
  return isTextInput((await wda('GET', `/session/${sid}/element/${id}/attribute/type`)).value);
}

/** Whether a tap at `y` lands in the keyboard's band, given the window height and whether it is up. */
export function underKeyboard(up, windowHeight, y) {
  return up && y >= windowHeight * KEYBOARD_TOP;
}

/**
 * Refuses a tap that would land on the KEYBOARD. The accessibility tree still lists a button the
 * keyboard covers, so a tap on it presses the KEY under that point - the measured cause of
 * `canari-test-gamma` becoming `canari-test-gammag` and of a 24-character password showing 25 bullets
 * (a tap on "Se connecter" at y 631 hit the `g` key). Dismiss the keyboard (the field toolbar's
 * check mark, or `type --submit`) or scroll the target clear of it.
 *
 * `overKeyboard` is the CALLER'S per-call decision (CLI flag `--over-keyboard`), for a target that
 * sits above the keyboard on a screen the band wrongly covers, or a deliberate key tap. It still
 * reads the tree and, when the guard WOULD have refused, says so on stderr each time. A tree that
 * cannot be read throws: the guard fails closed.
 */
export async function guardKeyboard(sid, x, y, what, { overKeyboard = false, noGuard = '' } = {}) {
  // `noGuard` is a REASON (CLI `--no-guard=<reason>`): the target is inside a foreign process (Settings, a
  // system alert, the shade) where `element/active` of a Canari-bound session proves nothing and no
  // keyboard covers it. No request is made at all; the reason is logged each time.
  if (noGuard) {
    console.error(`[ios] tap ${what} at ${x},${y}: keyboard guard skipped (${noGuard})`);
    return;
  }
  const up = await keyboardUp(sid);
  if (!up) return;
  const { height } = await size(sid);
  if (!underKeyboard(up, height, y)) return;
  const msg = `${what} at ${x},${y}: a text field has focus and the keyboard covers y >= ${Math.round(height * KEYBOARD_TOP)} (iPhone 12 portrait bound)`;
  if (overKeyboard) {
    console.error(`[ios] tapping ${msg} - the caller passed --over-keyboard`);
    return;
  }
  throw new Error(`refusing to tap ${msg}; a tap would press a KEY. Dismiss the keyboard (the toolbar's check mark, or type --submit) or scroll the target above it, or pass --over-keyboard if it is safe`);
}

/** Taps the one element `pickTapTarget` chooses for `text`, at the centre of its rectangle. */
export async function tapText(sid, text, opts = {}) {
  const hit = pickTapTarget(await find(sid, text), text);
  const { x, y, width, height } = hit.rect;
  const cx = Math.round(x + width / 2);
  const cy = Math.round(y + height / 2);
  await guardKeyboard(sid, cx, cy, `"${text}"`, opts);
  await tapAt(sid, cx, cy);
  return hit;
}

/** The W3C element handle key, as WDA spells it in an answer. */
const elementId = (el) => el?.ELEMENT ?? el?.['element-6066-11e4-a52e-4f735466cecf'];

/**
 * What a typed string is made of: stdin text loses ONE trailing line break (`echo`, a heredoc and a
 * file all end in one). Return is NEVER carried in the text: it is `type --submit`. Any remaining
 * control character (a backspace, a tab, a second newline) is refused, since it is not "text".
 */
export function typedText(raw) {
  const text = raw.replace(/\r?\n$/, '');
  if ([...text].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) throw new Error('refusing to type a control character (backspace, tab, newline...): the field is cleared by `type` itself and Return is `--submit`');
  return text;
}

/**
 * Whether what a field reports back matches what was typed. A SECURE field reports its content as
 * bullets, so only the LENGTH can be compared (and nothing about the value may be printed).
 * Compared in code points, since `[...s].length` is what one typed unit is.
 */
export function readbackMatches(text, reported, secure) {
  const got = typeof reported === 'string' ? reported : '';
  return secure ? [...got].length === [...text].length : got === text;
}

/**
 * Types into the focused field IN ONE CALL, then READS IT BACK before anything submits it.
 *
 * It used to send `/wda/keys` with an array of single characters. The 2026-11-04 defects were NOT
 * that path (see `guardKeyboard`), but it could not prove what it typed either. Now: the focused
 * element is asked for, its value is cleared, the whole string goes in as one `value` entry, and the
 * field's reported value is compared - exactly for a plain field, by length for a secure one. A
 * mismatch THROWS after clearing the field (the error says whether the clear worked), it is never
 * retried: a wrong password sent twice is how an account locks. Replaces, not appends.
 * `submit` presses Return AFTER the read-back passed, as one explicit key event.
 * `text` is never logged or put in an error.
 */
export async function type(sid, raw, { submit = false } = {}) {
  const text = typedText(raw);
  if (!text) throw new Error('nothing to type (empty after dropping a trailing line break)');
  let active = null;
  try {
    active = await wda('GET', `/session/${sid}/element/active`);
  } catch (e) {
    if (!(e instanceof WdaError && e.status === 404)) throw e;
  }
  const id = elementId(active?.value);
  // A 404 is "nothing holds focus" - typically the iOS password AutoFill sheet ("Preremplir le mot
  // de passe") is over the field and took focus; close it with its Annuler button first.
  if (!id) throw new Error('no focused element to type into (tap the field first; is a system sheet such as password AutoFill covering it? the device passcode keypad is `type --keys`)');
  const base = `/session/${sid}/element/${id}`;
  const secure = String((await wda('GET', `${base}/attribute/type`)).value).endsWith('SecureTextField');
  await wda('POST', `${base}/clear`, {});
  await wda('POST', `${base}/value`, { text, value: [text] });
  const reported = (await wda('GET', `${base}/attribute/value`)).value;
  if (!readbackMatches(text, reported, secure)) {
    let cleared = 'field cleared';
    try {
      await wda('POST', `${base}/clear`, {});
    } catch (e) {
      cleared = `the clear FAILED too (${e.message.slice(0, 80)}), the field still holds the wrong value`;
      console.error(`[ios] type: ${cleared}`);
    }
    const n = [...(typeof reported === 'string' ? reported : '')].length;
    throw new Error(`typed ${[...text].length} characters but the ${secure ? 'secure ' : ''}field reports ${n} characters; ${cleared}; nothing submitted`);
  }
  if (submit) await wda('POST', `/session/${sid}/wda/keys`, { value: ['\n'] });
  return { length: [...text].length, secure, submitted: submit };
}

/**
 * Raw key events with NO read-back, for the one place that has no text field to read: the device
 * PASSCODE keypad on the lock screen. Anywhere there IS a field, use `type`.
 */
export async function typeKeys(sid, raw) {
  const text = typedText(raw);
  await wda('POST', `/session/${sid}/wda/keys`, { value: [...text] });
  return { length: [...text].length, keys: true };
}

/** A drag from one point to another. */
export async function swipe(sid, x1, y1, x2, y2, seconds = 0.2) {
  await wda('POST', `/session/${sid}/wda/dragfromtoforduration`, { fromX: x1, fromY: y1, toX: x2, toY: y2, duration: seconds });
}

/** A hardware button. Session-scoped: the unscoped `/wda/pressButton` answers 404 on this WDA. */
export async function button(sid, name) {
  await wda('POST', `/session/${sid}/wda/pressButton`, { name });
}

/**
 * The app's lifecycle state as XCTest names it: 1 not running, 2 suspended in the background,
 * 3 running in the background, 4 in the foreground. The iPhone's counterpart of `pidof` plus
 * `dumpsys activity processes`, and the one process fact WDA can read for an app that is NOT in front.
 */
export async function appState(sid, bundle = DEFAULT_APP) {
  return (await wda('POST', `/session/${sid}/wda/apps/state`, { bundleId: bundle })).value;
}

/** The app in the foreground: `{ pid, bundleId, name }`. SpringBoard when the home screen or a system sheet is up. */
export async function activeApp(sid) {
  return (await wda('GET', `/session/${sid}/wda/activeAppInfo`)).value;
}

/**
 * Ends the app's process through XCTest, which the OS treats as a process death and NOT as the user
 * swiping it out of the app switcher - the iPhone's `am kill`, not its `am force-stop`.
 */
export async function terminate(sid, bundle = DEFAULT_APP) {
  return (await wda('POST', `/session/${sid}/wda/apps/terminate`, { bundleId: bundle })).value;
}

/** Whether the device's own lock screen is up. Unscoped on WDA. */
export async function locked() {
  return (await wda('GET', '/wda/locked')).value;
}

/** A finger held still on one point for `ms`, in POINTS: the long press a notification's actions need. */
export async function longPressAt(sid, x, y, ms = 900) {
  await wda('POST', `/session/${sid}/actions`, {
    actions: [
      {
        type: 'pointer',
        id: 'finger1',
        parameters: { pointerType: 'touch' },
        actions: [
          { type: 'pointerMove', duration: 0, x, y },
          { type: 'pointerDown', button: 0 },
          { type: 'pause', duration: ms },
          { type: 'pointerUp', button: 0 },
        ],
      },
    ],
  });
}

/**
 * ONE FINGER, ANY PATH: a W3C touch sequence (`pointerMove`/`pointerDown`/`pause`/`pointerUp`, in
 * POINTS) performed as one gesture. The rig's input layer (`webkit-input.mjs`) replays a CDP touch
 * through this, and the app switcher's slow drag-and-hold is one too - neither is a tap or a swipe.
 */
export async function perform(sid, actions) {
  await wda('POST', `/session/${sid}/actions`, {
    actions: [{ type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' }, actions }],
  });
}

/**
 * The app's WKWebView rectangle on screen, in POINTS - the origin every CSS pixel is measured from.
 * The first `XCUIElementTypeWebView` in the front app: the Canari shell has exactly one.
 */
export async function webviewRect(sid) {
  const found = await wda('POST', `/session/${sid}/element`, { using: 'class name', value: 'XCUIElementTypeWebView' });
  const id = found.value?.ELEMENT ?? found.value?.['element-6066-11e4-a52e-4f735466cecf'];
  if (!id) throw new Error('WDA found no XCUIElementTypeWebView in the front app');
  return (await wda('GET', `/session/${sid}/element/${id}/rect`)).value;
}

/**
 * Opens a URL the way the system does - a custom scheme (`fr.emse.canari://...`) or a web link -
 * WITHOUT launching anything first, so a deep link into a dead app is a cold start. WDA hands it to
 * `XCUIDevice.system.open` where the OS has it, and to Safari otherwise (which then asks "Open in
 * Canari?" - `phone-ios.mjs`'s `openDeepLink` answers that).
 */
export async function openUrl(sid, url) {
  await wda('POST', `/session/${sid}/url`, { url });
}

/** Reads all of stdin - how a SECRET reaches `type -`, never as an argv value a process list shows. */
async function stdinText() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd) {
    throw new Error('usage: ios.mjs <launch|shot|tree|find|tap|type|swipe|button|size|state|active|terminate|locked|unlock|flat|long|gesture|webview|url> ...');
  }
  if (cmd === 'locked') {
    // Unscoped: asking whether the phone is locked must not create a session, which launches the app.
    console.log(JSON.stringify(await locked()));
    return;
  }
  if (cmd === 'unlock') {
    // WDA's own wake: screen on and the swipe-up. It clears a lock screen with no passcode and
    // RAISES the passcode prompt otherwise - the credential is a human's, as on the Android bench.
    await wda('POST', '/wda/unlock');
    return;
  }
  // The commands that ask about the app, or act on whatever screen is up (Notification Center, the
  // home screen), never launch it (see `session`): a killed app must stay killed while a row reads
  // the notification it is waiting for.
  // `url` above all: a deep link opened through a session that had just LAUNCHED the app would be a
  // warm start dressed as a cold one, which is the one thing COMM-18 measures.
  // `type` too: it types into whatever holds focus - a sign-in sheet, a notification's reply field -
  // and launching the app first would take that focus away.
  const observing = ['state', 'active', 'terminate', 'flat', 'swipe', 'button', 'size', 'long', 'gesture', 'url', 'webview', 'type', 'tabs'].includes(cmd);
  const sid = await session(cmd === 'launch' && args[0] ? args[0] : observing ? null : DEFAULT_APP);
  switch (cmd) {
    case 'launch':
      await launch(sid, args[0] ?? DEFAULT_APP);
      console.log(sid);
      break;
    case 'shot':
      console.log(await screenshot(sid, args[0] ?? 'ios-shot.png'));
      break;
    case 'tree':
      for (const e of flatten(await tree(sid))) {
        const r = e.rect;
        console.log(`${e.type}\t${r.x},${r.y} ${r.width}x${r.height}\t${e.text}`);
      }
      break;
    case 'find':
      for (const e of await find(sid, args.join(' '))) console.log(JSON.stringify(e));
      break;
    case 'tap': {
      // `--over-keyboard`: the caller's per-call decision to tap in the keyboard band (see `guardKeyboard`).
      const overKeyboard = args.includes('--over-keyboard');
      // `--no-guard=<reason>`: skip the guard for a target inside a foreign process; the reason is logged.
      const noGuard = args.find((a) => a.startsWith('--no-guard='))?.slice('--no-guard='.length) ?? '';
      if (args.includes('--no-guard')) throw new Error('--no-guard needs a reason: --no-guard=<reason>');
      const rest = args.filter((a) => a !== '--over-keyboard' && a !== '--no-guard' && !a.startsWith('--no-guard='));
      const point = /^(\d+),(\d+)$/.exec(rest[0] ?? '');
      if (point) {
        await guardKeyboard(sid, Number(point[1]), Number(point[2]), 'the point', { overKeyboard, noGuard });
        await tapAt(sid, Number(point[1]), Number(point[2]));
      } else console.log(JSON.stringify(await tapText(sid, rest.join(' '), { overKeyboard, noGuard })));
      break;
    }
    case 'type': {
      // `type -` reads the text from stdin: a password typed into a sign-in sheet never sits in argv.
      // `--submit` presses Return after the read-back; `--keys` is raw events for the passcode keypad.
      // Prints the LENGTH and whether the field was secure, never the text.
      const submit = args.includes('--submit');
      const keys = args.includes('--keys');
      const rest = args.filter((a) => a !== '--submit' && a !== '--keys');
      const raw = rest[0] === '-' && rest.length === 1 ? await stdinText() : rest.join(' ');
      console.log(JSON.stringify(keys ? await typeKeys(sid, raw) : await type(sid, raw, { submit })));
      break;
    }
    case 'long':
      await longPressAt(sid, Number(args[0]), Number(args[1]), args[2] ? Number(args[2]) : undefined);
      break;
    case 'gesture':
      await perform(sid, JSON.parse(args[0]));
      break;
    case 'webview':
      console.log(JSON.stringify(await webviewRect(sid)));
      break;
    case 'url':
      await openUrl(sid, args[0]);
      break;
    case 'swipe':
      await swipe(sid, ...args.slice(0, 4).map(Number), args[4] ? Number(args[4]) : undefined);
      break;
    case 'button':
      await button(sid, args[0]);
      break;
    case 'size':
      console.log(JSON.stringify(await size(sid)));
      break;
    case 'state':
      console.log(await appState(sid, args[0] ?? DEFAULT_APP));
      break;
    case 'active':
      console.log(JSON.stringify(await activeApp(sid)));
      break;
    case 'terminate':
      console.log(JSON.stringify(await terminate(sid, args[0] ?? DEFAULT_APP)));
      break;
    case 'tabs':
      console.log(JSON.stringify(await tabs(sid)));
      break;
    case 'flat':
      // The visible tree as ONE JSON array, for a caller that needs it synchronously
      // (`phone-ios.mjs` spawns this, because the phone interface it mirrors is synchronous).
      console.log(JSON.stringify(flatten(await tree(sid))));
      break;
    default:
      throw new Error(`unknown command ${cmd}`);
  }
}

if (import.meta.main) main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
