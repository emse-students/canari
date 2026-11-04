import { BadRequestException, Logger } from '@nestjs/common';

/**
 * THE "ENTRE ÉTUDIANTS" SWITCH, ITS WRITE SIDE (owner, 2026-11-04; docs/wiki/profiles-and-access.md).
 *
 * Who READS such a post is `studentsOnlyAdmitsUserSql` (`spaces/reader-spaces.ts`), one conjunct of
 * the one visibility predicate. This file holds only what a WRITE must decide: which posts may carry
 * the switch at all.
 */

/**
 * The kinds of entity whose posts may be marked students-only (decisions 1 and 7): an association
 * and a list - never an institution, never a personal post. An ALLOWLIST over
 * `CHK_associations_type` (migration 075): a type added later is refused until it is listed here.
 * Equal to `libs/contracts/students-only.json`, which the composers read too (the spec asserts it).
 */
export const STUDENTS_ONLY_ASSOCIATION_TYPES: readonly string[] = ['association', 'list'];

/** 400 `code`: the switch was asked for on a post that cannot carry it (personal, institution). */
export const STUDENTS_ONLY_NOT_OFFERED = 'students_only_not_offered';

const logger = new Logger('StudentsOnly');

/**
 * Refuses, typed, a `studentsOnly: true` on a post that may not carry it: a personal post
 * (`associationType` null) or an entity whose type is not in {@link STUDENTS_ONLY_ASSOCIATION_TYPES}.
 * Turning the switch OFF is always allowed - it only ever gives a post back to its audience.
 *
 * @param associationType the type of the post's association, `null` for a personal post.
 */
export function assertStudentsOnlyOffered(
  studentsOnly: boolean,
  associationType: string | null
): void {
  if (!studentsOnly) return;
  if (associationType !== null && STUDENTS_ONLY_ASSOCIATION_TYPES.includes(associationType)) {
    return;
  }
  logger.warn(
    `[STUDENTS_ONLY] refused on a ${associationType === null ? 'personal post' : `post of an entity of type ${associationType}`}`
  );
  throw new BadRequestException({
    code: STUDENTS_ONLY_NOT_OFFERED,
    message: 'Only an association or a list may publish a post for students only.',
  });
}
