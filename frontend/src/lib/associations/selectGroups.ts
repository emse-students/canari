import type { Association } from './api';

/** Associations and lists split for grouped `<optgroup>` rendering in selects. */
export interface GroupedAssociations {
  /** Regular associations, alphabetical. */
  assos: Association[];
  /** Promo lists, most recent promo first (nulls last), then by name. */
  lists: Association[];
}

/**
 * Splits a mixed association/list array into the two groups used by every
 * association picker, so the sort order is consistent everywhere.
 */
export function groupAssociationsForSelect(associations: Association[]): GroupedAssociations {
  const assos = associations
    .filter((a) => a.type !== 'list')
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const lists = associations
    .filter((a) => a.type === 'list')
    .sort(
      (a, b) =>
        (b.promo ?? -Infinity) - (a.promo ?? -Infinity) || a.name.localeCompare(b.name, 'fr')
    );
  return { assos, lists };
}

/** Display label for a list option, appending the promo year when present. */
export function listOptionLabel(list: Association): string {
  return list.promo ? `${list.name} (${list.promo})` : list.name;
}
