#!/usr/bin/env bun
/**
 * The iPhone's counterpart of `adb`, for the cross-client campaign: plain W3C WebDriver against the
 * WebDriverAgent that `wda-daemon.py` keeps alive and forwards to localhost:8100.
 *
 *   bun tools/ios-device/ios.mjs launch [bundle]        start/attach the app (default fr.emse.canari)
 *   bun tools/ios-device/ios.mjs shot <file.png>        screenshot
 *   bun tools/ios-device/ios.mjs tree                   the visible accessibility tree, one line each
 *   bun tools/ios-device/ios.mjs find <text>            elements whose label/name/value contain text
 *   bun tools/ios-device/ios.mjs tap <text | x,y>       tap an element by text, or a point
 *   bun tools/ios-device/ios.mjs type <text>            type into the focused field
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

/** One WDA request. Throws with WDA's own message on a non-2xx, never returns an error object. */
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
    throw new Error(`WDA ${method} ${path} failed (${res.status}): ${json?.value?.message ?? text.slice(0, 200)}`);
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

/** Taps the first element containing `text`, at the centre of its rectangle. */
export async function tapText(sid, text) {
  const hits = await find(sid, text);
  if (!hits.length) throw new Error(`nothing on screen says "${text}"`);
  const { x, y, width, height } = hits[0].rect;
  await tapAt(sid, Math.round(x + width / 2), Math.round(y + height / 2));
  return hits[0];
}

/** Types into the focused field, one character at a time as WDA wants it. */
export async function type(sid, text) {
  await wda('POST', `/session/${sid}/wda/keys`, { value: [...text] });
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
  const observing = ['state', 'active', 'terminate', 'flat', 'swipe', 'button', 'size', 'long', 'gesture', 'url', 'webview', 'type'].includes(cmd);
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
        console.log(`${e.type.replace('XCUIElementType', '')}\t${r.x},${r.y} ${r.width}x${r.height}\t${e.text}`);
      }
      break;
    case 'find':
      for (const e of await find(sid, args.join(' '))) console.log(JSON.stringify(e));
      break;
    case 'tap': {
      const point = /^(\d+),(\d+)$/.exec(args[0] ?? '');
      if (point) await tapAt(sid, Number(point[1]), Number(point[2]));
      else console.log(JSON.stringify(await tapText(sid, args.join(' '))));
      break;
    }
    case 'type':
      // `type -` reads the text from stdin: a password typed into a sign-in sheet never sits in argv.
      await type(sid, args[0] === '-' && args.length === 1 ? await stdinText() : args.join(' '));
      break;
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
