import { createHash } from 'node:crypto';
import { chatDeliveryUrl, mediaUrl, socialUrl } from '../internal/service-urls';

/**
 * WHAT AN ACCOUNT ERASURE OWES, AND WHEN EACH PART OF IT IS DONE - the pure half of
 * `AccountErasureService`, so every decision is testable without a database or a clock.
 *
 * The decision of 2026-10-16: deleting an account is COMPLETE and GUARANTEED, not best effort.
 * Before it, core called the three services once each with `.catch(warn)` and deleted the user row
 * regardless, so a service that happened to be down orphaned that account's data for ever. Now each
 * service is a durable job, retried with backoff until it answers 2xx. The mechanism and every
 * disposition are on docs/wiki/account-erasure.md.
 */

/** The services that hold an account's data, each erased by one idempotent internal DELETE. */
export const ERASURE_TARGETS = [
  {
    service: 'chat-delivery',
    url: (subjectId: string) => chatDeliveryUrl(`internal/users/${encodeURIComponent(subjectId)}`),
  },
  {
    service: 'social',
    url: (subjectId: string) => socialUrl(`internal/users/${encodeURIComponent(subjectId)}`),
  },
  {
    service: 'media',
    url: (subjectId: string) => mediaUrl(`media/internal/users/${encodeURIComponent(subjectId)}`),
  },
] as const;

export type ErasureService = (typeof ERASURE_TARGETS)[number]['service'];

/** The account id written in place of an erased one, as the other services spell it. */
export const DELETED_ACCOUNT = '[deleted]';

/** `platform_announcements.created_by` is a UUID column, so the erased author is the nil UUID. */
export const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * What core-service itself holds about an account, erased in the SAME transaction that records the
 * jobs and deletes the user row - so the request either deactivates the account completely or
 * changes nothing. `$1` is the account id; a statement naming `$2` gets the replacement value.
 *
 * Erasure wins over the audit trail (decision 2026-10-16): `profile_changes` and
 * `profile_correction_requests` hold whole before/after profiles and the person's own words, and go
 * with the account; where the erased account was the ADMIN who acted on somebody else, the row is
 * that other person's history and keeps it, without the admin's id.
 */
export const CORE_ERASURE_STATEMENTS: readonly {
  label: string;
  sql: string;
  replacement?: string;
}[] = [
  {
    label: 'user_blocks',
    sql: `DELETE FROM user_blocks WHERE "blockerId" = $1 OR "blockedId" = $1`,
  },
  { label: 'profile_changes', sql: `DELETE FROM profile_changes WHERE "userId" = $1` },
  {
    label: 'profile_changes_actor',
    sql: `UPDATE profile_changes SET "actorId" = $2 WHERE "actorId" = $1`,
    replacement: DELETED_ACCOUNT,
  },
  {
    label: 'profile_corrections',
    sql: `DELETE FROM profile_correction_requests WHERE "userId" = $1`,
  },
  {
    label: 'profile_corrections_resolver',
    sql: `UPDATE profile_correction_requests SET "resolvedBy" = $2 WHERE "resolvedBy" = $1`,
    replacement: DELETED_ACCOUNT,
  },
  // `user_id` is a UUID column; compared as text so an id that is not a UUID matches nothing
  // instead of failing the whole transaction.
  {
    label: 'announcement_seen',
    sql: `DELETE FROM platform_announcement_seen WHERE user_id::text = $1`,
  },
  {
    label: 'announcement_author',
    sql: `UPDATE platform_announcements SET created_by = $2::uuid WHERE created_by::text = $1`,
    replacement: NIL_UUID,
  },
  // The refresh tokens die here, so no session can be renewed from this moment.
  { label: 'auth_sessions', sql: `DELETE FROM auth_sessions WHERE "userId" = $1` },
];

/**
 * How long after a failed attempt the next one is due: 30 s, doubling, capped at 6 h.
 *
 * The cap keeps a service that was down for a day from being retried only once a week, and the
 * floor keeps a blip from costing a person more than a minute.
 */
export function retryDelayMs(failedAttempts: number): number {
  const base = 30_000;
  const cap = 6 * 60 * 60 * 1000;
  return Math.min(cap, base * 2 ** Math.max(0, failedAttempts - 1));
}

/**
 * What a SUCCESSFUL call settles. The job is complete only when the call STARTED after every token
 * the account held had expired - from then on no request can act as that account, so nothing can
 * be written after the call that it did not see. A success before that moment is real, and is
 * followed by exactly one more call at `credentialsExpireAt`: a termination proved by the token's
 * own expiry, not guessed by a timer.
 */
export function afterSuccess(
  startedAt: Date,
  credentialsExpireAt: Date
): { kind: 'complete' } | { kind: 'final-pass'; at: Date } {
  return startedAt.getTime() >= credentialsExpireAt.getTime()
    ? { kind: 'complete' }
    : { kind: 'final-pass', at: credentialsExpireAt };
}

/**
 * The journal's form of a completed subject: a SHA-256 digest, so a finished job keeps when it ran
 * and which service it reached, and stops carrying the id itself. A pending job needs the real id -
 * it is what the call is made with, and what the sign-in refusal looks up.
 */
export function subjectDigest(subjectId: string): string {
  return `sha256:${createHash('sha256').update(subjectId).digest('hex')}`;
}

/** A failure as the journal records it: the status or the error code, never a URL or a body. */
export function describeFailure(err: unknown): string {
  const e = err as { response?: { status?: number }; code?: string; name?: string };
  if (e?.response?.status) return `HTTP ${e.response.status}`;
  if (e?.code) return e.code;
  return (e?.name ?? typeof err).slice(0, 100);
}
