/**
 * WHICH WINDOW HAS THE PHONE'S FOCUS, READ FROM `dumpsys window` - and "cannot tell" as an answer.
 *
 * Pure, so `archive/phonefocus-selftest.mjs` can pin it without a phone or the operator-local
 * `names.mjs` that `phone.mjs` imports.
 *
 * **THREE ANSWERS, NOT TWO** (2026-10-26). `phone.mjs` `ensure()` raises the app with `am start` only
 * when it is not already in front, because on the Mi 9T that raise is a whole pause and resume, not
 * a no-op. A boolean read would have to fold "the dump did not say" into one of its two values, and
 * either fold is wrong: into "behind" it is the old unconditional raise, a fallback that perturbs the
 * row in silence; into "front" it skips a raise a backgrounded app needed. So "cannot tell" is its
 * own answer, and the caller throws `PhoneFocusUnknown` rather than guessing - the row stops and says
 * why.
 */

/** The app's package, as `mCurrentFocus` names it. */
const PACKAGE = 'fr.emse.canari';

/**
 * Thrown when the focus dump does not name a window: the row is not judged and the message says what
 * the dump held, never a raise taken on a guess.
 */
export class PhoneFocusUnknown extends Error {
  /** @param {string} dump the `mCurrentFocus` output that could not be read */
  constructor(dump) {
    super(`the phone's focused window cannot be read from dumpsys (${JSON.stringify(String(dump ?? '').trim().slice(0, 160))}) - the app is neither raised nor assumed in front`);
    this.name = 'PhoneFocusUnknown';
    this.dump = dump;
  }
}

/**
 * What `ensure()` does with a focus read: `raise` an app behind, `leave` one in front, and THROW
 * `PhoneFocusUnknown` when the read could not tell - never a raise on a guess.
 *
 * @param {{focus: 'front' | 'behind' | 'unknown', dump: string}} state
 * @returns {'raise' | 'leave'}
 */
export function raiseDecision(state) {
  if (state.focus === 'front') return 'leave';
  if (state.focus === 'behind') return 'raise';
  throw new PhoneFocusUnknown(state.dump);
}

/**
 * The focus answer for a `dumpsys window | grep mCurrentFocus` output.
 *
 * `front` when a focus line names the app; `behind` when focus lines name only other windows;
 * `unknown` when there is no focus line or every one is `null` (a transition, a keyguard, a format
 * this was not written against).
 *
 * @param {string} dump
 * @returns {'front' | 'behind' | 'unknown'}
 */
export function focusOf(dump) {
  const lines = String(dump ?? '')
    .split(/\r?\n/)
    .map((l) => /mCurrentFocus=(.*)$/.exec(l.trim())?.[1]?.trim())
    .filter((v) => v !== undefined);
  const named = lines.filter((v) => v && v !== 'null' && v.startsWith('Window{'));
  if (named.some((v) => v.includes(`${PACKAGE}/`))) return 'front';
  if (named.length) return 'behind';
  return 'unknown';
}
