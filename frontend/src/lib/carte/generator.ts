import type { Association, AssociationMember, PosterZone as MapZone } from '$lib/associations/api';
import { associationAccent } from '$lib/associations/accent';
import { sortByFamilyName } from '$lib/utils/users/familyNameOrder';

/**
 * The persisted poster layout ("project.layout"). Stores the chrome (background) plus the
 * hand-placed bubble positions (P2); the bubble *content* (name, logo, president) is re-resolved
 * from live data on every open, so a reopened map is always current while keeping its arrangement.
 * See {@link PositionedBubble} for the placement shape (kept in `layout.ts` to avoid a cycle).
 */
export interface PosterLayout {
  /** Schema version for forward-compatible migrations. */
  version: number;
  /** Legacy theme id (the theme picker was dropped; ignored on load, kept for old projects). */
  theme?: string;
  /** Optional override for the poster title color (hex); falls back to the theme's title color. */
  titleColor?: string;
  /** Optional background image + scrim. */
  background: {
    /** Data-URL of the uploaded background image, or null for a flat page color. */
    dataUrl: string | null;
    /** Scrim overlay opacity (0-100) over the background image. */
    scrimOpacity: number;
  };
  /**
   * Hand-placed bubble positions (P2). Typed as {@link PositionedBubble}[] at the call sites;
   * declared structurally here to keep `generator.ts` free of a `layout.ts` import cycle. Absent
   * on legacy projects -> the editor seeds a fresh grid.
   */
  bubbles?: unknown[];
  /** Whether the text directory footer is rendered (default true). */
  directoryVisible?: boolean;
  /**
   * Free-form decorations (free text). Typed as {@link Decoration}[] at the call sites; declared
   * structurally here for the same no-import-cycle reason as {@link bubbles}.
   */
  decorations?: unknown[];
}

/** A president/roster reference resolved to a display name + role for rendering. */
export interface PosterMemberRef {
  userId: string;
  name: string;
  /** Given name from the roster row, when the users mirror has one. Sorting only. */
  firstName: string | null;
  /** Family name from the roster row, when the users mirror has one. Sorting only. */
  lastName: string | null;
  role: string;
  isAdmin: boolean;
}

/**
 * Orders a roster the way a printed directory is READ: by family name, then given name.
 *
 * Reported 2026-09-01 - the poster listed "Alice Martin" under A. `name` is one joined-up string,
 * so every alphabetical sort over it is a sort on the GIVEN name; the family name has to come from
 * its own field, which is why the member row now carries both parts. Splitting `name` on whitespace
 * was rejected: it is a guess about which token is the family name, and it guesses wrong on a
 * compound surname ("Van Dupont"), on a nickname and on a mononym.
 *
 * A member the mirror has no family name for sorts under the name that is PRINTED for them - the
 * only string a reader can look them up by, and therefore the only key that keeps the list
 * scannable.
 *
 * @param members - Roster references, in any order; not mutated.
 * @returns A new array, sorted by family name then given name.
 */
export function orderByFamilyName(members: PosterMemberRef[]): PosterMemberRef[] {
  // The rule itself is shared with every on-screen member list (`utils/users/familyNameOrder`), so
  // the poster and the panels can never disagree about who comes first.
  return sortByFamilyName(
    members,
    (mem) => ({ firstName: mem.firstName, lastName: mem.lastName, displayName: mem.name }),
    (mem) => mem.userId
  );
}

/**
 * Roles that say nothing: being in the list already says the person is a member.
 *
 * Measured on the published map: "(Membre)" appeared ~100 times in 8,200 characters of directory,
 * and the directory's font is fitted to its column - so every character it does not print is font
 * size the names that matter get back.
 */
const GENERIC_ROLES = new Set(['membre', 'member', 'adherent', 'adherente']);

/** Whether a role is one of those, ignoring case and accents. */
function isGenericRole(role: string): boolean {
  const stripped = role.normalize('NFD').replaceAll(/[̀-ͯ]/g, '');
  const plain = stripped.trim().toLowerCase();
  return GENERIC_ROLES.has(plain);
}

/**
 * One association's roster, formatted exactly as the printed directory reads it.
 *
 * Lives here because the poster and the PUBLISHED document both print it and must print the same
 * thing - it was written twice, and a change to one was a change only half the readers saw.
 *
 * Only a role that says something goes in parentheses (user, D5).
 */
export function directoryLine(asso: Pick<PosterBubble, 'members'>): string {
  return orderByFamilyName(asso.members)
    .map((mem) => (mem.role && !isGenericRole(mem.role) ? `${mem.name} (${mem.role})` : mem.name))
    .join(' - ');
}

/** One association rendered as a colored blob unit on the poster. */
export interface PosterBubble {
  assoId: string;
  name: string;
  /** Resolved brand color (asso.color or a deterministic fallback). */
  color: string;
  logoUrl: string | null;
  /** The association's president, when one is detected from the roster (shown inside the blob). */
  president: PosterMemberRef | null;
  /** Bureau = the asso admins other than the president, laid out as radial polaroids. */
  bureau: PosterMemberRef[];
  /** Every member of the association, listed in the right-hand directory. */
  members: PosterMemberRef[];
  contactEmail: string | null;
  memberCount: number;
}

/** A zone of the map grouping the associations placed in it. */
interface PosterZone {
  /** The map's zone id, or null for the catch-all zone of unzoned associations. */
  zoneId: string | null;
  label: string;
  bubbles: PosterBubble[];
}

/** The full render model: ordered zones + a headline count. */
export interface PosterModel {
  zones: PosterZone[];
  totalAssos: number;
}

/** Resolves a raw roster member into the display-ready reference used across the poster. */
function toMemberRef(mem: AssociationMember): PosterMemberRef {
  return {
    userId: mem.userId,
    name: mem.displayName?.trim() || mem.userId,
    firstName: mem.firstName?.trim() || null,
    lastName: mem.lastName?.trim() || null,
    role: mem.role?.trim() || '',
    isAdmin: mem.isAdmin || false,
  };
}

/**
 * Picks the president from a roster by taking the first member in display order.
 * The association members endpoint already returns the roster ordered by the source sort order.
 */
function findPresident(members: AssociationMember[]): PosterMemberRef | null {
  const hit = members[0];
  if (!hit) return null;
  return { ...toMemberRef(hit), role: hit.role?.trim() || 'President' };
}

/**
 * Builds the poster render model from live data: keeps the regular (non-archived) associations the
 * map SHOWS, resolves each one's brand color + president, then groups them into the map's own zones
 * ordered by `sortOrder` (unzoned last, only when non-empty). Bubbles are sorted alphabetically.
 *
 * Zones are the map's since migration 147 (owner, 2026-11-08): no platform taxonomy is read here.
 *
 * @param associations - The associations to draw: the caller passes the switched-on ones of the
 *   map's space (lists and archived ones are filtered out here too).
 * @param zones - The map's zones, in any order (re-sorted here).
 * @param zoneOf - Each association's zone on this map; absent or unknown = unzoned.
 * @param membersByAsso - Roster per association id, used to detect presidents.
 * @param unzonedLabel - Localized label for the catch-all zone.
 */
export function buildPosterModel(
  associations: Association[],
  zones: Pick<MapZone, 'id' | 'label' | 'sortOrder'>[],
  zoneOf: Record<string, string | null>,
  membersByAsso: Record<string, AssociationMember[]>,
  unzonedLabel: string
): PosterModel {
  const regular = associations.filter((a) => a.type === 'association' && !a.archived);

  const bubbleOf = (a: Association): PosterBubble => {
    const roster = membersByAsso[a.id] ?? [];
    const president = findPresident(roster);
    // Bureau = admins other than the president (keeps roster order, after the first row).
    const bureau = roster
      .slice(1)
      .filter((mem) => mem.isAdmin)
      .map(toMemberRef);
    // Directory lists every member; kept in roster order here, ordered by family name at render
    // time (see `orderByFamilyName`) - the bureau below needs the roster order this preserves.
    const members = roster.map(toMemberRef);
    return {
      assoId: a.id,
      name: a.name,
      color: associationAccent(a),
      logoUrl: a.logoUrl ?? null,
      president,
      bureau,
      members,
      contactEmail: a.contactEmail?.trim() || null,
      memberCount: roster.length || (a.memberCount ?? 0),
    };
  };

  const ordered = [...zones].sort((x, y) => x.sortOrder - y.sortOrder);
  const out: PosterZone[] = [];

  for (const zone of ordered) {
    const bubbles = regular
      .filter((a) => zoneOf[a.id] === zone.id)
      .map(bubbleOf)
      .sort((x, y) => x.name.localeCompare(y.name));
    if (bubbles.length > 0) {
      out.push({ zoneId: zone.id, label: zone.label, bubbles });
    }
  }

  const knownIds = new Set(ordered.map((z) => z.id));
  const unzoned = regular
    .filter((a) => {
      const zoneId = zoneOf[a.id];
      return !zoneId || !knownIds.has(zoneId);
    })
    .map(bubbleOf)
    .sort((x, y) => x.name.localeCompare(y.name));
  if (unzoned.length > 0) {
    out.push({ zoneId: null, label: unzonedLabel, bubbles: unzoned });
  }

  return { zones: out, totalAssos: regular.length };
}
