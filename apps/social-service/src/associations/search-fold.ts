/**
 * AN ACCENT-INSENSITIVE, CASE-INSENSITIVE FOLD IN SQL, so "ecole" finds "Ecole" spelt with its
 * acute accent in the admin catalogue. Built on `translate`, not `unaccent`: no social-service migration installs that
 * extension (only core-service creates it at boot, on its own schema), and a search must not depend
 * on what another service happened to install.
 *
 * The letters are listed in BOTH cases and folded BEFORE `lower()`, because `lower()` on a non-ASCII
 * letter depends on the database's collation provider, while `translate` does not. The table holds
 * the Latin letters French and its neighbours write; a ligature (oe, ae) would need two letters and
 * `translate` maps one to one, so those stay as typed. Spelt by escape: code keeps accented letters
 * out of its source.
 */
const FOLD_FROM =
  '\u00e0\u00e2\u00e4\u00e1\u00e3\u00e5\u00e7\u00e9\u00e8\u00ea\u00eb\u00ed\u00ec\u00ee\u00ef\u00f1' +
  '\u00f3\u00f2\u00f4\u00f6\u00f5\u00fa\u00f9\u00fb\u00fc\u00fd\u00ff' +
  '\u00c0\u00c2\u00c4\u00c1\u00c3\u00c5\u00c7\u00c9\u00c8\u00ca\u00cb\u00cd\u00cc\u00ce\u00cf\u00d1' +
  '\u00d3\u00d2\u00d4\u00d6\u00d5\u00da\u00d9\u00db\u00dc\u00dd\u0178';
const FOLD_TO = 'aaaaaaceeeeiiiinooooouuuuyy' + 'AAAAAACEEEEIIIINOOOOOUUUUYY';

/** The two `translate` tables, passed as parameters so no letter of them is spliced into SQL. */
export const SEARCH_FOLD_PARAMS = { foldFrom: FOLD_FROM, foldTo: FOLD_TO } as const;

/** `lower(translate(expr, :foldFrom, :foldTo))`: the fold of a column or a parameter. */
export function foldSql(expr: string): string {
  return `lower(translate(${expr}, :foldFrom, :foldTo))`;
}
