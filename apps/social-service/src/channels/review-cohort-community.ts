import type { EntityManager } from 'typeorm';
import { isInReviewCohort, reviewCohort, sameSideOfReviewCohort } from '../review-cohort';

/**
 * Whether community `workspaceId` holds, on its roster, anybody on the other side of the review
 * cohort's boundary from `userId` (`review-cohort.ts`). With no cohort configured, never.
 *
 * NO COMMUNITY EVER HOLDS A REVIEW ACCOUNT AND A MEMBER ("Tout fermer", owner 2026-10-31): an
 * invitation link and a salon invitation ask this before they seat anybody.
 */
export async function communityCrossesReviewCohortFor(
  manager: Pick<EntityManager, 'query'>,
  workspaceId: string,
  userId: string
): Promise<boolean> {
  const cohort = reviewCohort();
  if (cohort.length === 0) return false;
  const rows: unknown[] = await manager.query(
    isInReviewCohort(userId)
      ? `SELECT 1 FROM channel_members WHERE "workspaceId" = $1 AND NOT ("userId" = ANY($2::varchar[])) LIMIT 1`
      : `SELECT 1 FROM channel_members WHERE "workspaceId" = $1 AND "userId" = ANY($2::varchar[]) LIMIT 1`,
    [workspaceId, [...cohort]]
  );
  return rows.length > 0;
}

/**
 * Whether `userId` stands on the other side of the review cohort's boundary from the CREATOR of
 * community `workspaceId` - the key-group entitlement's question, so a roster row written before the
 * rule can never be used to join (`isWorkspaceMember`, `isChannelReader`).
 *
 * The creator's side, and not "anybody on the other side", because a crossing roster is exactly the
 * pre-rule state this closes: refusing everybody in it would take a real community's keys from its
 * own members for one stray row. The community belongs to its creator's side; the other side loses
 * it. A community whose creator is gone (no row) refuses nobody here.
 */
export async function communityIsAcrossReviewCohortFor(
  manager: Pick<EntityManager, 'query'>,
  workspaceId: string,
  userId: string
): Promise<boolean> {
  if (reviewCohort().length === 0) return false;
  const rows: { createdBy: string }[] = await manager.query(
    `SELECT "createdBy" FROM channel_workspaces WHERE id = $1`,
    [workspaceId]
  );
  const creator = rows[0]?.createdBy;
  return !!creator && !sameSideOfReviewCohort(creator.toLowerCase(), userId.toLowerCase());
}
