/**
 * READING A SCRIPT AS CODE RATHER THAN AS TEXT.
 *
 * Several gates in this rig decide something by looking for a pattern in a runner's source - which
 * door it opens, which origin it names - and every one of them was matching PROSE as well. This
 * repository documents at length the defects it has survived, so its comments are full of the exact
 * strings its gates forbid, and a gate that cannot tell the two apart either fires on an
 * explanation or forbids writing one.
 *
 * It cost a build within the hour it was noticed: a comment added to `grp.mjs` explaining that
 * `publicAppOrigin()` refuses `tauri.localhost` made `checks-selftest.mjs` declare that GRP drives
 * the PHONE, because `tauri.localhost` is one of the strings it looks for. The sentence was correct
 * and the gate was correct; only the reading was wrong.
 *
 * Pure and dependency-free, so a self-test may import it: `gate-selftest.mjs` requires every gated
 * self-test to import only files that are in git, and this one is.
 */

/**
 * The same source with comments blanked out, LINE COUNT AND OFFSETS PRESERVED.
 *
 * Every comment character becomes a space rather than being deleted, so a match's index still maps
 * to the line it came from and a report can name it. Block comments keep their newlines for the
 * same reason.
 *
 * STRING LITERALS ARE LEFT ALONE, deliberately. A spelt origin or a spelt port inside a string is
 * exactly what these gates exist to refuse - it is the form every one of the defects took - so
 * blanking strings would blind them to their whole subject.
 *
 * @param {string} src - the file's text
 * @returns {string} the same text with `/* *\/` and `//` comments replaced by spaces
 */
export function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, lead) => lead + ' '.repeat(m.length - lead.length));
}
