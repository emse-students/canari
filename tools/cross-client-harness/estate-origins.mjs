/**
 * WHICH ESTATE A RUNNING CLIENT IS ACTUALLY TALKING TO, as a pure function of what it fetched.
 *
 * ## Why this is not inside `pin.mjs`
 *
 * It was, and that is a shape this rig has a rule about: a predicate whose only home is a CLI entry
 * point is tested by nothing, because a self-test cannot import the module without running the
 * command. `pin.mjs`'s own docstring claimed it had been *"exercised on five origin sets"* - true,
 * once, by hand, on the day it was written. Nothing re-asked. The defect below then shipped inside
 * it and was found by a phase failing, which is the expensive way.
 *
 * It has NO imports on purpose. `gate-selftest.mjs` asserts that every gated self-test's whole
 * import chain is tracked in git, and the harness's `names.mjs` is a pointer to an out-of-tree file
 * holding credentials - so a predicate that reaches it, however indirectly, cannot be gated at all.
 * The estate to compare against is a PARAMETER for the same reason.
 *
 * ## What is excused, and why each one is not an estate
 *
 * - **`http://tauri.localhost` and `http://ipc.localhost`** are the engine's own schemes. Every
 *   Tauri client calls them and no deployment can move them.
 * - **`'null'`** is what `new URL(name).origin` answers for a `data:` or `blob:` resource: an
 *   OPAQUE origin, which has no host and therefore no estate to be wrong about. This is the defect
 *   that paid for this file. Measured on W1, 2026-09-05: the guard compared the string `'null'`
 *   against `SITE`, found it different, and refused with the loudest sentence it has - *"THIS
 *   CLIENT IS NOT ON THE LOCAL ESTATE: it called null"*, telling the reader to rebuild an APK. The
 *   offender was the application's own noise texture, a `data:image/svg+xml` in its CSS, present on
 *   every page. And it was INTERMITTENT, which is worse than always wrong: the resource timeline
 *   holds 250 entries by default and a navigation clears it, so whether the texture was still in it
 *   depended on how long the tab had been up.
 *
 * An `unparseable:` name is NOT excused. "This resource has no host" and "this resource's name
 * could not be read" are different facts, and only the first is harmless.
 *
 * ## Why "every estate origin is SITE" and not "SITE is among them"
 *
 * A client calling the local estate AND production is not on the local estate; it is on both, and a
 * verdict taken there says nothing. The stray is the case the weaker test would pass.
 */

/** Origins that are not an estate: the engine's own two schemes, and the opaque origin. */
export const NOT_AN_ESTATE = ['http://tauri.localhost', 'http://ipc.localhost', 'null'];

/**
 * The estate origins among `contacted`, in input order and without duplicates.
 *
 * @param {string[]} contacted every origin the client has fetched from
 * @returns {string[]} those that name an estate
 */
export function estateOriginsAmong(contacted) {
  return [...new Set(contacted)].filter((o) => !NOT_AN_ESTATE.includes(o));
}

/**
 * Whether a client that contacted `contacted` is on `site`, and why not when it is not.
 *
 * AN EMPTY SET IS A REFUSAL, not a pass. "Contacted nothing" is not "contacted the right thing",
 * and a gate over an empty set is the vacuous pass this rig refuses everywhere else. The caller is
 * expected to have WAITED before asking - a cold-started client may legitimately not have reached
 * the API yet - so by the time this is asked, silence means the estate cannot be established.
 *
 * @param {string[]} contacted every origin the client has fetched from
 * @param {string} site the estate the rig reports on
 * @returns {{ ok: boolean, estates: string[], strangers: string[], reason: 'ok'|'silent'|'strangers' }}
 */
export function estateVerdict(contacted, site) {
  const estates = estateOriginsAmong(contacted);
  const strangers = estates.filter((o) => o !== site);
  if (!estates.length) return { ok: false, estates, strangers, reason: 'silent' };
  if (strangers.length) return { ok: false, estates, strangers, reason: 'strangers' };
  return { ok: true, estates, strangers, reason: 'ok' };
}
