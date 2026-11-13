import { Logger } from '@nestjs/common';
import { AssociationPermissionFlag } from '../associations/entities/association-member.entity';
import { sameSideOfReviewCohort } from '../review-cohort';
import { formatUserDisplayNameFromRaw } from '../utils/user-display-name';

/** The person a booker may write to about a space: an account id and the name to show. */
export interface SpaceContact {
  userId: string;
  displayName: string;
}

/** What the contact lookup reads: a raw query, so it runs on a repository's manager or a test fake. */
export type ContactQuery = (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>;

const logger = new Logger('BookingContact');

/**
 * WHO IS RESPONSIBLE FOR A SPACE (owner, 2026-11-13): the space's owner when it is personal, and
 * for an association, list or institution THE FIRST MEMBER HOLDING `MANAGE_BOOKINGS`.
 *
 * "First" is the order the entity already shows its team in - `sortOrder` (the president first, as
 * the members grid), then `createdAt` (the longest-standing), then `userId` - so the answer is
 * stable, never changes on a reload and matches what a reader sees on the entity's page. Only a
 * ROW granting the flag counts: a global admin or a BDE super-admin holds it by inheritance and is
 * nobody's named contact.
 *
 * A candidate is skipped when the viewer and they stand on either side of the review-cohort
 * boundary, or when either blocked the other (D21: a DM would be refused, and showing them would
 * say who blocked whom). The viewer is never skipped here - they are told apart on the screen,
 * which shows nobody for their own space. No candidate: `null`, and the screen shows nothing - no
 * fallback contact.
 */
export async function spaceContact(
  query: ContactQuery,
  space: { associationId: string | null; ownerId: string },
  viewerId: string
): Promise<SpaceContact | null> {
  const rows =
    space.associationId === null
      ? await query(
          `SELECT id AS "userId", "displayName", "firstName", "lastName" FROM users WHERE id = $1`,
          [space.ownerId]
        )
      : await query(
          `SELECT m."userId" AS "userId", u."displayName", u."firstName", u."lastName"
             FROM association_members m
             JOIN users u ON u.id = m."userId"
            WHERE m."associationId" = $1 AND (m.permissions & $2) <> 0
            ORDER BY m."sortOrder" ASC, m."createdAt" ASC, m."userId" ASC`,
          [space.associationId, AssociationPermissionFlag.MANAGE_BOOKINGS]
        );
  const candidates = rows
    .filter((r) => typeof r.userId === 'string')
    .map((r) => ({ userId: r.userId as string, name: formatUserDisplayNameFromRaw(r) }))
    .filter((c) => c.name !== '' && sameSideOfReviewCohort(viewerId, c.userId));
  if (candidates.length === 0) {
    logger.debug(
      `[BOOKING_CONTACT] no contact for a space of ${space.associationId ?? 'a person'}`
    );
    return null;
  }
  const blocked = await query(
    `SELECT "blockerId", "blockedId" FROM user_blocks
      WHERE ("blockerId" = $1 AND "blockedId" = ANY($2)) OR ("blockedId" = $1 AND "blockerId" = ANY($2))`,
    [viewerId, candidates.map((c) => c.userId)]
  );
  const barred = new Set(blocked.flatMap((b) => [b.blockerId, b.blockedId]));
  const first = candidates.find((c) => c.userId === viewerId || !barred.has(c.userId));
  if (!first) {
    logger.debug(`[BOOKING_CONTACT] every candidate is blocked with the viewer - none shown`);
    return null;
  }
  return { userId: first.userId, displayName: first.name };
}
