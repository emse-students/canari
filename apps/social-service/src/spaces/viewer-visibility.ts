import { Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { associationVisibleToViewerSql, sharesSpaceWithViewerSql } from './reader-spaces';

const logger = new Logger('ViewerVisibility');

/**
 * ONE ROW, ONE BOOLEAN: the predicate is a scalar `EXISTS`, so its SELECT always answers exactly
 * one row. Anything else is a broken query (or a test double that does not answer it), and reading
 * it as "not visible" would turn that defect into a silent 404 - so it throws instead.
 */
async function askOne(
  manager: Pick<EntityManager, 'query'>,
  predicate: string,
  params: unknown[]
): Promise<boolean> {
  const rows: { visible: boolean }[] = await manager.query(
    `SELECT ${predicate} AS visible`,
    params
  );
  if (rows.length !== 1 || typeof rows[0].visible !== 'boolean') {
    throw new Error(
      `[SPACES] a visibility predicate answered ${rows.length} row(s) instead of one boolean`
    );
  }
  return rows[0].visible;
}

/**
 * Whether association `associationId` is visible to `userId` (`associationVisibleToViewerSql`: a
 * member of it, D21, or its rules reach one of the user's spaces) - the directory's and the
 * agenda's predicate, asked for ONE association by a path that acts on one row by its id (a
 * purchase, a partnership claim, a booking). A review account has no real space, so for it this is
 * membership alone, which is what the review cohort's own narrowing says too.
 */
export async function associationVisibleTo(
  manager: Pick<EntityManager, 'query'>,
  associationId: string,
  userId: string
): Promise<boolean> {
  const visible = await askOne(manager, associationVisibleToViewerSql('$1::uuid', '$2'), [
    associationId,
    userId,
  ]);
  logger.debug(
    `[SPACES] association ${associationId.slice(0, 8)} visible to ${userId.slice(0, 8)}: ${visible}`
  );
  return visible;
}

/**
 * Whether `userId` shares at least one space with `ownerId` (`sharesSpaceWithViewerSql`) - what
 * opens a PERSONAL item to someone who is not its owner. The owner is NOT answered true here by
 * being the owner: the caller decides that on its own rights.
 */
export async function sharesSpaceWith(
  manager: Pick<EntityManager, 'query'>,
  ownerId: string,
  userId: string
): Promise<boolean> {
  const shared = await askOne(manager, sharesSpaceWithViewerSql('$1', '$2'), [ownerId, userId]);
  logger.debug(
    `[SPACES] ${userId.slice(0, 8)} shares a space with ${ownerId.slice(0, 8)}: ${shared}`
  );
  return shared;
}
