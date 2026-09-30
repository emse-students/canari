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
    body: body === undefined ? undefined : JSON.stringify(body),
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
  const caps = { bundleId: bundle };
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

/** Flattens the tree into the visible elements that say something, in reading order. */
export function flatten(node, out = []) {
  if (!node) return out;
  const text = [node.label, node.name, node.value].filter((s) => typeof s === 'string' && s).join(' | ');
  if (text && node.isVisible !== '0' && node.rect) out.push({ type: node.type, text, rect: node.rect });
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

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd) throw new Error('usage: ios.mjs <launch|shot|tree|find|tap|type|swipe|button|size> ...');
  const sid = await session(cmd === 'launch' && args[0] ? args[0] : DEFAULT_APP);
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
      await type(sid, args.join(' '));
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
    default:
      throw new Error(`unknown command ${cmd}`);
  }
}

if (import.meta.main) main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
