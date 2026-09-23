import type { Association } from '$lib/associations/api';

/** One campaign year, and the lists that ran in it. */
export interface CampaignShelf {
  /** The campaign year, or `0` for the lists carrying no `promo` at all. */
  year: number;
  items: Association[];
}

/**
 * Groups active lists into campaign-year shelves, ordered inside each shelf by parent association.
 *
 * ORDERING, NOT GROUPING (user, 2026-09-23: *"c'etait plus les organiser en les ordonnant, pas en
 * les regroupant"*). The parent was a second grouping level for one day, each parent opening its
 * OWN grid: with two lists per association that is a full grid row spent on two cards and the rest
 * of the width left blank, which is what the user saw. A sort says the same thing for free - the
 * lists of one association land next to each other, and the wall keeps filling its columns.
 *
 * NOTHING IS LOST BY DROPPING THE SUB-HEADING, which is the part worth writing down: every card
 * already prints its `parentName` above its title (`AssociationTile`), so the heading repeated on
 * a separator line what each card under it was saying anyway - the same duplication that removed
 * the per-card "Liste 2026" pill under the year heading.
 *
 * Ordering is total and carries no ties, so the page cannot render two different ways for the same
 * data: years descend, `0` lands last because it is smaller than any real year; inside a year the
 * key is the parent's name then the list's own, and the parentless lists land last. A blank
 * `parentName` is read as NO parent: the read side denormalises it from the parent row, so an
 * empty string means the parent could not be resolved rather than an association called "".
 * `localeCompare` is used throughout - these are proper nouns with accents, and a codepoint sort
 * puts "Elan" after "Zenith".
 */
export function buildCampaignShelves(activeLists: Association[]): CampaignShelf[] {
  const byYear = new Map<number, Association[]>();
  for (const list of activeLists) {
    const year = list.promo ?? 0;
    const bucket = byYear.get(year);
    if (bucket) bucket.push(list);
    else byYear.set(year, [list]);
  }

  return [...byYear.entries()]
    .map(([year, items]) => ({ year, items: sortByParentThenName(items) }))
    .sort((a, b) => b.year - a.year);
}

/** The order WITHIN one shelf; exported for the test, which asserts the two orderings apart. */
export function sortByParentThenName(items: Association[]): Association[] {
  return [...items].sort((a, b) => {
    const parentA = a.parentName?.trim() ?? '';
    const parentB = b.parentName?.trim() ?? '';
    if (parentA !== parentB) {
      if (!parentA) return 1;
      if (!parentB) return -1;
      return parentA.localeCompare(parentB);
    }
    return a.name.localeCompare(b.name);
  });
}
