import { ConflictException } from '@nestjs/common';
import type { LoggerService } from '@nestjs/common';

/**
 * THE DEPENDENCY AXIS, AS RULES (WP-D1; docs/wiki/spaces-and-audiences-reform.md 2.2, owner D2).
 *
 * "Enfants directs. Et il ne peut y avoir que deux niveaux maximum. Un BDE n'est gere par personne.
 * Les associations/listes peuvent etre gerees par un BDE. Les institutions ne peuvent pas etre
 * gerees." The governing parent (`associations."parentAssociationId"`) is ADDITIVE in WP-D1: nothing
 * reads it for governance until WP-D2.
 *
 * The same three rules are enforced by migration 131 (`canari_dependency_refusal` and its two
 * triggers), which makes a hand-written UPDATE unable to break them; the service asks THIS first so
 * a refusal reaches the client as a typed 409, and maps a trigger's refusal (a write that raced the
 * check) to the same code through `dependencyRefusalOf`.
 */

/** An institution is given a parent: institutions are "des entites differentes" (D2). */
export const DEPENDENCY_INSTITUTION = 'DEPENDENCY_INSTITUTION';
/** A space governor is given a parent, or a parented association is designated as a governor. */
export const DEPENDENCY_CHILD_IS_A_BDE = 'DEPENDENCY_CHILD_IS_A_BDE';
/** The parent is not an association governing at least one space. */
export const DEPENDENCY_PARENT_NOT_A_BDE = 'DEPENDENCY_PARENT_NOT_A_BDE';
/** A non-admin creator holding MANAGE_ASSO in several BDEs named none of them (2.5). */
export const DEPENDENCY_PARENT_CHOICE_REQUIRED = 'DEPENDENCY_PARENT_CHOICE_REQUIRED';
/** A non-admin creator named, as parent, a BDE where they do not hold MANAGE_ASSO (2.5). */
export const DEPENDENCY_PARENT_NOT_YOURS = 'DEPENDENCY_PARENT_NOT_YOURS';
/** A label names an association that does not exist, or an institution, or the entity itself. */
export const DEPENDENCY_LABEL_INVALID = 'DEPENDENCY_LABEL_INVALID';

/**
 * A delete of an association that governs a space or has children, asked by anybody but the
 * platform admin (owner A4: only the platform admin changes a dependency, and a delete changes them).
 */
export const DEPENDENCY_DELETE_ADMIN_ONLY = 'DEPENDENCY_DELETE_ADMIN_ONLY';

/** A list designated as a space governor: a governor is an association or an institution (2.3). */
export const SPACE_GOVERNOR_TYPE = 'SPACE_GOVERNOR_TYPE';

/**
 * Why a dependency is shown as a MISMATCH on the Dependencies panel (reform 2.5: information, never
 * refused): the parent row is gone; the parent governs no space (the governance predicate of WP-D2,
 * `holdsBdeFlagOverSql`, treats it as no parent); the entity reaches a space its parent does not
 * govern; its parent governs none
 * of the spaces it reaches.
 */
export type DependencyMismatch =
  | 'parent_missing'
  | 'parent_governs_nothing'
  | 'reaches_outside_parent'
  | 'parent_governs_none_of_audience';

/**
 * The mismatches of one entity that HAS a parent: `parentExists`, the ids of the spaces its parent
 * governs, the ids of the spaces its own audience reaches.
 */
export function dependencyMismatches(
  parentExists: boolean,
  parentGoverns: readonly string[],
  reaches: readonly string[]
): DependencyMismatch[] {
  if (!parentExists) return ['parent_missing'];
  if (parentGoverns.length === 0) return ['parent_governs_nothing'];
  const out: DependencyMismatch[] = [];
  const governed = new Set(parentGoverns);
  if (reaches.some((id) => !governed.has(id))) out.push('reaches_outside_parent');
  if (reaches.length > 0 && !reaches.some((id) => governed.has(id))) {
    out.push('parent_governs_none_of_audience');
  }
  return out;
}

/** The codes the database itself raises (migration 131), in the CONSTRAINT field of a 23514. */
export const DATABASE_DEPENDENCY_CODES = [
  DEPENDENCY_INSTITUTION,
  DEPENDENCY_CHILD_IS_A_BDE,
  DEPENDENCY_PARENT_NOT_A_BDE,
] as const;
export type DependencyRefusalCode = (typeof DATABASE_DEPENDENCY_CODES)[number];

export type EntityType = 'association' | 'list' | 'institution';

/** What the rules need to know of a would-be child. */
export interface DependencyChild {
  type: EntityType;
  /** Governs at least one space. */
  governs: boolean;
}

/** What the rules need to know of a would-be parent. */
export interface DependencyParent {
  type: EntityType;
  /** Governs at least one space. */
  governs: boolean;
}

/**
 * The one judgement, in the order the database applies it: `null` when `child` may depend on
 * `parent` (no parent is always allowed), the refusal code otherwise. The twin of
 * `canari_dependency_refusal` (migration 131); `dependency-triggers.integration.spec.ts` runs both on
 * the same cases.
 */
export function dependencyRefusal(
  child: DependencyChild,
  parent: DependencyParent | null
): DependencyRefusalCode | null {
  if (parent === null) return null;
  if (child.type === 'institution') return DEPENDENCY_INSTITUTION;
  if (child.governs) return DEPENDENCY_CHILD_IS_A_BDE;
  if (parent.type !== 'association' || !parent.governs) return DEPENDENCY_PARENT_NOT_A_BDE;
  return null;
}

/** The typed 409 a refusal reaches the client as. */
export function dependencyConflict(code: string, message: string): ConflictException {
  return new ConflictException({ code, message });
}

/**
 * The refusal code a database error carries when migration 131's trigger refused the write: a
 * `check_violation` (23514) whose CONSTRAINT field is one of its codes. `null` for any other error -
 * read from the error's structured fields, never from its message.
 */
export function dependencyRefusalOf(err: unknown): DependencyRefusalCode | null {
  const e = err as { code?: unknown; constraint?: unknown; driverError?: unknown } | null;
  const source = (e?.driverError ?? e) as { code?: unknown; constraint?: unknown } | null;
  if (source?.code !== '23514' || typeof source.constraint !== 'string') return null;
  return (DATABASE_DEPENDENCY_CODES as readonly string[]).includes(source.constraint)
    ? (source.constraint as DependencyRefusalCode)
    : null;
}

/**
 * THE ONE MAPPING OF A TRIGGER REFUSAL (F6): runs a write that may touch the dependency axis and
 * turns a refusal of migration 131's triggers - a write that raced the caller's own check, or a door
 * that has none - into the same typed 409, logged at WARN with `context`; any other error passes
 * through untouched. Every writer of `parentAssociationId` or of a space's governor goes through it.
 */
export async function withDependencyRefusals<T>(
  logger: Pick<LoggerService, 'warn'>,
  context: string,
  write: () => Promise<T>
): Promise<T> {
  try {
    return await write();
  } catch (e) {
    const code = dependencyRefusalOf(e);
    if (code === null) throw e;
    logger.warn(`[DEPENDENCY] the database refused ${context}: ${code}`);
    throw dependencyConflict(code, 'This dependency is not allowed');
  }
}
