/**
 * TWO PEOPLE OF THE SAME NAME ARE TOLD APART IN EVERY PERSON PICKER (D56, profiles-and-access.md):
 * the user search answers each row's earliest promo and formation, and this ONE function decides
 * which rows need one of them beside the name, so the New-discussion picker, the member pickers and
 * the mention list never show two identical rows. Charter principle 7 (simplicity): nothing is
 * added to a row whose name nobody else on screen shares.
 */
import { m } from '$lib/paraglide/messages';
import { foldForSearch } from '$lib/utils/textFold';

/** What a picker row needs for this: the search answer's shape, promo and formation optional. */
export interface HomonymCandidate {
  id: string;
  displayName: string | null;
  promo?: number | null;
  formation?: string | null;
}

/**
 * A name as two rows are compared: accents and case folded, hyphens, dots, apostrophes and spaces
 * to one space - the server's `normalizeName` rule, so "Jean-Marie DUPONT" and "Jean Marie Dupont"
 * are one name here too.
 */
function foldedName(name: string): string {
  return foldForSearch(name)
    .replace(/[\s\-'.’]+/g, ' ')
    .trim();
}

const formationKey = (f: string | null | undefined) => (f ? f.trim().toLowerCase() : '');

/**
 * The detail to show beside each row that shares its folded name with another shown row, keyed by
 * id: its promo when no homonym has the same, else its formation when that tells it apart among the
 * homonyms of its promo. A row nothing tells apart keeps what it has (its promo, else its formation)
 * and the pair is logged at warning - never silently shown bare - with no name in the line.
 */
export function distinguishHomonyms(rows: readonly HomonymCandidate[]): Map<string, string> {
  const details = new Map<string, string>();
  const groups = new Map<string, HomonymCandidate[]>();
  for (const row of rows) {
    const key = row.displayName ? foldedName(row.displayName) : '';
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  let undistinguished = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const row of group) {
      const others = group.filter((o) => o !== row);
      const promo = row.promo ?? null;
      const samePromo = others.filter((o) => (o.promo ?? null) === promo);
      const promoLabel = promo !== null ? m.picker_homonym_detail({ promo }) : null;
      if (promoLabel && samePromo.length === 0) {
        details.set(row.id, promoLabel);
        continue;
      }
      const formation = formationKey(row.formation);
      if (formation && !samePromo.some((o) => formationKey(o.formation) === formation)) {
        details.set(row.id, row.formation!.trim());
        continue;
      }
      undistinguished += 1;
      const fallback = promoLabel ?? (row.formation?.trim() || null);
      if (fallback) details.set(row.id, fallback);
    }
  }
  if (undistinguished > 0) {
    console.warn(
      `[PICKER] homonyms with nothing to tell apart: ${undistinguished} row(s) share a name, a promo and a formation`
    );
  }
  return details;
}
