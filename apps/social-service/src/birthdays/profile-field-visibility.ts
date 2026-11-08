import { BadRequestException } from '@nestjs/common';
import { acceptedFollowSql } from '../follows/follow-status';
import { sameSideOfReviewCohortSql } from '../spaces/reader-spaces';

/**
 * WHO MAY READ ONE FIELD OF A MEMBER'S PROFILE - the rule the member chooses, per field.
 *
 * Decided by the owner for the birthday (2026-11-08) as "the same mechanism as the other profile
 * fields": everyone at the school, the member's followers, or nobody. No profile field had a
 * per-field rule before - the MiConnect fields and the bio are readable by whoever may open the
 * profile - so this module IS that mechanism, written once, and a later field that gains a choice
 * stores one of these values and asks {@link profileFieldVisibleToSql}. docs/wiki/birthdays.md.
 *
 * - `school`: every account that may open the profile - same side of the review cohort's boundary
 *   (`review-cohort.ts`) and no block between the two, either way;
 * - `followers`: of those, the member's ACCEPTED followers (`acceptedFollowSql`; a pending request
 *   opens nothing, every personal account being private);
 * - `nobody`: the member alone.
 *
 * The member always reads their own field. A platform admin is a reader like any other: a field the
 * member hid is not an admin's to read.
 */
export type ProfileFieldVisibility = 'school' | 'followers' | 'nobody';

/** The closed set, in the order the settings screen offers it. */
export const PROFILE_FIELD_VISIBILITIES: readonly ProfileFieldVisibility[] = [
  'school',
  'followers',
  'nobody',
];

/** The typed refusal code of a value outside {@link PROFILE_FIELD_VISIBILITIES}. */
export const PROFILE_FIELD_VISIBILITY_INVALID = 'PROFILE_FIELD_VISIBILITY_INVALID';

/** Narrows an untrusted value to a visibility, or throws a 400 typed {@link PROFILE_FIELD_VISIBILITY_INVALID}. */
export function parseProfileFieldVisibility(value: unknown): ProfileFieldVisibility {
  if ((PROFILE_FIELD_VISIBILITIES as readonly unknown[]).includes(value)) {
    return value as ProfileFieldVisibility;
  }
  throw new BadRequestException({
    code: PROFILE_FIELD_VISIBILITY_INVALID,
    message: `visibility must be one of ${PROFILE_FIELD_VISIBILITIES.join(', ')}`,
  });
}

/**
 * SQL condition: the viewer whose id is the expression `viewer` may read a field of the member whose
 * id is `owner`, stored with the visibility expression `visibility`. The expressions are the
 * caller's (a column, a bound parameter) and never text from a request.
 *
 * STATE, NEVER A STORED COPY: an unfollow, a removal from the followers, a block or a change of the
 * choice is read on the next query - nothing has to be revoked. The block is checked here, both
 * directions, rather than trusted to the follow severing a block performs best-effort.
 */
export function profileFieldVisibleToSql(
  visibility: string,
  owner: string,
  viewer: string
): string {
  return `(${viewer} = ${owner}
    OR (${visibility} IN ('school', 'followers')
      AND NOT EXISTS (SELECT 1 FROM user_blocks pfv_block
        WHERE (pfv_block."blockerId" = ${viewer} AND pfv_block."blockedId" = ${owner})
           OR (pfv_block."blockerId" = ${owner} AND pfv_block."blockedId" = ${viewer}))
      AND ${sameSideOfReviewCohortSql(owner, viewer)}
      AND (${visibility} = 'school'
        OR EXISTS (SELECT 1 FROM user_follows pfv_follow
          WHERE pfv_follow."followedUserId" = ${owner} AND pfv_follow."followerUserId" = ${viewer}
            AND ${acceptedFollowSql('pfv_follow')}))))`;
}
