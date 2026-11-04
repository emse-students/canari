/**
 * `tools/ios-device/ios.mjs`'s decisions, pinned with no phone: what `type` sends and compares, what
 * `tap <text>` is allowed to tap, and when a tap is refused because the keyboard is over it.
 *
 * Measured 2026-11-04 on the iPhone 12: a tap on "Se connecter" at y 631 landed on the `g` key of the
 * keyboard covering it (the tree still listed the button), which is how `canari-test-gamma` became
 * `canari-test-gammag` and a 24-character password showed 25 bullets.
 */
import { keyboardUp, pickTapTarget, readbackMatches, typedText, underKeyboard } from '../../ios-device/ios.mjs';

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
const tree = (focused) => ({ type: 'Application', children: [{ type: 'Other', children: [{ type: 'TextField', isFocused: focused ? '1' : '0' }] }] });
check('a focused text field means the keyboard is up', keyboardUp(tree(true)));
check('no focused field, no keyboard', !keyboardUp(tree(false)));
check('a tap in the keyboard band is refused', underKeyboard(true, 844, 631));
check('a tap above the band is allowed', !underKeyboard(true, 844, 400));
check('no keyboard, no band', !underKeyboard(false, 844, 631));

if (failures) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
console.log('ios-device selftest: all passed');
