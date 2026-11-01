/**
 * THE SECTIONS OF AN ASSOCIATION'S MANAGEMENT AREA, AND WHO MAY OPEN EACH.
 *
 * A section is a ROUTE segment (`/associations/<slug>/edit/<section>`), so the segment is user
 * input: anyone may type `/edit/danger`. The old page validated a requested section only against
 * the static list, which is how it rendered a section its reader held no right for. The rule lives
 * HERE, once, and both the hub (which rows to draw) and the section route (whether to render) ask
 * it - never a second expression.
 *
 * The server stays the authority on every write; this is the client refusing to DRAW what the
 * server would refuse to ANSWER, and it mirrors the guards each section's own endpoints carry.
 */
import {
  ASSOCIATION_ADMIN_PRESET,
  AssociationPermissionFlag,
  mayActOnAssociation,
  type Association,
} from '$lib/associations/api';

/** The section keys, in hub order. `republications` keeps its name: old notifications link to it. */
export const EDIT_SECTIONS = [
  'profile',
  'members',
  'payments',
  'documents',
  'achats',
  'cotisations',
  'delegation',
  'formulaires',
  'reservations',
  'partnerships',
  'republications',
  'audience',
  'danger',
] as const;

export type EditSection = (typeof EDIT_SECTIONS)[number];

/** The three tiers the rights are read from; see `mayActOnAssociation`. */
export interface EditPermissionContext {
  isGlobalAdmin: boolean;
  isSuperAdmin: boolean;
  memberPermissions?: number;
}

/** Narrows an untrusted string (a URL segment, a query value) to a section key. */
export function parseEditSection(value: string | null | undefined): EditSection | null {
  return (EDIT_SECTIONS as readonly string[]).includes(value ?? '') ? (value as EditSection) : null;
}

/** The rights the sections gate on, gathered once. */
export interface EditRights {
  members: boolean;
  documents: boolean;
  products: boolean;
  forms: boolean;
  /** `MANAGE_BOOKINGS` (D30): the entity's bookable spaces. */
  bookings: boolean;
  partnerships: boolean;
  proposals: boolean;
  payoutAccount: boolean;
  audience: boolean;
  /** The delete card inside `danger`; archiving is `members`. */
  delete: boolean;
}

/**
 * Every right the management sections read, from one context. `assoType` matters for exactly one
 * thing: an institution's audience is a global admin's alone (`AUDIENCE_INSTITUTION_ADMIN_ONLY`).
 */
export function editRights(
  ctx: EditPermissionContext,
  assoType: Association['type'] = 'association'
): EditRights {
  const may = (flag: AssociationPermissionFlag) => mayActOnAssociation(flag, ctx);
  return {
    members: may(AssociationPermissionFlag.MANAGE_MEMBERS),
    documents: may(AssociationPermissionFlag.MANAGE_DOCUMENTS),
    products: may(AssociationPermissionFlag.MANAGE_PRODUCTS),
    forms: may(AssociationPermissionFlag.MANAGE_FORMS),
    bookings: may(AssociationPermissionFlag.MANAGE_BOOKINGS),
    partnerships: may(AssociationPermissionFlag.MANAGE_PARTNERSHIPS),
    // Republications (POST_AS_ASSO) and co-organisations (PROPOSE_EVENT) share one queue.
    proposals:
      may(AssociationPermissionFlag.POST_AS_ASSO) || may(AssociationPermissionFlag.PROPOSE_EVENT),
    payoutAccount: may(AssociationPermissionFlag.MANAGE_PAYOUT_ACCOUNT),
    audience: ctx.isGlobalAdmin || (ctx.isSuperAdmin && assoType !== 'institution'),
    delete: ctx.isGlobalAdmin || ctx.isSuperAdmin,
  };
}

/** Whether `section` may be drawn for a reader holding `rights`. `profile` is the one open to all. */
export function mayOpenEditSection(section: EditSection, rights: EditRights): boolean {
  switch (section) {
    case 'profile':
      return true;
    case 'members':
      return rights.members;
    case 'payments':
      return rights.payoutAccount || rights.products;
    case 'documents':
      return rights.documents;
    case 'achats':
    case 'delegation':
      return rights.products;
    case 'cotisations':
      return rights.members || rights.products;
    case 'formulaires':
      return rights.forms;
    case 'reservations':
      return rights.bookings;
    case 'partnerships':
      return rights.partnerships;
    case 'republications':
      return rights.proposals;
    case 'audience':
      return rights.audience;
    case 'danger':
      return rights.members;
  }
}

/**
 * THE ONE TABLE OF WHICH SECTIONS EACH KIND OF ENTITY HAS (owner, 2026-10-31).
 *
 * An association has every section. A LIST and an INSTITUTION sell nothing - no shop, cotisations,
 * purchases, delegation or payments - but both keep documents, forms, bookable spaces,
 * partnerships and the republication/co-organisation queue. An institution alone has an audience
 * (a global admin's, `AUDIENCE_INSTITUTION_ADMIN_ONLY`; a list's audience stays the BDE's, written
 * from the association edit tooling, not a section of its own). The rights are the SAME
 * `mayOpenEditSection` answers; only the roster of keys differs.
 *
 * The permission editor's offered flags are derived from THIS table (`permissionFlagsFor`), so a
 * kind is never offered a right whose section it does not have.
 */
const SELLING_FREE_SECTIONS: readonly EditSection[] = [
  'profile',
  'members',
  'documents',
  'formulaires',
  'reservations',
  'partnerships',
  'republications',
  'danger',
];

export const EDIT_SECTIONS_BY_KIND: Record<Association['type'], readonly EditSection[]> = {
  association: EDIT_SECTIONS,
  list: SELLING_FREE_SECTIONS,
  institution: EDIT_SECTIONS.filter((s) => SELLING_FREE_SECTIONS.includes(s) || s === 'audience'),
};

/** The sections a list's management area has (see `EDIT_SECTIONS_BY_KIND`). */
export const LIST_EDIT_SECTIONS: readonly EditSection[] = EDIT_SECTIONS_BY_KIND.list;

/** The association rights each section is gated on, mirroring `mayOpenEditSection`. */
const SECTION_FLAGS: Record<EditSection, readonly AssociationPermissionFlag[]> = {
  profile: [],
  members: [AssociationPermissionFlag.MANAGE_MEMBERS],
  payments: [
    AssociationPermissionFlag.MANAGE_PAYOUT_ACCOUNT,
    AssociationPermissionFlag.MANAGE_PRODUCTS,
  ],
  documents: [AssociationPermissionFlag.MANAGE_DOCUMENTS],
  achats: [AssociationPermissionFlag.MANAGE_PRODUCTS],
  cotisations: [
    AssociationPermissionFlag.MANAGE_MEMBERS,
    AssociationPermissionFlag.MANAGE_PRODUCTS,
  ],
  delegation: [AssociationPermissionFlag.MANAGE_PRODUCTS],
  formulaires: [AssociationPermissionFlag.MANAGE_FORMS],
  reservations: [AssociationPermissionFlag.MANAGE_BOOKINGS],
  partnerships: [AssociationPermissionFlag.MANAGE_PARTNERSHIPS],
  republications: [AssociationPermissionFlag.POST_AS_ASSO, AssociationPermissionFlag.PROPOSE_EVENT],
  audience: [],
  danger: [AssociationPermissionFlag.MANAGE_MEMBERS],
};

/**
 * The permission bits a kind's role editor offers: the union of the flags of its sections. The BDE
 * flags are not here - `AssociationMemberRow` adds them for a BDE association on top.
 */
export function permissionMaskFor(kind: Association['type']): number {
  let mask = 0;
  for (const section of EDIT_SECTIONS_BY_KIND[kind]) {
    for (const flag of SECTION_FLAGS[section]) mask |= flag;
  }
  return mask;
}

/**
 * The admin preset a new member of `kind` receives: `ASSOCIATION_ADMIN_PRESET` narrowed to the
 * rights the kind has a section for, so a list's President is never handed a shop right.
 */
export function adminPresetFor(kind: Association['type']): number {
  return ASSOCIATION_ADMIN_PRESET & permissionMaskFor(kind);
}

/** Whether `kind` has `section` at all, whatever the reader's rights. */
export function kindHasSection(kind: Association['type'], section: EditSection): boolean {
  return EDIT_SECTIONS_BY_KIND[kind].includes(section);
}

/** Whether the role editor of `kind` offers `flag`. */
export function kindOffersFlag(
  kind: Association['type'],
  flag: AssociationPermissionFlag
): boolean {
  return (permissionMaskFor(kind) & flag) !== 0;
}

/** Where a management area lives: associations and institutions under `/associations`, lists under `/lists`. */
export type EditBase = '/associations' | '/lists';

/** The sections the hub lists, in order; `among` narrows the keys for a kind with fewer. */
export function visibleEditSections(
  rights: EditRights,
  among: readonly EditSection[] = EDIT_SECTIONS
): EditSection[] {
  return among.filter((s) => mayOpenEditSection(s, rights));
}

/** The route of the hub (no section) or of one section. */
export function editSectionHref<B extends EditBase = '/associations'>(
  slug: string,
  section?: EditSection | null,
  base: B = '/associations' as B
): `${B}/${string}/edit` | `${B}/${string}/edit/${EditSection}` {
  const root = `${base}/${encodeURIComponent(slug)}/edit` as const;
  return section ? `${root}/${section}` : root;
}

/** The localized names a trail is drawn with; the structure is `editTrail`'s, never the caller's. */
export interface EditTrailLabels {
  directory: string;
  directoryHref: string;
  /** The entity's own name; absent while it loads. */
  asso?: string;
  edit: string;
  section?: string;
  /** Where the entity's own public page lives; `/associations` unless it is a list. */
  base?: EditBase;
}

/**
 * The path to an edit page: directory > the entity > the management hub > the open section.
 * Back goes to the previous crumb, so this one function IS the back behaviour of every level.
 */
export function editTrail(
  slug: string,
  section: EditSection | null,
  labels: EditTrailLabels
): { label: string; href: string }[] {
  const base = labels.base ?? '/associations';
  const trail = [{ label: labels.directory, href: labels.directoryHref }];
  if (labels.asso !== undefined) {
    trail.push({ label: labels.asso, href: `${base}/${encodeURIComponent(slug)}` });
  }
  trail.push({ label: labels.edit, href: editSectionHref(slug, null, base) });
  if (section) {
    trail.push({
      label: labels.section ?? section,
      href: editSectionHref(slug, section, base),
    });
  }
  return trail;
}
