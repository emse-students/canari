/**
 * ONE ASSOCIATION IS ONE COLOUR, AND BEFORE THIS IT WAS TWO.
 *
 * `Association.color` with a `generateAvatarColor` fallback was derived at **thirteen** sites, and
 * they were not thirteen copies of one decision - they were two decisions **seeded differently**:
 *
 * | Family | Seed | Where |
 * | --- | --- | --- |
 * | card accent | `name` | `AssociationDetailView`, `AssociationTile`, `EditBoutiqueTab`, `EditPartnershipsTab`, `routes/shop` (x2) |
 * | calendar accent | `id` | `feedEvents`, `MonthCalendarGridRich` (x2), `calendarExport` (x2), `routes/admin/agenda` |
 * | a third spelling | `id`, `?.trim() \|\|` rather than `??` | `carte/generator` |
 *
 * So an association that has not chosen a colour was **one hue on its card and a different hue in
 * the calendar**, which reads as two clubs. The count is only how it hid: nobody compares thirteen
 * expressions, and each one is obviously right where it stands.
 *
 * **AND THE COUNT ITSELF HID.** The first sweep said eleven, converting them said twelve, and the
 * true number is thirteen - because two of the sites are CO-OWNER maps (`MonthCalendarGridRich`,
 * `calendarExport`) that derive the same accent a second time, one line below the primary, inside
 * the same function. A sweep counting LINES that mention the fallback finds them; a sweep counting
 * FILES does not.
 *
 * **THE SEED IS THE ID, AND IT IS NOT A COIN TOSS.** An id does not change when a club renames
 * itself; a name does, so the `name` family gave an association a new colour on the day it changed
 * its title - silently, and only on half the screens. The id was also already the majority: the
 * calendar's six and the carte against the cards' six.
 *
 * **`?.trim() ||` and not `??`**, which was the third spelling and is the correct one: `??` keeps an
 * EMPTY STRING as a colour, and `style="background: "` is not a fallback, it is a missing accent.
 */
import { generateAvatarColor } from '$lib/utils/avatar';
import { toHex } from '$lib/utils/color';

/**
 * Anything that can name an association and may carry its chosen colour.
 *
 * Structural rather than the `Association` type, because the five shapes that need an accent - the
 * association, a calendar event, a co-owner row, a carte entry, a shop section - each carry the two
 * fields under their own names and none of them is the full record.
 */
export interface AssociationAccentSource {
  /** The association's id. THE SEED, because it survives a rename. */
  id: string;
  /** The colour the association chose, if it chose one. Empty is the same as unset. */
  color?: string | null;
}

/**
 * The accent an association wears, as a CSS colour.
 *
 * May be an `hsl(...)` string when it falls back, which every CSS consumer accepts. Use
 * {@link associationAccentHex} where a `#rrggbb` is required - a canvas, a PDF, an inline gradient
 * stop.
 */
export function associationAccent(source: AssociationAccentSource): string {
  return source.color?.trim() || generateAvatarColor(source.id);
}

/** The same accent, always as `#rrggbb`. */
export function associationAccentHex(source: AssociationAccentSource): string {
  return toHex(associationAccent(source));
}
