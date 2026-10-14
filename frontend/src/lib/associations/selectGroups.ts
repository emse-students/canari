import type { Association } from './api';
import type { PickerOption } from '$lib/components/ui/picker';
import { m } from '$lib/paraglide/messages';

/** Associations, institutions and lists split for grouped rendering in selects. */
export interface GroupedAssociations {
  /** Institutions (the School, a ME, the Alumni...), alphabetical. */
  institutions: Association[];
  /** Regular associations, alphabetical. */
  assos: Association[];
  /** Promo lists, most recent promo first (nulls last), then by name. */
  lists: Association[];
}

/** One heading of a grouped association select and the entries under it, in display order. */
export interface AssociationSelectGroup {
  label: string;
  items: Association[];
}

const byName = (a: Association, b: Association) => a.name.localeCompare(b.name, 'fr');

/**
 * Splits a mixed array into the three kinds used by every association picker, so the sort order is
 * consistent everywhere.
 *
 * AN INSTITUTION IS NOT AN ASSOCIATION, and it has its own heading: it was filed under
 * "Associations" (the filter was `type !== 'list'`), and in the post composer of a global admin -
 * who is offered the whole catalogue - it sat 30-odd rows down among the clubs, so its member read
 * the composer as not offering it at all (user, 2026-10-14).
 */
export function groupAssociationsForSelect(associations: Association[]): GroupedAssociations {
  const institutions = associations.filter((a) => a.type === 'institution').sort(byName);
  const assos = associations
    .filter((a) => a.type !== 'list' && a.type !== 'institution')
    .sort(byName);
  const lists = associations
    .filter((a) => a.type === 'list')
    .sort((a, b) => (b.promo ?? -Infinity) - (a.promo ?? -Infinity) || byName(a, b));
  return { institutions, assos, lists };
}

/**
 * The three groups under their headings, in the ONE display order every picker uses: institutions
 * first (few, and the ones a member is least likely to find by scrolling), then associations, then
 * lists. An empty group is dropped, so a select never shows a heading over nothing.
 */
export function associationSelectGroups(associations: Association[]): AssociationSelectGroup[] {
  const { institutions, assos, lists } = groupAssociationsForSelect(associations);
  return [
    { label: m.asso_select_group_institutions(), items: institutions },
    { label: m.asso_select_group_assos(), items: assos },
    { label: m.asso_select_group_lists(), items: lists },
  ].filter((g) => g.items.length > 0);
}

/** Display label for a list option, appending the promo year when present. */
export function listOptionLabel(list: Association): string {
  return list.promo ? `${list.name} (${list.promo})` : list.name;
}

/**
 * The groups as options for the in-app `Picker` - so every picker offering associations reads in
 * the same order under the same headings.
 */
export function associationPickerOptions(associations: Association[]): PickerOption[] {
  return associationSelectGroups(associations).flatMap((g) =>
    g.items.map((a) => ({
      value: a.id,
      label: a.type === 'list' ? listOptionLabel(a) : a.name,
      group: g.label,
    }))
  );
}
