/**
 * `tools/ios-device/ios.mjs`'s decisions, pinned with no phone: what `type` sends and compares, what
 * `tap <text>` is allowed to tap, and when a tap is refused because the keyboard is over it.
 *
 * Measured 2026-11-04 on the iPhone 12: a tap on "Se connecter" at y 631 landed on the `g` key of the
 * keyboard covering it (the tree still listed the button), which is how `canari-test-gamma` became
 * `canari-test-gammag` and a 24-character password showed 25 bullets.
 */
import { isTextInput, pickTapTarget, readbackMatches, typedText, underKeyboard } from '../../ios-device/ios.mjs';

let failures = 0;
const check = (name, ok) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
};
const throws = (fn, re) => {
  try {
    fn();
  } catch (e) {
    return re.test(e.message);
  }
  return false;
};
const el = (type, label, x, y, w = 100, h = 40) => ({ type, text: label, label, rect: { x, y, width: w, height: h }, value: null });

// type: stdin loses exactly ONE trailing line break, control characters are refused
check('a trailing LF is dropped', typedText('abc\n') === 'abc');
check('a trailing CRLF is dropped', typedText('abc\r\n') === 'abc');
check('only ONE line break is dropped', throws(() => typedText('abc\n\n'), /control character/));
check('a tab is refused', throws(() => typedText('a\tb'), /control character/));
check('accents survive', typedText('é!') === 'é!');

// the read-back: exact for a plain field, length only for a secure one
check('plain field: equal passes', readbackMatches('canari-test-gamma', 'canari-test-gamma', false));
check('plain field: one extra character fails', !readbackMatches('canari-test-gamma', 'canari-test-gammag', false));
check('secure field: same length passes', readbackMatches('x'.repeat(24), '•'.repeat(24), true));
check('secure field: 25 bullets for 24 fails', !readbackMatches('x'.repeat(24), '•'.repeat(25), true));
check('a missing value fails', !readbackMatches('abc', null, false));

// tap <text>: an interactive element beats the label under it, ambiguity is refused with the list
const pair = [el('StaticText', 'Deverrouiller', 60, 700), el('Button', 'Deverrouiller', 35, 690, 320, 53)];
check('the Button wins over the StaticText', pickTapTarget(pair, 'Deverrouiller').type === 'Button');
check('a node and its text child on one rect are ONE candidate', pickTapTarget([el('Button', 'Ok', 1, 1), el('StaticText', 'Ok', 1, 1)], 'Ok').type === 'Button');
check(
  'two different buttons are refused and listed',
  throws(() => pickTapTarget([el('Button', 'Annuler', 10, 10), el('Button', 'Annuler', 10, 300)], 'Annuler'), /ambiguous \(2 interactive candidates\)[\s\S]*10,10[\s\S]*10,300/),
);
check('an exact label narrows several interactive candidates', pickTapTarget([el('Button', 'Se connecter', 10, 10), el('Button', 'Se connecter au wifi', 10, 300)], 'Se connecter').rect.y === 10);
check('a lone StaticText is still tappable', pickTapTarget([el('StaticText', 'Hello', 1, 1)], 'Hello').type === 'StaticText');
check('nothing on screen throws', throws(() => pickTapTarget([], 'x'), /nothing on screen/));

// the keyboard guard
check('text inputs raise the keyboard, in either spelling', isTextInput('TextField') && isTextInput('XCUIElementTypeSecureTextField') && !isTextInput('Button'));
check('a tap in the keyboard band is refused', underKeyboard(true, 844, 631));
check('a tap above the band is allowed', !underKeyboard(true, 844, 400));
check('no keyboard, no band', !underKeyboard(false, 844, 631));

// the long spelling of a type name is the same type
check('XCUIElementTypeButton counts as a Button', pickTapTarget([el('XCUIElementTypeStaticText', 'Ok', 1, 1), el('XCUIElementTypeButton', 'Ok', 5, 5)], 'Ok').rect.x === 5);

// --- a fake WDA, behind fetch, for type() and tapText() -----------------------------------------------
const { type, typeKeys, tapText, WdaError, wda, guardKeyboard } = await import('../../ios-device/ios.mjs');
const SECRET = 'S3cr3t-Pw-0123456789abcd';
function fakeWda({ fieldType = 'XCUIElementTypeTextField', focused = true, report = (t) => t, tree = null, noFocus = false } = {}) {
  const f = { log: [], value: '', clears: 0, keys: [], taps: 0 };
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname.replace(/^\/session\/[^/]+/, '');
    const body = init?.body ? JSON.parse(init.body) : {};
    f.log.push(`${init?.method ?? 'GET'} ${path}`);
    const ok = (value) => new Response(JSON.stringify({ value }), { status: 200 });
    if (path === '/element/active') return noFocus ? new Response(JSON.stringify({ value: { error: 'no such element', message: 'none' } }), { status: 404 }) : ok({ ELEMENT: 'E1' });
    if (path === '/element/E1/attribute/type') return ok(fieldType);
    if (path === '/element/E1/clear') {
      f.clears++;
      f.value = '';
      return ok(null);
    }
    if (path === '/element/E1/value') {
      f.value = body.text;
      return ok(null);
    }
    if (path === '/element/E1/attribute/value') return ok(report(f.value));
    if (path === '/wda/keys') {
      f.keys.push(body.value);
      return ok(null);
    }
    if (path === '/source') return ok(tree ?? { type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 }, children: [{ type: 'TextField', isFocused: focused ? '1' : '0', rect: { x: 0, y: 0, width: 1, height: 1 } }] });
    if (path === '/window/size') return ok({ width: 390, height: 844 });
    if (path === '/actions') {
      f.taps++;
      return ok(null);
    }
    return new Response(JSON.stringify({ value: { error: 'unknown command', message: path } }), { status: 404 });
  };
  return f;
}
const out = [];
const origLog = console.log;
const origErr = console.error;
const capture = () => {
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => out.push(a.join(' '));
};
const release = () => {
  console.log = origLog;
  console.error = origErr;
};
const rejects = async (p, re) => {
  try {
    await p;
  } catch (e) {
    return re.test(e.message) ? e : null;
  }
  return null;
};

{
  const f = fakeWda({ fieldType: 'XCUIElementTypeSecureTextField', report: (t) => '•'.repeat([...t].length) });
  capture();
  const r = await type('S', SECRET + '\n', { submit: true });
  release();
  check('type: a secure field read back by length passes, then Return is ONE key event after the read-back', r.secure && r.length === 24 && JSON.stringify(f.keys) === '[["\\n"]]' && f.log.indexOf('GET /element/E1/attribute/value') < f.log.indexOf('POST /wda/keys'));
  check('type: the field is cleared BEFORE the value goes in, in one call', f.log.indexOf('POST /element/E1/clear') < f.log.indexOf('POST /element/E1/value') && f.log.filter((l) => l === 'POST /element/E1/value').length === 1);
  check('type: the secret appears in no output', !out.join('\n').includes(SECRET) && !JSON.stringify(r).includes(SECRET));
}
{
  const f = fakeWda({ fieldType: 'XCUIElementTypeSecureTextField', report: (t) => '•'.repeat([...t].length + 1) });
  out.length = 0;
  capture();
  const e = await rejects(type('S', SECRET, { submit: true }), /typed 24 characters but the secure field reports 25 characters; field cleared; nothing submitted/);
  release();
  check('type: a 25-bullet read-back THROWS, clears, never presses Return', !!e && f.keys.length === 0 && f.clears === 2);
  check('type: NO retry (one value call)', f.log.filter((l) => l === 'POST /element/E1/value').length === 1);
  check('type: the error and the logs never carry the text', !String(e?.message).includes(SECRET) && !out.join('\n').includes(SECRET));
}
{
  fakeWda({ report: (t) => `${t}g` });
  check('type: a plain field with an extra character THROWS', !!(await rejects(type('S', 'canari-test-gamma'), /field reports 18 characters/)));
}
{
  fakeWda({ noFocus: true });
  const e = await rejects(type('S', 'abc'), /no focused element/);
  check('type: nothing focused is a clear refusal, classified on the typed 404', !!e);
  let status = null;
  try {
    await wda('GET', '/session/S/element/active');
  } catch (x) {
    status = x instanceof WdaError ? x.status : 'untyped';
  }
  check('wda errors carry a typed .status', status === 404);
  check('type: a newline inside the text, or a backspace, is refused before WDA is touched', !!(await rejects(type('S', 'a\nb'), /control character/)) && !!(await rejects(type('S', '\b\babc'), /control character/)));
}
{
  const f = fakeWda();
  const r = await typeKeys('S', '123456\n');
  check('typeKeys: raw events, no field touched (the passcode keypad)', r.keys === true && JSON.stringify(f.keys) === '[["1","2","3","4","5","6"]]' && !f.log.some((l) => l.includes('/element/E1')));
}
{
  // tapText(): the tree has a label and the button; the keyboard band decides
  const tree = (y, focused) => ({
    type: 'Application',
    rect: { x: 0, y: 0, width: 390, height: 844 },
    children: [
      { type: 'TextField', isFocused: focused ? '1' : '0', label: 'f', rect: { x: 0, y: 100, width: 300, height: 30 }, isVisible: '1' },
      { type: 'StaticText', label: 'Continuer', rect: { x: 60, y, width: 100, height: 20 }, isVisible: '1' },
      { type: 'Button', label: 'Continuer', rect: { x: 31, y: y - 10, width: 328, height: 48 }, isVisible: '1' },
    ],
  });
  let f = fakeWda({ tree: tree(300, false), noFocus: true });
  capture();
  const hit = await tapText('S', 'Continuer');
  release();
  check('tapText: the Button is tapped, not the label, with no keyboard', hit.type === 'Button' && f.taps === 1);
  f = fakeWda({ tree: tree(600, true) });
  capture();
  const refused = await rejects(tapText('S', 'Continuer'), /refusing to tap "Continuer" at 195,614.*pass --over-keyboard/);
  release();
  check('tapText: under the keyboard it is REFUSED and nothing is tapped', !!refused && f.taps === 0);
  f = fakeWda({ tree: tree(600, true) });
  out.length = 0;
  capture();
  await tapText('S', 'Continuer', { overKeyboard: true });
  release();
  check('tapText: --over-keyboard taps, and says so on stderr each time', f.taps === 1 && out.some((l) => /--over-keyboard/.test(l)));
  f = fakeWda({ tree: tree(300, true) });
  await tapText('S', 'Continuer');
  check('tapText: a focused field with the target ABOVE the band is allowed', f.taps === 1);
  // a foreign-process tap: no request at all (element/active is not consulted), the reason is logged
  f = fakeWda({ tree: tree(600, true) });
  out.length = 0;
  capture();
  await tapText('S', 'Continuer', { noGuard: 'settings-foreign-process' });
  release();
  check('tapText: --no-guard=<reason> never asks element/active, taps, and logs the reason', f.taps === 1 && !f.log.some((l) => l.includes('/element/')) && out.some((l) => /guard skipped \(settings-foreign-process\)/.test(l)));
  fakeWda();
  globalThis.fetch = async () => {
    throw new Error('network down');
  };
  check('the guard fails CLOSED when the tree cannot be read', !!(await rejects(guardKeyboard('S', 10, 700, 'x'), /network down/)));
}

if (failures) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
console.log('ios-device selftest: all passed');
