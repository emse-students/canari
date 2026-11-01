import type { Association } from './api';
import type { PickerOption } from '$lib/components/ui/picker';
import { m } from '$lib/paraglide/messages';

/**
 * The part of an association a kind grouping reads, so a membership row (which carries a kind, a
 * name and a promo but no more) is grouped by the SAME classifier as a catalogue entry.
 */
export interface Groupable {
  name: string;
  type?: Association['type'];
  promo?: number | null;
  archived?: boolean;
}

/** Associations, institutions, lists and archived rows split for grouped rendering in selects. */
export interface GroupedAssociations<T extends Groupable = Association> {
  /** Institutions (the School, a ME, the Alumni...), alphabetical. */
  institutions: T[];
  /** Regular associations, alphabetical. */
  assos: T[];
  /** Promo lists, most recent promo first (nulls last), then by name. */
  lists: T[];
  /** Every ARCHIVED row whatever its kind, alphabetical - kept selectable, drawn last and muted. */
  archived: T[];
}

/** One heading of a grouped association select and the entries under it, in display order. */
export interface AssociationSelectGroup {
  label: string;
  items: Association[];
  /** The archived group: still choosable, drawn in the muted text colour. */
  muted: boolean;
}

const byName = (a: Groupable, b: Groupable) => a.name.localeCompare(b.name, 'fr');

/**
 * Splits a mixed array into the four groups used by every association picker, so the sort order is
 * consistent everywhere.
 *
 * AN INSTITUTION IS NOT AN ASSOCIATION, and it has its own heading: it was filed under
 * "Associations" (the filter was `type !== 'list'`), and in the post composer of a global admin -
 * who is offered the whole catalogue - it sat 30-odd rows down among the clubs, so its member read
 * the composer as not offering it at all (user, 2026-10-14).
 *
 * AN ARCHIVED ROW LEAVES ITS KIND'S GROUP for "Archivées" at the bottom (user, 2026-10-14): still
 * offered - the server accepts a post, an event or a parent naming one - but no longer interleaved
 * with the live ones the member is looking for (16 of prod's 47 associations are archived).
 */
export function groupAssociationsForSelect<T extends Groupable>(
  associations: T[]
): GroupedAssociations<T> {
  const live = associations.filter((a) => !a.archived);
  const institutions = live.filter((a) => a.type === 'institution').sort(byName);
  const assos = live.filter((a) => a.type !== 'list' && a.type !== 'institution').sort(byName);
  const lists = live
    .filter((a) => a.type === 'list')
    .sort((a, b) => (b.promo ?? -Infinity) - (a.promo ?? -Infinity) || byName(a, b));
  const archived = associations.filter((a) => a.archived).sort(byName);
  return { institutions, assos, lists, archived };
}

/**
 * The four groups under their headings, in the ONE display order every picker uses: institutions
 * first (few, and the ones a member is least likely to find by scrolling), then associations, then
 * lists, then the archived rows of every kind, muted. An empty group is dropped, so a select never
 * shows a heading over nothing.
 */
export function associationSelectGroups(associations: Association[]): AssociationSelectGroup[] {
  const { institutions, assos, lists, archived } = groupAssociationsForSelect(associations);
  return [
    { label: m.asso_select_group_institutions(), items: institutions, muted: false },
    { label: m.asso_select_group_assos(), items: assos, muted: false },
    { label: m.asso_select_group_lists(), items: lists, muted: false },
    { label: m.asso_select_group_archived(), items: archived, muted: true },
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
      ...(g.muted ? { muted: true } : {}),
    }))
  );
}
