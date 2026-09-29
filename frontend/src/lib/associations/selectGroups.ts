import type { Association } from './api';
import type { PickerOption } from '$lib/components/ui/picker';
import { m } from '$lib/paraglide/messages';

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

/**
 * The two groups as options for the in-app `Picker` - so every picker offering associations reads
 * in the same order under the same headings.
 */
export function associationPickerOptions(associations: Association[]): PickerOption[] {
  const { assos, lists } = groupAssociationsForSelect(associations);
  return [
    ...assos.map((a) => ({ value: a.id, label: a.name, group: m.asso_select_group_assos() })),
    ...lists.map((a) => ({
      value: a.id,
      label: listOptionLabel(a),
      group: m.asso_select_group_lists(),
    })),
  ];
}
