import { Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { ReviewCohortBoundaryException, isInReviewCohort, reviewCohort } from '../review-cohort';

const logger = new Logger('ReviewCohortReach');

/**
 * WHICH ASSOCIATIONS A REVIEW ACCOUNT REACHES: THOSE IT IS A MEMBER OF, AND NO OTHER.
 *
 * The review cohort (`review-cohort.ts`) is never made a member of a real association, so for a
 * review account this closes the shop, the partnerships, the member lists and every purchase on a
 * real association - "Tout fermer" (owner, 2026-10-31). An account outside the cohort is not
 * restricted here: what keeps a member away from the cohort is the profile, follow, message and
 * mention boundary, and an association holds no review account.
 *
 * `null` means no restriction (the account is not a review account); otherwise the ids, among
 * `associationIds`, the account is a member of.
 */
export async function associationsReachedByReviewer(
  manager: Pick<EntityManager, 'query'>,
  userId: string | undefined,
  associationIds: readonly string[]
): Promise<Set<string> | null> {
  if (!isInReviewCohort(userId)) return null;
  if (associationIds.length === 0) return new Set();
  const rows: { associationId: string }[] = await manager.query(
    `SELECT DISTINCT "associationId" FROM association_members
      WHERE "userId" = $1 AND "associationId" = ANY($2::uuid[])`,
    [userId, [...associationIds]]
  );
  return new Set(rows.map((r) => r.associationId));
}

/**
 * Refuses (403 `REVIEW_COHORT_BOUNDARY`) a review account acting on an association it is not a
 * member of - a purchase, a claim, a submission, reading its member list. A no-op for anybody else.
 *
 * @param what The act, for the log line.
 */
export async function assertReviewerReachesAssociation(
  manager: Pick<EntityManager, 'query'>,
  userId: string | undefined,
  associationId: string,
  what: string
): Promise<void> {
  const reached = await associationsReachedByReviewer(manager, userId, [associationId]);
  if (reached === null || reached.has(associationId)) return;
  logger.log(
    `[REVIEW_COHORT] ${what} refused: review account ${userId?.slice(0, 8)} is not a member of association ${associationId.slice(0, 8)}`
  );
  throw new ReviewCohortBoundaryException();
}

/**
 * Refuses (403 `REVIEW_COHORT_BOUNDARY`) making `userId` a member of association `associationId`
 * when its roster already holds anybody on the other side of the cohort's boundary - so an officer
 * can never make a review account a member of a real association, nor a member of the cohort's own.
 * An empty roster refuses nobody: that is how the cohort's fictional association gets its first
 * member.
 */
export async function assertRosterStaysOnOneSide(
  manager: Pick<EntityManager, 'query'>,
  associationId: string,
  userId: string
): Promise<void> {
  const cohort = reviewCohort();
  if (cohort.length === 0) return;
  const rows: unknown[] = await manager.query(
    isInReviewCohort(userId)
      ? `SELECT 1 FROM association_members WHERE "associationId" = $1 AND NOT ("userId" = ANY($2::varchar[])) LIMIT 1`
      : `SELECT 1 FROM association_members WHERE "associationId" = $1 AND "userId" = ANY($2::varchar[]) LIMIT 1`,
    [associationId, [...cohort]]
  );
  if (rows.length === 0) return;
  logger.log(
    `[REVIEW_COHORT] member add refused: association ${associationId.slice(0, 8)} holds the other side of the boundary`
  );
  throw new ReviewCohortBoundaryException('This person cannot be added.');
}
