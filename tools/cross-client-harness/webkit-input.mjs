/**
 * THE iPHONE'S INPUT LAYER - CDP's `Input` domain performed as WebDriverAgent touches and keystrokes,
 * at the element's position ON SCREEN (docs/wiki/cross-client-ios.md, C1).
 *
 * WHY IT IS ONE SEAM AND NOT A PORT OF EVERY CALLER. The rig types with `Input.insertText` and clicks
 * with `Input.dispatchTouchEvent`/`dispatchMouseEvent` from ~70 call sites (`cdp.mjs`, `chat.mjs`,
 * `comm.mjs`, `pin.mjs`, the rows). The WebKit inspector protocol the iPhone's WebView speaks
 * (through `pymobiledevice3 webinspector cdp`) has no `Input` domain at all, so every one of them
 * would fail on the iPhone. `cdp.mjs`'s `connect()` therefore wraps `send` for the ONE connection
 * that is the iPhone, and every `Input.*` frame becomes a real touch or a real key on the device -
 * the callers are unchanged and their recorder (`armClickRecorder`) still says what took the click.
 *
 * SELECTED BY `CANARI_PHONE=ios` AND THE BRIDGE PORT (`PORTS.I1`), BOTH. With `CANARI_PHONE` unset
 * the predicate answers false before reading anything, so the Android and browser paths keep the
 * very `send` they had. Under `CANARI_PHONE=ios` the browsers (W2 stays one) still keep theirs: the
 * decision is per connection, from the port the socket was opened on, a fact known before any frame.
 *
 * A TOUCH IS REPLAYED AT ITS RELEASE, and that is the one semantic difference. WDA performs a W3C
 * gesture as one request - there is no "finger down" that outlives the call - so `touchStart` and
 * every `touchMove` are RECORDED with their timestamps and `touchEnd` performs the whole trace with
 * the same durations. A tap, a long press (MUT-18's 700 ms) and a drag (COMM-17) keep their timing; a
 * gesture that MEASURES WHILE THE FINGER IS DOWN cannot exist here, and `holdAndSlide({ release:
 * false })` refuses on the iPhone rather than measuring a finger that never touched.
 *
 * THE COORDINATES: a CSS pixel is a POINT on this WebView (WebKit lays an iPhone page out at device
 * points, scale 1), measured from the WebView's own top-left - which is NOT the screen's: UIKit
 * insets the scroll view's content by the status bar unless the shell set `.never`, and the keyboard
 * shrinks the frame (`canari_ios.mm`). So the origin is READ, never assumed: the WebView's rectangle
 * from WDA, the content inset as the frame height the layout viewport does not fill
 * (`documentElement.clientHeight`), and the visual viewport's offset and scale from the page. See
 * {@link toScreenPoint}.
 *
 * WHAT HAS NO KEY ON A SOFT KEYBOARD THROWS {@link WebKitInputUnsupported}: Escape, Tab and the
 * arrows. A row that pressed Escape to close a sheet taps the sheet's close control on the iPhone;
 * pretending the key was sent would be a gesture that did nothing, reported as one that worked.
 */
import { createRequire } from 'node:module';
import { perform, session, wda, webviewRect } from '../ios-device/ios.mjs';
import { phonePlatform } from './phone-platform.mjs';

/** A CDP input the iPhone has no gesture for - typed, so a runner can tell "not portable" from a device fault. */
export class WebKitInputUnsupported extends Error {
  constructor(what, instead) {
    super(`${what} has no iPhone gesture - ${instead}`);
    this.name = 'WebKitInputUnsupported';
    this.what = what;
    this.instead = instead;
  }
}

/** `names.mjs`, read only once the run IS an iPhone run - it is gitignored, and the gate imports this. */
const names = () => createRequire(import.meta.url)('./names.mjs');

/** The port a devtools WebSocket URL was opened on, or null. */
export function portOfWsUrl(wsUrl) {
  try {
    return Number(new URL(wsUrl).port) || null;
  } catch {
    return null;
  }
}

/**
 * Whether the connection opened on `wsUrl` is the iPhone's WebView, whose `Input.*` frames must
 * become WDA gestures.
 *
 * @param {string} wsUrl the devtools socket
 * @param {{ platform?: string, iosPort?: number }} [opts] injectable for the self-test; by default
 *   `CANARI_PHONE` and `names.mjs`'s `PORTS.I1`
 */
export function isWebKitInputTarget(wsUrl, { platform = process.env.CANARI_PHONE, iosPort } = {}) {
  if (phonePlatform(platform) !== 'ios') return false;
  const want = iosPort ?? names().PORTS?.I1;
  if (!want) {
    throw new Error('CANARI_PHONE=ios and no PORTS.I1 in names.mjs - the inspector bridge port (names.example.mjs)');
  }
  return portOfWsUrl(wsUrl) === Number(want);
}

/**
 * The page's half of the geometry: the visual viewport's offset and scale (a pinch or the keyboard
 * moves it inside the layout viewport) and the layout viewport's size. `clientHeight` and not
 * `innerHeight`: WebKit's `innerHeight` follows the VISUAL viewport, which the keyboard shrinks
 * without moving the content's origin.
 */
export const VIEWPORT_PROBE = `JSON.stringify((function () {
  var v = window.visualViewport;
  return {
    ox: v ? v.offsetLeft : 0,
    oy: v ? v.offsetTop : 0,
    scale: v ? v.scale : 1,
    w: document.documentElement.clientWidth,
    h: document.documentElement.clientHeight
  };
})())`;

/**
 * A CSS point of the page -> a WDA point on the screen.
 *
 * `webview` is the WKWebView's frame on screen (points); `viewport` is {@link VIEWPORT_PROBE}'s
 * answer. The content starts `inset` points below the frame's top: the frame height the layout
 * viewport does not fill. UIKit insets the TOP only (status bar, 47 pt on an iPhone 12, measured
 * 2026-09-30: `innerHeight` 797 of 844), and nothing at the bottom - so the whole difference is the
 * top's. With the shell edge to edge the difference is 0 and so is the inset.
 *
 * @returns {{ x: number, y: number, inset: number }} rounded to the point; `inset` reported so a
 *   miss can be read against it
 */
export function toScreenPoint(x, y, { webview, viewport }) {
  const s = viewport.scale || 1;
  const inset = Math.max(0, Math.round(webview.height - viewport.h * s));
  return {
    x: Math.round(webview.x + (x - viewport.ox) * s),
    y: Math.round(webview.y + inset + (y - viewport.oy) * s),
    inset,
  };
}

/** The shortest hold WDA is given for a tap - a down and an up in the same instant is not a touch. */
export const TAP_MIN_MS = 50;

/**
 * A recorded touch trace -> ONE W3C pointer sequence, with the durations the caller actually spent.
 *
 * @param {{ kind: 'down' | 'move' | 'up', x?: number, y?: number, at: number }[]} trace in screen
 *   points and host milliseconds; starts with `down`, ends with `up` (which carries no point - it
 *   lifts where the finger last was)
 */
export function w3cTouch(trace) {
  if (trace[0]?.kind !== 'down') throw new Error('a touch trace starts with its touchStart');
  const out = [
    { type: 'pointerMove', duration: 0, x: trace[0].x, y: trace[0].y },
    { type: 'pointerDown', button: 0 },
  ];
  let prev = trace[0];
  let moved = false;
  for (const step of trace.slice(1)) {
    const elapsed = Math.max(0, Math.round(step.at - prev.at));
    if (step.kind === 'move') {
      out.push({ type: 'pointerMove', duration: elapsed, x: step.x, y: step.y });
      moved = true;
    } else if (step.kind === 'up') {
      // The hold before the lift is what makes a long press LONG - kept as measured, floored for a tap.
      out.push({ type: 'pause', duration: moved ? elapsed : Math.max(TAP_MIN_MS, elapsed) });
      out.push({ type: 'pointerUp', button: 0 });
      return out;
    }
    prev = step;
  }
  throw new Error('a touch trace ends with its touchEnd');
}

/** The keys a soft keyboard has, as XCUITest's `typeText` spells them. */
export const SOFT_KEYS = Object.freeze({ Enter: '\n', Backspace: '\b' });

/**
 * A `dispatchKeyEvent` -> the characters WDA types, or null when the event sends nothing (a keyUp:
 * the keyDown already typed the key). Throws {@link WebKitInputUnsupported} for a key the iPhone's
 * keyboard does not have.
 */
export function keysForKeyEvent(params) {
  const type = params?.type;
  if (type === 'keyUp') return null;
  if (type === 'char') return [...String(params.text ?? '')];
  if (type === 'keyDown' || type === 'rawKeyDown') {
    const k = SOFT_KEYS[params.key];
    if (k === undefined) {
      throw new WebKitInputUnsupported(
        `the ${params.key} key`,
        "the iPhone's keyboard has only Return and Delete - tap the control the key would have reached",
      );
    }
    return [k];
  }
  throw new WebKitInputUnsupported(`Input.dispatchKeyEvent type ${type}`, 'only keyDown/keyUp/char are typed');
}

/**
 * Whether the focused field has a SELECTION, which is what an empty `Input.insertText` deletes in
 * Chrome (`chat.mjs` clears a leftover draft that way, after `selectAll`). With nothing selected it
 * deletes nothing - so the iPhone sends one Delete only when there is something selected to delete.
 */
export const HAS_SELECTION = `(function () {
  var a = document.activeElement;
  if (a && typeof a.selectionStart === 'number' && a.selectionStart !== null) return a.selectionStart !== a.selectionEnd;
  var s = window.getSelection();
  return !!s && !s.isCollapsed;
})()`;

/** The WDA half, over `tools/ios-device/ios.mjs` - in process, so no keystroke is ever an argv value. */
export function wdaDriver() {
  return {
    touch: async (actions) => perform(await session(null), actions),
    keys: async (value) => {
      await wda('POST', `/session/${await session(null)}/wda/keys`, { value });
    },
    webview: async () => webviewRect(await session(null)),
  };
}

/**
 * Wraps a connection's `send` so `Input.*` frames are performed on the iPhone; every other method
 * goes to the WebView untouched.
 *
 * @param {(method: string, params?: object) => Promise<any>} rawSend the connection's own `send`
 * @param {ReturnType<typeof wdaDriver>} [driver] the device - injectable for the self-test
 * @param {{ now?: () => number, log?: (line: string) => void }} [opts]
 */
export function webkitInput(rawSend, driver = wdaDriver(), { now = () => Date.now(), log = (l) => console.log(l) } = {}) {
  /** The WebView rectangle, re-read only when the layout viewport changes size (the keyboard). */
  let frame = { key: null, rect: null };
  /** The touch being recorded, in screen points; null when no finger is down. */
  let trace = null;
  /** The geometry the current touch was measured with - one read per gesture, not per move. */
  let geom = null;

  const evaluate = async (expression) => {
    const r = await rawSend('Runtime.evaluate', { expression, returnByValue: true });
    if (r?.exceptionDetails) throw new Error(`webkit-input: page exception on ${expression.slice(0, 60)}`);
    return r?.result?.value;
  };

  async function geometry() {
    const viewport = JSON.parse(await evaluate(VIEWPORT_PROBE));
    const key = `${viewport.w}x${viewport.h}`;
    if (frame.key !== key) {
      frame = { key, rect: await driver.webview() };
      log(`[webkit-input] WebView at ${JSON.stringify(frame.rect)} for a ${key} layout viewport`);
    }
    return { webview: frame.rect, viewport };
  }

  const at = (x, y) => toScreenPoint(x, y, geom);

  async function down(x, y) {
    if (trace) throw new Error('webkit-input: a second finger went down before the first was lifted');
    geom = await geometry();
    const p = at(x, y);
    trace = [{ kind: 'down', x: p.x, y: p.y, at: now() }];
  }

  function move(x, y, { hoverAllowed = false } = {}) {
    if (!trace) {
      // A MOUSE move with no button down is a hover - `parkPointer` after every click - and a touch
      // screen has no pointer that moves without a finger, so there is nothing to perform. A TOUCH
      // move with no finger down is the caller's fault, refused as Chrome refuses it.
      if (hoverAllowed) return;
      throw new Error('webkit-input: a touchMove with no touch down');
    }
    const p = at(x, y);
    trace.push({ kind: 'move', x: p.x, y: p.y, at: now() });
  }

  async function up() {
    if (!trace) throw new Error('webkit-input: a release with no touch down');
    const done = [...trace, { kind: 'up', at: now() }];
    trace = null;
    await driver.touch(w3cTouch(done));
  }

  async function touchEvent(p) {
    const pt = p.touchPoints?.[0];
    switch (p.type) {
      case 'touchStart':
        return down(pt.x, pt.y);
      case 'touchMove':
        return move(pt.x, pt.y);
      case 'touchEnd':
      case 'touchCancel':
        return up();
      default:
        throw new WebKitInputUnsupported(`Input.dispatchTouchEvent type ${p.type}`, 'touchStart/Move/End only');
    }
  }

  async function mouseEvent(p) {
    switch (p.type) {
      case 'mousePressed':
        return down(p.x, p.y);
      case 'mouseMoved':
        return move(p.x, p.y, { hoverAllowed: true });
      case 'mouseReleased':
        return up();
      default:
        throw new WebKitInputUnsupported(`Input.dispatchMouseEvent type ${p.type}`, 'a phone scrolls with a drag');
    }
  }

  async function insertText(text) {
    if (text === '') {
      if ((await evaluate(HAS_SELECTION)) === true) await driver.keys([SOFT_KEYS.Backspace]);
      return;
    }
    await driver.keys([...text]);
  }

  const send = async (method, params = {}) => {
    if (!method.startsWith('Input.')) return rawSend(method, params);
    switch (method) {
      case 'Input.insertText':
        await insertText(String(params.text ?? ''));
        return {};
      case 'Input.dispatchTouchEvent':
        await touchEvent(params);
        return {};
      case 'Input.dispatchMouseEvent':
        await mouseEvent(params);
        return {};
      case 'Input.dispatchKeyEvent': {
        const keys = keysForKeyEvent(params);
        if (keys?.length) await driver.keys(keys);
        return {};
      }
      default:
        throw new WebKitInputUnsupported(method, 'the iPhone input layer performs touches, mouse presses, keys and text only');
    }
  };
  /** Whether a finger is down (recorded, not yet performed) - what `holdAndSlide` refuses to leave behind. */
  send.touching = () => trace !== null;
  return send;
}
