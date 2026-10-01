/**
 * THE iPHONE'S INPUT LAYER (`webkit-input.mjs`, C1) - pinned with no phone, no WDA and no names.mjs.
 *
 * What is asserted, and why each one would otherwise fail in silence:
 *
 *   1. THE SELECTION. Only `CANARI_PHONE=ios` AND the bridge port wraps a connection; unset, the
 *      browsers and the Mi 9T keep the very `send` they had (`cx.webkitInput === false`).
 *   2. THE COORDINATES. A CSS point lands on the screen point under it: the WebView's own origin, the
 *      status-bar content inset UIKit adds, the visual viewport's offset and scale. A wrong origin
 *      taps the element above or below - the recorder then names it, but only after the miss.
 *   3. THE GESTURE. A touch is recorded and REPLAYED at its release with the durations the caller
 *      spent: a tap stays a tap, MUT-18's 700 ms press stays a long press, a drag keeps its moves.
 *   4. THE KEYS. Text is typed character by character; an empty insert deletes only a selection;
 *      Return and Delete exist, Escape and the arrows REFUSE (a sent key that does nothing would be
 *      a gesture reported as taken).
 *   5. THE REFUSALS that keep a measurement honest: `holdAndSlide({ release: false })`, an unknown
 *      `Input.*` method, a touchMove with no finger down.
 */
const wk = await import('../webkit-input.mjs');
const { connect, holdAndSlide } = await import('../cdp.mjs');

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}   ${label}${ok || !detail ? '' : ` - ${detail}`}`);
  if (!ok) failures++;
}
const throwsLike = async (fn, Type) => {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof Type ? e : null;
  }
};

// --- 1. Which connection is the iPhone ---------------------------------------------------------------

const IOS_WS = 'ws://127.0.0.1:9444/devtools/page/1';
const W2_WS = 'ws://127.0.0.1:9223/devtools/page/AB';
check('unset CANARI_PHONE: never the iPhone, names.mjs not read', wk.isWebKitInputTarget(IOS_WS, { platform: undefined }) === false);
check('CANARI_PHONE=android: never the iPhone', wk.isWebKitInputTarget(IOS_WS, { platform: 'android', iosPort: 9444 }) === false);
check('CANARI_PHONE=ios on the bridge port: the iPhone', wk.isWebKitInputTarget(IOS_WS, { platform: 'ios', iosPort: 9444 }) === true);
check('CANARI_PHONE=ios on a browser port: still the browser (W2 stays one)', wk.isWebKitInputTarget(W2_WS, { platform: 'ios', iosPort: 9444 }) === false);
{
  const saved = process.env.CANARI_PHONE;
  delete process.env.CANARI_PHONE;
  const cx = connect('ws://127.0.0.1:9/devtools/page/x', 50);
  cx.ready.catch(() => {});
  check('connect() with CANARI_PHONE unset keeps the plain CDP send', cx.webkitInput === false && typeof cx.send.touching !== 'function');
  cx.close();
  if (saved !== undefined) process.env.CANARI_PHONE = saved;
}

// --- 2. CSS px -> WDA points -------------------------------------------------------------------------

const EDGE = { webview: { x: 0, y: 0, width: 390, height: 844 }, viewport: { ox: 0, oy: 0, scale: 1, w: 390, h: 844 } };
const INSET = { webview: { x: 0, y: 0, width: 390, height: 844 }, viewport: { ox: 0, oy: 0, scale: 1, w: 390, h: 797 } };
{
  const p = wk.toScreenPoint(100.4, 200.6, EDGE);
  check('edge to edge: a CSS px IS a point', p.x === 100 && p.y === 201 && p.inset === 0, JSON.stringify(p));
  const q = wk.toScreenPoint(100, 200, INSET);
  check('UIKit status-bar inset (797 of 844): +47 pt', q.y === 247 && q.inset === 47, JSON.stringify(q));
  const k = wk.toScreenPoint(50, 300, { webview: { x: 0, y: 0, width: 390, height: 500 }, viewport: { ox: 0, oy: 0, scale: 1, w: 390, h: 453 } });
  check('keyboard-shrunk frame: the inset is still the top one', k.y === 347 && k.inset === 47, JSON.stringify(k));
  const z = wk.toScreenPoint(200, 300, { webview: { x: 0, y: 0, width: 390, height: 844 }, viewport: { ox: 100, oy: 150, scale: 2, w: 390, h: 422 } });
  check('pinch: the visual viewport offset and scale apply', z.x === 200 && z.y === 300 && z.inset === 0, JSON.stringify(z));
}

// --- 3. Touch traces -> one W3C gesture --------------------------------------------------------------

{
  const tap = wk.w3cTouch([{ kind: 'down', x: 10, y: 20, at: 0 }, { kind: 'up', at: 3 }]);
  check(
    'a tap: move, down, the minimum hold, up',
    JSON.stringify(tap.map((a) => a.type)) === '["pointerMove","pointerDown","pause","pointerUp"]' && tap[2].duration === wk.TAP_MIN_MS,
    JSON.stringify(tap),
  );
  const long = wk.w3cTouch([{ kind: 'down', x: 10, y: 20, at: 0 }, { kind: 'up', at: 700 }]);
  check('a long press keeps its 700 ms', long[2].duration === 700);
  const drag = wk.w3cTouch([
    { kind: 'down', x: 10, y: 20, at: 0 },
    { kind: 'move', x: 10, y: 60, at: 120 },
    { kind: 'move', x: 10, y: 100, at: 140 },
    { kind: 'up', at: 260 },
  ]);
  check(
    'a drag keeps each move and its duration, and lifts after its last hold',
    drag[2].type === 'pointerMove' && drag[2].duration === 120 && drag[3].duration === 20 && drag[4].type === 'pause' && drag[4].duration === 120,
    JSON.stringify(drag),
  );
  let bad = '';
  try {
    wk.w3cTouch([{ kind: 'down', x: 1, y: 1, at: 0 }]);
  } catch (e) {
    bad = e.message;
  }
  check('a trace with no release is refused', /ends with its touchEnd/.test(bad));
}

// --- 4. Keys ----------------------------------------------------------------------------------------

check('Enter is Return', JSON.stringify(wk.keysForKeyEvent({ type: 'keyDown', key: 'Enter' })) === JSON.stringify(['\n']));
check('Backspace is Delete', JSON.stringify(wk.keysForKeyEvent({ type: 'rawKeyDown', key: 'Backspace' })) === JSON.stringify(['\b']));
check('a keyUp types nothing (the keyDown did)', wk.keysForKeyEvent({ type: 'keyUp', key: 'Enter' }) === null);
for (const key of ['Escape', 'Tab', 'ArrowDown']) {
  check(`${key} REFUSES - the soft keyboard has none`, (await throwsLike(() => wk.keysForKeyEvent({ type: 'keyDown', key }), wk.WebKitInputUnsupported)) !== null);
}

// --- 5. The translator, over a fake page and a fake WDA ----------------------------------------------

function rig({ viewport = INSET.viewport, selection = false } = {}) {
  const s = { viewport, selection, touches: [], keys: [], webviewReads: 0, passed: [], clock: 0 };
  const rawSend = async (method, params) => {
    if (method === 'Runtime.evaluate' && params.expression === wk.VIEWPORT_PROBE) return { result: { value: JSON.stringify(s.viewport) } };
    if (method === 'Runtime.evaluate' && params.expression === wk.HAS_SELECTION) return { result: { value: s.selection } };
    s.passed.push(method);
    return { ok: method };
  };
  const driver = {
    touch: async (a) => s.touches.push(a),
    keys: async (k) => s.keys.push(k),
    webview: async () => {
      s.webviewReads++;
      return { x: 0, y: 0, width: 390, height: 844 };
    },
  };
  const send = wk.webkitInput(rawSend, driver, { now: () => s.clock, log: () => {} });
  return { s, send };
}

{
  const { s, send } = rig();
  const r = await send('Runtime.evaluate', { expression: '1+1' });
  check('a non-Input method reaches the WebView untouched', r.ok === 'Runtime.evaluate' && s.passed.includes('Runtime.evaluate'));

  await send('Input.insertText', { text: 'hé!' });
  check('insertText: typed as WDA keys, one character each', JSON.stringify(s.keys.at(-1)) === JSON.stringify(['h', 'é', '!']));
  const before = s.keys.length;
  await send('Input.insertText', { text: '' });
  check('an empty insert with NO selection deletes nothing', s.keys.length === before);
  s.selection = true;
  await send('Input.insertText', { text: '' });
  check('an empty insert over a selection deletes it (one Delete)', JSON.stringify(s.keys.at(-1)) === JSON.stringify(['\b']));
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', text: '\r' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter' });
  check('pressKey Enter: one Return, not two', JSON.stringify(s.keys.at(-1)) === JSON.stringify(['\n']) && s.keys.length === before + 2);

  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 100, y: 200 }] });
  check('touchStart: nothing performed yet, a finger is recorded', s.touches.length === 0 && send.touching() === true);
  s.clock += 5;
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const tap = s.touches.at(-1);
  check('touchEnd: ONE gesture at the SCREEN point (status bar +47)', s.touches.length === 1 && tap[0].x === 100 && tap[0].y === 247, JSON.stringify(tap));
  check('the WebView rectangle was read once for this layout', s.webviewReads === 1);

  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 10, y: 10 }] });
  s.clock += 700;
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  check('longPressBubble on the iPhone: a 700 ms OS press', s.touches.at(-1)[2].duration === 700, JSON.stringify(s.touches.at(-1)));
  check('same layout: the WebView is not re-read', s.webviewReads === 1);

  s.viewport = { ...s.viewport, h: 453 };
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 10, y: 10 }] });
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  check('the keyboard resized the layout: the WebView IS re-read', s.webviewReads === 2);

  const n = s.touches.length;
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 387, y: 400, buttons: 0 });
  check('parkPointer: a hover performs nothing (a touch screen has no pointer)', s.touches.length === n);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 20, y: 30, button: 'left', buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 20, y: 30, button: 'left', buttons: 0 });
  check('a mouse click is a tap', s.touches.length === n + 1);

  let moveErr = '';
  await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 1, y: 1 }] }).catch((e) => (moveErr = e.message));
  check('a touchMove with no finger down is refused, as Chrome refuses it', /no touch down/.test(moveErr));
  check('an unknown Input method is WebKitInputUnsupported', (await throwsLike(() => send('Input.dispatchDragEvent', {}), wk.WebKitInputUnsupported)) !== null);
  check('Escape through the connection is WebKitInputUnsupported', (await throwsLike(() => send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape' }), wk.WebKitInputUnsupported)) !== null);
}

{
  const cx = { webkitInput: true, send: async () => ({}) };
  check(
    'holdAndSlide({ release: false }) REFUSES on the iPhone - no finger stays down between WDA calls',
    (await throwsLike(() => holdAndSlide(cx, '#mic', { release: false }), wk.WebKitInputUnsupported)) !== null,
  );
}

console.log(failures ? `\n${failures} FAILED` : '\nwebkit-input selftest OK');
process.exit(failures ? 1 : 0);
