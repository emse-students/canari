/**
 * THE SECTIONS OF AN ASSOCIATION'S (OR LIST'S) PUBLIC PAGE, AND WHEN EACH EXISTS.
 *
 * The page used to be five tabs in a scrolling row, local state, so Back left the page and a tab
 * past the edge was unreachable. It is a hub now (`/associations/<slug>`: the identity, the about
 * text and one row per section) and a section is a ROUTE segment (`/associations/<slug>/<section>`),
 * for lists `/lists/<slug>/<section>`. Back goes up one level, a reload keeps the place, a link can
 * be shared (user, 2026-10-08).
 *
 * The segment is user input, so the rule for "does this section exist" lives HERE, once, and the hub
 * (which rows to draw) and the route (whether to render) both ask it. `shop` and `partnerships` are
 * conditional - an association with nothing to sell has no shop - so a typed `/shop` on one is sent
 * back to the hub rather than drawing an empty section.
 */
import type { PageWidth } from '$lib/components/layout/pageWidth';

/** The section keys, in hub order. The about text is not one: it is the hub's own body. */
export const PUBLIC_SECTIONS = ['calendar', 'members', 'shop', 'partnerships'] as const;

export type PublicSection = (typeof PUBLIC_SECTIONS)[number];

/** Where a public page lives: associations (and institutions) under `/associations`, lists under `/lists`. */
export type PublicBase = '/associations' | '/lists';

/** What decides whether a conditional section exists: what the page actually has to show. */
export interface PublicContent {
  productCount: number;
  partnershipCount: number;
}

/** Narrows an untrusted string (a URL segment, a query value) to a section key. */
export function parsePublicSection(value: string | null | undefined): PublicSection | null {
  return (PUBLIC_SECTIONS as readonly string[]).includes(value ?? '')
    ? (value as PublicSection)
    : null;
}

/** Whether `section` exists for a page holding `content`. Calendar and members always do. */
export function mayOpenPublicSection(section: PublicSection, content: PublicContent): boolean {
  switch (section) {
    case 'calendar':
    case 'members':
      return true;
    case 'shop':
      return content.productCount > 0;
    case 'partnerships':
      return content.partnershipCount > 0;
  }
}

/** The sections the hub lists, in order. */
export function visiblePublicSections(content: PublicContent): PublicSection[] {
  return PUBLIC_SECTIONS.filter((s) => mayOpenPublicSection(s, content));
}

/** The route of the hub (no section) or of one section. */
export function publicSectionHref(
  base: PublicBase,
  slug: string,
  section?: PublicSection | null
): `${PublicBase}/${string}` | `${PublicBase}/${string}/${PublicSection}` {
  const root = `${base}/${encodeURIComponent(slug)}` as const;
  return section ? `${root}/${section}` : root;
}

/**
 * THE WIDTH FOLLOWS THE SECTION, because the page is several pages: `calendar` is a month and
 * `shop`/`partnerships` are card walls, all `grid`; the hub (prose and rows) and `members` (a column
 * of full-width rows) have no second column to fill and stay `tool`.
 */
export function publicSectionWidth(section: PublicSection | null): PageWidth {
  return section === 'calendar' || section === 'shop' || section === 'partnerships'
    ? 'grid'
    : 'tool';
}

/** The localized names a trail is drawn with; the structure is `publicTrail`'s, never the caller's. */
export interface PublicTrailLabels {
  directory: string;
  directoryHref: string;
  /** The entity's own name; absent while it loads. */
  asso?: string;
  section?: string;
}

/**
 * The path to a public page: directory > the entity > the open section. Back goes to the previous
 * crumb, so this one function IS the back behaviour of every level (section -> hub -> directory).
 */
export function publicTrail(
  base: PublicBase,
  slug: string,
  section: PublicSection | null,
  labels: PublicTrailLabels
): { label: string; href: string }[] {
  const trail = [{ label: labels.directory, href: labels.directoryHref }];
  // While the entity loads its name is unknown; the hub is still a real level, so it keeps a crumb.
  trail.push({ label: labels.asso ?? slug, href: publicSectionHref(base, slug) });
  if (section) {
    trail.push({
      label: labels.section ?? section,
      href: publicSectionHref(base, slug, section),
    });
  }
  return trail;
}

/**
 * Where a request for the public page must go instead, or `null` when it is already right.
 *
 * Keeps every link written BEFORE sections became segments working: a post's "see the event" link
 * is `?section=calendar&fromPost=<id>`, and the rest of the query rides along because the calendar
 * reads `fromPost` itself. `?section=about` and an unknown name land on the hub (dropping the
 * `section` key only); an unknown segment lands on the hub with nothing else.
 */
export function publicRedirectTarget(
  base: PublicBase,
  slug: string,
  segment: string | undefined,
  search: URLSearchParams
): string | null {
  const legacy = search.get('section');
  if (legacy !== null) {
    const rest = new URLSearchParams(search);
    rest.delete('section');
    const query = rest.size > 0 ? `?${rest}` : '';
    return `${publicSectionHref(base, slug, parsePublicSection(legacy))}${query}`;
  }
  if (segment && !parsePublicSection(segment)) {
    return publicSectionHref(base, slug);
  }
  return null;
}
