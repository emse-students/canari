/**
 * THE DIRECTORY'S FILTER MODEL: one value for what the reader asked, the request it becomes, and the
 * chips that say it back.
 *
 * Kept out of the page so the three questions a screen keeps asking - "is there anything to search
 * for", "what do I send", "what do I show as active" - have ONE answer each, tested without a DOM.
 * The server refuses a request with no criterion (`USER_SEARCH_FILTER_REQUIRED`, a name needs two
 * characters), so {@link hasCriteria} is the same rule read on the client: a request the server is
 * certain to refuse is never made to learn that (docs/wiki/profiles-and-access.md, D18).
 */
import type { Campus, Post } from '$lib/profile/miconnectProfile';
import { campusLabel, postLabel } from '$lib/profile/miconnectProfile';
import { m } from '$lib/paraglide/messages';

/** What the reader typed and picked. Empty strings mean "no criterion". */
export interface DirectoryFilters {
  query: string;
  /** The raw promo field: a number, or `''`/`null` when empty (a number input yields `null` when cleared). */
  promo: number | string | null;
  formation: string;
  associationId: string;
  campus: Campus | '';
  post: Post | '';
}

/** The filters of an untouched screen. */
export function emptyFilters(): DirectoryFilters {
  return { query: '', promo: '', formation: '', associationId: '', campus: '', post: '' };
}

/** The shortest name the server searches (`UsersService.directory`). */
export const MIN_NAME_LENGTH = 2;

/** The promo as a number, or `undefined` when the field is empty or not a number. */
export function promoOf(filters: DirectoryFilters): number | undefined {
  if (filters.promo === '' || filters.promo == null) return undefined;
  const n = Number(filters.promo);
  return Number.isFinite(n) ? n : undefined;
}

/** True when the server would answer: a name of two characters, or any one filter. */
export function hasCriteria(filters: DirectoryFilters): boolean {
  return (
    filters.query.trim().length >= MIN_NAME_LENGTH ||
    promoOf(filters) !== undefined ||
    filters.formation.trim().length > 0 ||
    filters.associationId !== '' ||
    filters.campus !== '' ||
    filters.post !== ''
  );
}

/** The filters without the name: what the sheet edits, and what the chips count. */
export type FilterKey = 'promo' | 'formation' | 'associationId' | 'campus' | 'post';

/** One active filter, as a removable chip. */
export interface FilterChip {
  key: FilterKey;
  label: string;
}

/** The active filters (never the name) as chips, in the order the sheet lists them. */
export function activeChips(
  filters: DirectoryFilters,
  associationName: (id: string) => string | null
): FilterChip[] {
  const chips: FilterChip[] = [];
  const promo = promoOf(filters);
  if (promo !== undefined)
    chips.push({ key: 'promo', label: m.directory_user_promo({ year: promo }) });
  if (filters.formation.trim()) chips.push({ key: 'formation', label: filters.formation.trim() });
  if (filters.associationId) {
    chips.push({
      key: 'associationId',
      label: associationName(filters.associationId) ?? m.directory_label_association(),
    });
  }
  if (filters.campus) chips.push({ key: 'campus', label: campusLabel(filters.campus) });
  if (filters.post) chips.push({ key: 'post', label: postLabel(filters.post) });
  return chips;
}

/** `filters` with one criterion cleared. */
export function withoutFilter(filters: DirectoryFilters, key: FilterKey): DirectoryFilters {
  return { ...filters, [key]: emptyFilters()[key] };
}
