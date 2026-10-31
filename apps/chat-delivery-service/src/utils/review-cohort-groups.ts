import { Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import {
  ReviewCohortBoundaryException,
  isInReviewCohort,
  reviewCohort,
  sameSideOfReviewCohort,
} from '../review-cohort';

const logger = new Logger('ReviewCohortGroups');

/**
 * NO CONVERSATION EVER HOLDS A REVIEW ACCOUNT AND A MEMBER (`review-cohort.ts`, owner 2026-10-31).
 *
 * Every way a person enters a conversation ends in this service - opening a 1-to-1 or a group
 * (adding a member), accepting an invitation link, a member's Add admitting an asker - so the
 * boundary is held at those mutations, exactly where a block is: hiding a review account from the
 * search stops nobody who already knows an id. A conversation that held both before the rule
 * existed is not touched here; it is closed by the operator, the way the app leaves one.
 */

/**
 * Whether `groupId` already holds, at any seat, a member on the other side of the cohort's
 * boundary from `userId`. With no cohort configured, never.
 */
export async function groupCrossesReviewCohortFor(
  manager: Pick<EntityManager, 'query'>,
  groupId: string,
  userId: string
): Promise<boolean> {
  const cohort = reviewCohort();
  if (cohort.length === 0) return false;
  const rows: unknown[] = await manager.query(
    isInReviewCohort(userId)
      ? `SELECT 1 FROM dm_group_members WHERE "groupId" = $1 AND NOT ("userId" = ANY($2::varchar[])) LIMIT 1`
      : `SELECT 1 FROM dm_group_members WHERE "groupId" = $1 AND "userId" = ANY($2::varchar[]) LIMIT 1`,
    [groupId, [...cohort]]
  );
  return rows.length > 0;
}

/**
 * Refuses (403 `REVIEW_COHORT_BOUNDARY`) putting `userId` into `groupId` when the person asking
 * (`actorId`, absent for a self-join) or anybody already in the group stands on the other side of
 * the cohort's boundary.
 *
 * @param scope The mutation, for the log line.
 */
export async function assertGroupStaysOnOneSide(
  manager: Pick<EntityManager, 'query'>,
  groupId: string,
  userId: string,
  actorId: string | undefined,
  scope: string
): Promise<void> {
  const acrossActor = !!actorId && !sameSideOfReviewCohort(actorId, userId);
  if (acrossActor || (await groupCrossesReviewCohortFor(manager, groupId, userId))) {
    logger.log(
      `[REVIEW_COHORT] ${scope} REFUSED group=${groupId} user=${userId.slice(0, 8)}: across the review cohort's boundary`
    );
    throw new ReviewCohortBoundaryException('This person cannot be added.');
  }
}
