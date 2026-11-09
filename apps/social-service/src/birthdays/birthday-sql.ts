import { sameSideOfReviewCohortSql } from '../spaces/reader-spaces';
import { profileFieldVisibleToSql } from './profile-field-visibility';

/**
 * SQL condition: the ring of the member whose id is `owner` may be shown to `viewer` - the same side
 * of the review cohort's boundary and no block either way. The ring is shown to everybody else on the
 * day, whatever the date's visibility says (decision 3, the owner accepted that the date is then
 * guessable); a block or the cohort boundary is not a visibility choice but the two accounts never
 * meeting, and the ring is an invitation to meet.
 */
export function birthdayRingVisibleToSql(owner: string, viewer: string): string {
  return `(${viewer} = ${owner}
    OR (NOT EXISTS (SELECT 1 FROM user_blocks ring_block
          WHERE (ring_block."blockerId" = ${viewer} AND ring_block."blockedId" = ${owner})
             OR (ring_block."blockerId" = ${owner} AND ring_block."blockedId" = ${viewer}))
        AND ${sameSideOfReviewCohortSql(owner, viewer)}))`;
}

/**
 * SQL condition: birthday row `b` (a `profile_birthdays` row) may be READ - its date - by `viewer`.
 * The one rule every reader of a date asks: the profile route, the followers' notice, and the bell's
 * re-check of that notice (`bellRowShownSql`).
 */
export function birthdayDateVisibleToSql(b: string, viewer: string): string {
  return profileFieldVisibleToSql(`${b}.visibility`, `${b}."userId"`, viewer);
}
