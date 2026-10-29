/**
 * The status of a follow of a PERSON (`user_follows.status`, migration 114, WP-F1).
 *
 * Every personal account is private (user, 2026-10-25, Q1): following a person writes a `pending`
 * request, and only the person's answer makes it `accepted`. A follow of an association, a list or
 * an institution (`association_follows`) has no status and needs no answer.
 */
export type FollowStatus = 'pending' | 'accepted';

/** The status of a request nobody has answered yet: what every new follow of a person writes. */
export const FOLLOW_PENDING: FollowStatus = 'pending';

/** The status that makes a row a follow: the only one any reader of `user_follows` may count. */
export const FOLLOW_ACCEPTED: FollowStatus = 'accepted';

/**
 * SQL condition: the `user_follows` row aliased `alias` is an ACCEPTED follow. Every SQL reader of
 * the table that means "X follows Y" ANDs it in - the announce sweep, the republication's
 * newly-reached rule and the live push - so a pending request reaches nothing a follow would.
 */
export function acceptedFollowSql(alias: string): string {
  return `${alias}.status = '${FOLLOW_ACCEPTED}'`;
}
