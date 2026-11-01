/**
 * Pins `focusOf` (phonefocus.mjs): the app in front, the app behind, and the dump that says neither -
 * which must stay its own answer, never folded into a raise or a skip.
 *
 *   bun archive/phonefocus-selftest.mjs
 */
import { PhoneFocusUnknown, focusOf, raiseDecision } from '../phonefocus.mjs';

const CASES = [
  ['the app focused (Mi 9T, 2026-10-26)', '  mCurrentFocus=Window{5c947aa u0 fr.emse.canari/fr.emse.canari.MainActivity}', 'front'],
  ['the launcher focused', '  mCurrentFocus=Window{1a2b3c u0 com.miui.home/com.miui.home.launcher.Launcher}', 'behind'],
  ['a system dialog focused', '  mCurrentFocus=Window{77aa u0 NotificationShade}', 'behind'],
  ['two displays, the app on one', '  mCurrentFocus=Window{1 u0 com.miui.home/.Launcher}\n  mCurrentFocus=Window{2 u0 fr.emse.canari/fr.emse.canari.MainActivity}', 'front'],
  ['focus null (a transition, a keyguard)', '  mCurrentFocus=null', 'unknown'],
  ['no focus line at all', '', 'unknown'],
  ['a format this was not written against', '  mFocusedWindow=fr.emse.canari', 'unknown'],
  ['a package name merely containing ours is not ours', '  mCurrentFocus=Window{9 u0 fr.emse.canari.debug/.Main}', 'behind'],
];

let failed = 0;
for (const [what, dump, want] of CASES) {
  const got = focusOf(dump);
  const ok = got === want;
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}: ${got}${ok ? '' : ` (wanted ${want})`}`);
}

// THE DECISION, BOTH WAYS AND THE THIRD: raise behind, leave in front, refuse "cannot tell".
const DECISIONS = [
  ['in front -> left alone (no am start)', { focus: 'front', dump: 'x' }, 'leave'],
  ['behind -> raised', { focus: 'behind', dump: 'x' }, 'raise'],
  ['cannot tell -> PhoneFocusUnknown, never a raise', { focus: 'unknown', dump: '  mCurrentFocus=null' }, PhoneFocusUnknown],
];
for (const [what, state, want] of DECISIONS) {
  let got;
  try {
    got = raiseDecision(state);
  } catch (err) {
    got = err;
  }
  const ok = typeof want === 'string' ? got === want : got instanceof want;
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}: ${got instanceof Error ? got.name : got}`);
}

const e = new PhoneFocusUnknown('  mCurrentFocus=null');
const named = e instanceof Error && e.name === 'PhoneFocusUnknown' && e.message.includes('mCurrentFocus=null');
if (!named) failed++;
console.log(`  ${named ? 'ok  ' : 'FAIL'} PhoneFocusUnknown is a typed Error that quotes the dump`);

console.log(failed ? `[phonefocus] ${failed} FAILED` : '[phonefocus] clean');
process.exit(failed ? 1 : 0);
