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
  partnerships: boolean;
  proposals: boolean;
  stripeConnect: boolean;
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
    partnerships: may(AssociationPermissionFlag.MANAGE_PARTNERSHIPS),
    // Republications (POST_AS_ASSO) and co-organisations (PROPOSE_EVENT) share one queue.
    proposals:
      may(AssociationPermissionFlag.POST_AS_ASSO) || may(AssociationPermissionFlag.PROPOSE_EVENT),
    stripeConnect: may(AssociationPermissionFlag.MANAGE_STRIPE_CONNECT),
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
      return rights.stripeConnect || rights.products;
    case 'documents':
      return rights.documents;
    case 'achats':
    case 'delegation':
      return rights.products;
    case 'cotisations':
      return rights.members || rights.products;
    case 'formulaires':
      return rights.forms;
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

/** The sections the hub lists, in order. */
export function visibleEditSections(rights: EditRights): EditSection[] {
  return EDIT_SECTIONS.filter((s) => mayOpenEditSection(s, rights));
}

/** The route of the hub (no section) or of one section. */
export function editSectionHref(
  slug: string,
  section?: EditSection | null
): `/associations/${string}/edit` | `/associations/${string}/edit/${EditSection}` {
  const base = `/associations/${encodeURIComponent(slug)}/edit` as const;
  return section ? `${base}/${section}` : base;
}

/** The localized names a trail is drawn with; the structure is `editTrail`'s, never the caller's. */
export interface EditTrailLabels {
  directory: string;
  directoryHref: string;
  /** The entity's own name; absent while it loads. */
  asso?: string;
  edit: string;
  section?: string;
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
  const trail = [{ label: labels.directory, href: labels.directoryHref }];
  if (labels.asso !== undefined) {
    trail.push({ label: labels.asso, href: `/associations/${encodeURIComponent(slug)}` });
  }
  trail.push({ label: labels.edit, href: editSectionHref(slug) });
  if (section) {
    trail.push({ label: labels.section ?? section, href: editSectionHref(slug, section) });
  }
  return trail;
}
