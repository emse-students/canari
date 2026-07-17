import { generateAvatarColor } from '$lib/utils/avatar';
import type { Association, AssociationCategory, AssociationMember } from '$lib/associations/api';

/**
 * The persisted poster layout ("project.layout"). Stores the chrome (theme + background) plus the
 * hand-placed bubble positions (P2); the bubble *content* (name, logo, president) is re-resolved
 * from live data on every open, so a reopened map is always current while keeping its arrangement.
 * See {@link PositionedBubble} for the placement shape (kept in `layout.ts` to avoid a cycle).
 */
export interface PosterLayout {
  /** Schema version for forward-compatible migrations. */
  version: number;
  /** Selected theme id (see {@link CARTE_THEMES}). */
  theme: string;
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
}

/** A president/roster reference resolved to a display name + role for rendering. */
export interface PosterMemberRef {
  userId: string;
  name: string;
  role: string;
}

/** One association rendered as a colored bubble on the poster. */
export interface PosterBubble {
  assoId: string;
  name: string;
  /** Resolved brand color (asso.color or a deterministic fallback). */
  color: string;
  logoUrl: string | null;
  /** The association's president, when one is detected from the roster. */
  president: PosterMemberRef | null;
  contactEmail: string | null;
  memberCount: number;
}

/** A category zone grouping the associations that belong to it. */
export interface PosterZone {
  /** Category id, or null for the "uncategorized" catch-all zone. */
  categoryId: string | null;
  label: string;
  bubbles: PosterBubble[];
}

/** The full render model: ordered zones + a headline count. */
export interface PosterModel {
  zones: PosterZone[];
  totalAssos: number;
}

/** Strips accents and lowercases so role matching tolerates "Président"/"president". */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/**
 * Picks the president from a roster by matching the role text (tolerant of accents/case).
 * Returns the first member whose role contains "presid"; null when none is found.
 */
function findPresident(members: AssociationMember[]): PosterMemberRef | null {
  const hit = members.find((mem) => normalize(mem.role ?? '').includes('presid'));
  if (!hit) return null;
  return {
    userId: hit.userId,
    name: hit.displayName?.trim() || hit.userId,
    role: hit.role?.trim() || 'President',
  };
}

/**
 * Builds the poster render model from live data: keeps regular (non-archived) associations,
 * resolves each one's brand color + president, then groups them into category zones ordered by
 * `sortOrder` (uncategorized last, only when non-empty). Bubbles are sorted alphabetically.
 *
 * @param associations - All associations (lists and archived ones are filtered out).
 * @param categories - Managed category rows, in any order (re-sorted here).
 * @param membersByAsso - Roster per association id, used to detect presidents.
 * @param uncategorizedLabel - Localized label for the catch-all zone.
 */
export function buildPosterModel(
  associations: Association[],
  categories: AssociationCategory[],
  membersByAsso: Record<string, AssociationMember[]>,
  uncategorizedLabel: string
): PosterModel {
  const regular = associations.filter((a) => a.type === 'association' && !a.archived);

  const bubbleOf = (a: Association): PosterBubble => ({
    assoId: a.id,
    name: a.name,
    color: a.color?.trim() || generateAvatarColor(a.id),
    logoUrl: a.logoUrl ?? null,
    president: findPresident(membersByAsso[a.id] ?? []),
    contactEmail: a.contactEmail?.trim() || null,
    memberCount: (membersByAsso[a.id] ?? []).length || (a.memberCount ?? 0),
  });

  const orderedCategories = [...categories].sort((x, y) => x.sortOrder - y.sortOrder);
  const zones: PosterZone[] = [];

  for (const cat of orderedCategories) {
    const bubbles = regular
      .filter((a) => a.categoryId === cat.id)
      .map(bubbleOf)
      .sort((x, y) => x.name.localeCompare(y.name));
    if (bubbles.length > 0) {
      zones.push({ categoryId: cat.id, label: cat.label, bubbles });
    }
  }

  const knownIds = new Set(orderedCategories.map((c) => c.id));
  const uncategorized = regular
    .filter((a) => !a.categoryId || !knownIds.has(a.categoryId))
    .map(bubbleOf)
    .sort((x, y) => x.name.localeCompare(y.name));
  if (uncategorized.length > 0) {
    zones.push({ categoryId: null, label: uncategorizedLabel, bubbles: uncategorized });
  }

  return { zones, totalAssos: regular.length };
}
