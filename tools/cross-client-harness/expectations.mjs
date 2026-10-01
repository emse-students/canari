/**
 * THE PURE HALF OF A ROW'S VERDICT BOOKKEEPING: naming the expectations and preconditions it did not
 * meet. `results.mjs` re-exports both, so every runner keeps its import; they live here because
 * `results.mjs` imports the gitignored `names.mjs` and so cannot be loaded by a self-test on a fresh
 * checkout.
 */

/**
 * The expectations a check did not meet, named, ready to be pushed into its `failures[]`.
 *
 * A VERDICT IS NOT A REPORT, AND EVERY CHECK HERE DECIDED FAIL BY DISJUNCTION. Only the first term,
 * `failures.length > 0`, ever put anything in `failures[]`, so other terms could fire and record
 * `[FAIL] ... "failures":[]` - a row that knows exactly what went wrong and does not say it. COMM-1
 * did that on 2026-08-27: one of nine terms had fired, and reading the recorded detail term by term
 * was the only way to learn which. That is a diagnosis owed on every future failure of every such
 * row, which is the same debt `backlog` already booked against COMM-9/10 for its unarmed `VACUOUS`.
 *
 * `true` IS THE ONLY PASS. `null` and `undefined` are what a step that never ran returns, and they
 * are unmet for the same reason `false` is - nothing proved the thing - so they are reported with
 * their value rather than collapsed into it, because "never asked" and "asked and refused" are two
 * different findings and the sentence has to keep them apart.
 */
export function unmet(expectations) {
  return Object.entries(expectations)
    .filter(([, v]) => v !== true)
    .map(([name, v]) => `${name}: ${v === undefined ? 'undefined' : JSON.stringify(v)}`);
}

/**
 * Whether a row could ARM, and the named reasons when it could not.
 *
 * AN UNARMED ROW MUST SAY WHY. COMM-9/10 recorded `VACUOUS` with `failures: []` because its arming
 * was a bare `&&` chain: the row knew it could not ask its question and said nothing. Every
 * precondition goes in `arming` by NAME (`true` is the only pass); the unmet ones come back as
 * `could not arm - <name>: <value>` lines for the row's `failures[]`.
 *
 * @param {Record<string, unknown>} arming one named precondition per key
 * @returns {{armed: boolean, failures: string[]}}
 */
export function armingFailures(arming) {
  const missing = unmet(arming);
  return { armed: missing.length === 0, failures: missing.map((f) => `could not arm - ${f}`) };
}
