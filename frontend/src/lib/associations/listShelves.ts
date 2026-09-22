import type { Association } from '$lib/associations/api';

/** A run of lists that share a parent association, inside one campaign year. */
export interface ParentGroup {
  /**
   * The parent association's display name, or `null` for the lists that have none.
   *
   * `null` is not "unknown": `parentAssociationId` is optional, and a list that belongs to no
   * association is an ordinary case rather than missing data. It renders with no sub-heading, so a
   * year whose lists all lack a parent looks exactly as it did before parents existed.
   */
  parentName: string | null;
  items: Association[];
}

/** One campaign year, and the parent associations that ran lists in it. */
export interface CampaignShelf {
  /** The campaign year, or `0` for the lists carrying no `promo` at all. */
  year: number;
  groups: ParentGroup[];
}

/**
 * Groups active lists into campaign-year shelves, and each shelf by parent association.
 *
 * TWO LEVELS, YEAR OUTSIDE (user, 2026-09-22). The year was already the shelf heading, which is
 * why the per-card "Liste 2026" pill was removed as a duplicate of it; the parent is the division
 * INSIDE a year, because a campaign is a thing that happens in a year and an association is a
 * thing that runs several of them.
 *
 * Ordering is total and carries no ties, so the page cannot render two different ways for the same
 * data: years descend, `0` lands last because it is smaller than any real year; parents sort by
 * name and the parentless group lands last; lists sort by name inside a group. `localeCompare` is
 * used throughout - these are proper nouns with accents, and a codepoint sort puts "Elan" after
 * "Zenith".
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
    .map(([year, items]) => ({ year, groups: groupByParent(items) }))
    .sort((a, b) => b.year - a.year);
}

/** The parent division inside ONE shelf; exported for the test, which asserts the two orderings apart. */
export function groupByParent(items: Association[]): ParentGroup[] {
  const byParent = new Map<string, Association[]>();
  for (const list of items) {
    // A blank `parentName` is the same answer as none: the read side denormalises it from the
    // parent row, so an empty string means the parent could not be resolved, not that it is named
    // "". Both belong in the trailing group.
    const key = list.parentName?.trim() ?? '';
    const bucket = byParent.get(key);
    if (bucket) bucket.push(list);
    else byParent.set(key, [list]);
  }

  return [...byParent.entries()]
    .map(([parentName, group]) => ({
      parentName: parentName || null,
      items: [...group].sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => {
      if (a.parentName === null) return 1;
      if (b.parentName === null) return -1;
      return a.parentName.localeCompare(b.parentName);
    });
}
