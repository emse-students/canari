/**
 * THE VERDICT VOCABULARY, IN ONE PLACE, BECAUSE TWO COPIES DRIFTED TWICE.
 *
 * `results.mjs` is where a verdict comes into existence and `rows.mjs` reads those words back off
 * the board. Until now each carried its own idea of the vocabulary: the recorder accepted any
 * string a runner handed it, and the reader held a private map of the words it knew. A runner
 * inventing a word therefore made the RECONCILER wrong about the board - the one report whose whole
 * job is to be right about it.
 *
 * IT HAPPENED TWICE, AND THE SECOND TIME THE WARNING WAS ALREADY WRITTEN ABOVE THE BUG.
 * `INCONCLUSIVE` was missing from the reader, so PIN-11 - the first row ever to record one - read
 * `unstated` and was reported as work the board had not written down, which it had. A comment went
 * in at that spot saying exactly why this must not recur. On 2026-09-06 `SETUP-FAILED` - which
 * `heal-w2.mjs` had recorded since the day it was written - did the same thing to HEAL-W2, under
 * that comment. **A comment is not a mechanism.**
 *
 * SO THE LIST IS OWNED, NOT SHARED. Both sides import it from here, which makes a new verdict
 * readable by both or by neither: the failure becomes a missing entry in ONE file, found at the
 * throw in `record()` the first time a runner records the new word, rather than a silent
 * misreading discovered weeks later on the board.
 *
 * WHY THIS IS NOT SIMPLY AN EXPORT OF `results.mjs`, WHICH IS WHERE IT BELONGS BY OWNERSHIP.
 * `results.mjs` imports `names.mjs`, which is gitignored on purpose - it holds real display names
 * and this repository is PUBLIC - so nothing that must run on a fresh checkout may import it, and
 * `gate-selftest.mjs` enforces exactly that. The self-test that pins this vocabulary is one of
 * those things. A module with NO imports is the only shape both sides and the gate can reach, so
 * the list lives here and `results.mjs` re-exports it: a runner still reads the recorder as the
 * owner, and CI can still open the list.
 */

/**
 * EVERY WORD A CHECK MAY BE RECORDED UNDER. Anything else is a runner bug, refused at `record()`.
 *
 * - `PASS` - the assertions held AND the run was clean. The only verdict that exits 0, and the only
 *   one that CLAIMS anything about the run, which is why it is the only one `record()` demotes.
 * - `PASS-DIRTY` - the assertions held and the observation was not clean. Never the bar (user).
 * - `PARTIAL` - the effect landed on some of the population and not all of it. `HEAL-repair` and
 *   `HEAL-A1` are its only producers: a count between zero and the whole.
 * - `FAIL` - an assertion did not hold. Work owed against the PRODUCT.
 * - `ERROR` - the check threw before it could decide anything. Work owed, side not yet known; the
 *   detail carries `errorDetail()`'s frame so the next reader knows where.
 * - `INVALID` - the check ran and its own premise made the measurement meaningless. TYPE-4 records
 *   one when the peer never goes offline at the gateway: the app was never asked the question, so
 *   calling it `FAIL` would accuse the product of a rig condition.
 * - `VACUOUS` - the assertions passed over an empty population, so nothing was proved. A device
 *   that could not be armed has not disagreed with anything.
 * - `INCONCLUSIVE` - the question could not be ASKED, and a run that failed to reproduce itself is
 *   this and never `PASS`.
 * - `SKIPPED` - deliberately not run, with the reason in the detail.
 * - `SETUP-FAILED` - the rig could not build the premise, so the app was never reached. Distinct
 *   from `INVALID` in where the fault is: there the estate answered wrong, here the rig never got
 *   the question out.
 * - `UNOBSERVED` - WRITTEN BY `record()` ALONE, never by a runner: a `PASS` carrying no gated
 *   report. Distinct from `PASS-DIRTY` on purpose - "nobody looked" and "someone looked and it was
 *   dirty" send their reader to different places.
 */
export const VERDICTS = Object.freeze([
  'PASS',
  'PASS-DIRTY',
  'PARTIAL',
  'FAIL',
  'ERROR',
  'INVALID',
  'VACUOUS',
  'INCONCLUSIVE',
  'SKIPPED',
  'SETUP-FAILED',
  'UNOBSERVED',
]);

/**
 * THE VERDICT A RUNNER MAY NOT WRITE ITSELF - `record()` is its sole author.
 *
 * Kept beside the list rather than inside `results.mjs` so the self-test can assert the rule from a
 * module CI can open, and so the one asymmetry in the vocabulary is visible where the vocabulary is.
 */
export const RECORDER_ONLY = Object.freeze(['UNOBSERVED']);

/**
 * THE BOARD SPEAKS TWO VOCABULARIES AND BOTH ARE CURRENT, so the reader needs the older spellings.
 *
 * Rows written before the ledger existed say `passed` / `failed` / `skipped` / `partial`; every row
 * a runner has answered since carries the recorded word itself. Knowing only the older set reported
 * sixty-seven disagreements on a day five phases were green, which is the shape of an instrument
 * fault rather than a finding.
 *
 * These are ALIASES ONTO `VERDICTS` and nothing else: a word here that names no verdict is a typo
 * the self-test refuses, which is what stops this map from becoming the second vocabulary again.
 */
export const BOARD_ALIASES = Object.freeze({
  passed: 'PASS',
  failed: 'FAIL',
  skipped: 'SKIPPED',
  partial: 'PARTIAL',
});

/**
 * `pending` IS NOT A VERDICT AND MUST NOT BECOME ONE. It is the ABSENCE of a claim - what the board
 * writes in a cell nobody has answered - which is why it maps to itself and is never compared
 * against a recorded word.
 */
export const NOT_A_CLAIM = 'pending';

/**
 * The board's word -> the ledger's word, for every spelling a cell may legally carry.
 *
 * Derived rather than written out: the whole defect this file exists for was a hand-kept map that
 * agreed with the recorder right up to the moment a runner added a word.
 */
export const CLAIM = Object.freeze({
  ...Object.fromEntries(VERDICTS.map((v) => [v, v])),
  ...BOARD_ALIASES,
  [NOT_A_CLAIM]: NOT_A_CLAIM,
});

/** @returns {boolean} whether `word` is a verdict a check may be recorded under. */
export function isVerdict(word) {
  return VERDICTS.includes(word);
}
