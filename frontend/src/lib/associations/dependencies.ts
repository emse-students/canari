import { m } from '$lib/paraglide/messages';
import { Log } from '$lib/utils/Log';
import type { PickerOption } from '$lib/components/ui/picker';
import {
  AssociationPermissionFlag,
  SocialApiError,
  type Association,
  type DependencyEntity,
  type DependencyMismatch,
} from './api';

/**
 * THE DEPENDENCY AXIS, AS THE SCREENS READ IT (reform 2.2, 2.5 and 2.7; WP-D1): who depends on
 * which BDE, the parent a creator may choose, and the sentence for each typed refusal. The rules
 * themselves are the server's (`spaces/dependency-rules.ts`, enforced by migration 131); this file
 * only arranges what the server answered.
 */

/** The typed refusals of a dependency write or of a creation (social-service `dependency-rules.ts`). */
export const DEPENDENCY_REFUSAL = {
  INSTITUTION: 'DEPENDENCY_INSTITUTION',
  CHILD_IS_A_BDE: 'DEPENDENCY_CHILD_IS_A_BDE',
  PARENT_NOT_A_BDE: 'DEPENDENCY_PARENT_NOT_A_BDE',
  PARENT_CHOICE_REQUIRED: 'DEPENDENCY_PARENT_CHOICE_REQUIRED',
  PARENT_NOT_YOURS: 'DEPENDENCY_PARENT_NOT_YOURS',
  LABEL_INVALID: 'DEPENDENCY_LABEL_INVALID',
  DELETE_ADMIN_ONLY: 'DEPENDENCY_DELETE_ADMIN_ONLY',
  SPACE_GOVERNOR_TYPE: 'SPACE_GOVERNOR_TYPE',
} as const;

export type DependencyRefusalCode = (typeof DEPENDENCY_REFUSAL)[keyof typeof DEPENDENCY_REFUSAL];

const KNOWN: ReadonlySet<string> = new Set(Object.values(DEPENDENCY_REFUSAL));

/** The dependency refusal an error carries, or `null` for anything else (never read from prose). */
export function dependencyRefusalCode(err: unknown): DependencyRefusalCode | null {
  if (err instanceof SocialApiError && err.code !== null && KNOWN.has(err.code)) {
    return err.code as DependencyRefusalCode;
  }
  return null;
}

/** The sentence for a dependency refusal code, in the reader's language. */
export function dependencyRefusalText(code: DependencyRefusalCode): string {
  switch (code) {
    case DEPENDENCY_REFUSAL.INSTITUTION:
      return m.dependency_err_institution();
    case DEPENDENCY_REFUSAL.CHILD_IS_A_BDE:
      return m.dependency_err_child_is_a_bde();
    case DEPENDENCY_REFUSAL.PARENT_NOT_A_BDE:
      return m.dependency_err_parent_not_a_bde();
    case DEPENDENCY_REFUSAL.PARENT_CHOICE_REQUIRED:
      return m.dependency_err_parent_choice_required();
    case DEPENDENCY_REFUSAL.PARENT_NOT_YOURS:
      return m.dependency_err_parent_not_yours();
    case DEPENDENCY_REFUSAL.LABEL_INVALID:
      return m.dependency_err_label_invalid();
    case DEPENDENCY_REFUSAL.DELETE_ADMIN_ONLY:
      return m.dependency_err_delete_admin_only();
    case DEPENDENCY_REFUSAL.SPACE_GOVERNOR_TYPE:
      return m.dependency_err_space_governor_type();
  }
}

/** The sentence for an error when it is a dependency refusal, else `null` (the caller's fallback). */
export function dependencyRefusalMessage(err: unknown): string | null {
  const code = dependencyRefusalCode(err);
  return code === null ? null : dependencyRefusalText(code);
}

/** The sentence for one mismatch of the panel (reform 2.5). */
export function mismatchText(mismatch: DependencyMismatch): string {
  switch (mismatch) {
    case 'parent_missing':
      return m.dependency_mismatch_parent_missing();
    case 'parent_governs_nothing':
      return m.dependency_mismatch_parent_governs_nothing();
    case 'reaches_outside_parent':
      return m.dependency_mismatch_reaches_outside_parent();
    case 'parent_governs_none_of_audience':
      return m.dependency_mismatch_parent_governs_none_of_audience();
  }
}

/** A BDE: an association governing at least one space (2.2). An institution may govern and is not one. */
export function isBde(entity: Pick<DependencyEntity, 'type' | 'governs'>): boolean {
  return entity.type === 'association' && entity.governs;
}

/** One BDE and the entities that depend on it, in the panel's order. */
interface BdeFamily {
  bde: DependencyEntity;
  children: DependencyEntity[];
}

/** The Dependencies panel, arranged: each BDE with its children, then the rest, apart. */
export interface DependencyTree {
  families: BdeFamily[];
  /** Institutions: they depend on nobody, and may govern a space without being a BDE (D3). */
  institutions: DependencyEntity[];
  /** Associations and lists with no parent that are not BDEs: no BDE answers for them. */
  unattached: DependencyEntity[];
  /** A parent that is not a BDE on this list (deleted, or no longer governing): shown to be fixed. */
  orphaned: DependencyEntity[];
}

const byName = (a: DependencyEntity, b: DependencyEntity) => a.name.localeCompare(b.name, 'fr');

/**
 * Arranges the server's flat list into the panel's groups. Every entity lands in exactly one: a
 * BDE heads its family, a child sits under its BDE, and a child whose parent is not a BDE here is
 * ORPHANED rather than dropped - the panel exists to show what does not fit.
 */
export function groupDependencies(entities: readonly DependencyEntity[]): DependencyTree {
  const families = new Map<string, BdeFamily>();
  for (const e of [...entities].sort(byName)) {
    if (isBde(e) && e.parentAssociationId === null) families.set(e.id, { bde: e, children: [] });
  }
  const tree: DependencyTree = {
    families: [...families.values()],
    institutions: [],
    unattached: [],
    orphaned: [],
  };
  for (const e of [...entities].sort(byName)) {
    if (families.has(e.id)) continue;
    if (e.type === 'institution' && e.parentAssociationId === null) {
      tree.institutions.push(e);
    } else if (e.parentAssociationId === null) {
      tree.unattached.push(e);
    } else {
      const family = families.get(e.parentAssociationId);
      if (family) family.children.push(e);
      else tree.orphaned.push(e);
    }
  }
  Log.d(
    `dependencies.group: ${tree.families.length} BDE(s), ${tree.institutions.length} institution(s), ${tree.unattached.length} unattached, ${tree.orphaned.length} orphaned`
  );
  return tree;
}

/** The entities a governing parent may be chosen among: the BDEs, live first. */
export function parentCandidates(entities: readonly DependencyEntity[]): DependencyEntity[] {
  return entities.filter((e) => isBde(e) && e.parentAssociationId === null).sort(byName);
}

/**
 * The entities a list may be SHOWN under (G3): associations that are not BDEs (a BDS, a BDA). A BDE
 * needs no label - it is the parent itself.
 */
export function labelCandidates(entities: readonly DependencyEntity[]): DependencyEntity[] {
  return entities.filter((e) => e.type === 'association' && !e.governs).sort(byName);
}

/**
 * What the create form asks of a NON-ADMIN creator about the parent (reform 2.5, owner B1): the
 * BDEs where it holds `MANAGE_ASSO`, read from its memberships. One is taken without asking; several
 * must be picked from (the server refuses with `DEPENDENCY_PARENT_CHOICE_REQUIRED` otherwise).
 */
export function creatorBdes(myAssociations: readonly Association[]): Association[] {
  return myAssociations
    .filter(
      (a) =>
        a.type === 'association' &&
        a.isBDE &&
        !a.parentAssociationId &&
        ((a.permissions ?? 0) & AssociationPermissionFlag.MANAGE_ASSO) !== 0
    )
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

/** An entity the create form may name as parent: an id and a name are all it shows. */
export interface ParentChoice {
  id: string;
  name: string;
}

/** What the create form shows about the parent of a new association or list. */
export interface CreateParentField {
  /** The picker's options, BDEs first; empty when nothing is asked. */
  options: PickerOption[];
  /** The value the picker starts on. */
  initial: string;
  /** The one BDE the entity will depend on without asking (a non-admin managing exactly one). */
  fixed: ParentChoice | null;
  /** A BDE must be picked before submitting (a non-admin managing several). */
  required: boolean;
}

/**
 * The parent field of the create form (reform 2.5, owner B1; WP-D1). `bdes` are the BDEs the creator
 * may name (every BDE for a platform admin, its own `MANAGE_ASSO` ones otherwise); `labels` the
 * associations a LIST may be shown under (G3), which the server keeps as the label and pairs with
 * the default parent - so they are offered only when that default is unambiguous (an admin, whose
 * default is none, or a creator with one BDE).
 */
export function createParentField(
  kind: 'association' | 'list',
  isAdmin: boolean,
  bdes: readonly ParentChoice[],
  labels: readonly ParentChoice[]
): CreateParentField {
  const bdeOptions = bdes.map((b) => ({
    value: b.id,
    label: b.name,
    group: m.create_parent_group_bde(),
  }));
  const several = !isAdmin && bdes.length > 1;
  const labelOptions =
    kind === 'list' && !several
      ? labels.map((l) => ({ value: l.id, label: l.name, group: m.create_parent_group_label() }))
      : [];
  if (isAdmin) {
    return {
      options: [{ value: '', label: m.list_new_parent_none() }, ...bdeOptions, ...labelOptions],
      initial: '',
      fixed: null,
      required: false,
    };
  }
  if (several) {
    return {
      options: [{ value: '', label: m.create_parent_choose() }, ...bdeOptions],
      initial: '',
      fixed: null,
      required: true,
    };
  }
  const only = bdes[0] ?? null;
  return {
    // A list may still be SHOWN under a non-BDE: '' keeps the one BDE as both parent and label.
    options:
      labelOptions.length > 0 && only
        ? [{ value: '', label: m.create_parent_only({ name: only.name }) }, ...labelOptions]
        : [],
    initial: '',
    fixed: only,
    required: false,
  };
}

/**
 * The entities that depend on `bdeId`, from the directory (every row carries its governing parent):
 * what a BDE's edit page shows read-only (reform F9). Archived ones last, each group by name.
 */
export function dependentsOf<
  T extends Pick<Association, 'name' | 'archived' | 'parentAssociationId'>,
>(directory: readonly T[], bdeId: string): T[] {
  return directory
    .filter((a) => a.parentAssociationId === bdeId)
    .sort((a, b) => Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name, 'fr'));
}
