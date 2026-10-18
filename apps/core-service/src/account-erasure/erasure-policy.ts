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

/**
 * Every part of an account erasure, each a durable job of its own.
 *
 * `core` is core-service's OWN data, run in-process ({@link CORE_ERASURE_STATEMENTS}): it is erased
 * once inside the request's transaction, and that is not enough - for up to an hour a token issued
 * before the deletion can still write a block, a correction request or an announcement receipt, and
 * nothing would erase them afterwards. As a job it gets the same final pass as the others. The three
 * others are each one idempotent internal DELETE.
 */
export const ERASURE_TARGETS = [
  { service: 'core', kind: 'local' },
  {
    service: 'chat-delivery',
    kind: 'http',
    url: (subjectId: string) => chatDeliveryUrl(`internal/users/${encodeURIComponent(subjectId)}`),
  },
  {
    service: 'social',
    kind: 'http',
    url: (subjectId: string) => socialUrl(`internal/users/${encodeURIComponent(subjectId)}`),
  },
  {
    service: 'media',
    kind: 'http',
    // Social re-classes the media of the posts that STAY (published as an association) before media
    // deletes what the account uploaded; run first, media would delete them under a live post.
    after: 'social',
    url: (subjectId: string) => mediaUrl(`media/internal/users/${encodeURIComponent(subjectId)}`),
  },
] as const;

/** `[service, after]` for every target that must wait for another part of the SAME subject. */
export const ERASURE_ORDER: ReadonlyArray<readonly [string, string]> = ERASURE_TARGETS.flatMap(
  (t) => ('after' in t ? [[t.service, t.after] as const] : [])
);

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
  // Last, and in the job as well as in the request: nothing nominative is left in `users`.
  { label: 'users', sql: `DELETE FROM users WHERE id = $1` },
];

/**
 * Whether a failure is one a retry can be expected to fix. `permanent` is not "give up" - every job
 * keeps being retried - it is what the report ACCUSES at once and what the sign-in refusal tells the
 * person honestly ("contact us"), instead of waiting a day to find out:
 *
 * - an HTTP 4xx other than 408 and 429: the route refused the request itself - a missing prefix
 *   (404), a secret that does not match (401/403), or a refusal the service classifies as needing a
 *   human (social's 409 `ERASURE_WORKSPACE_REPAIR_FAILED`);
 * - a job naming a service this build does not know (`UNKNOWN_SERVICE`).
 *
 * Everything else - a 5xx, a timeout, a refused connection, a database error in core's own pass - is
 * `transient`: the service was down or busy, and the backoff is the answer.
 */
export type FailureKind = 'transient' | 'permanent';

/** A job naming a service this build has no target for: no retry can complete it. */
export const UNKNOWN_SERVICE = 'UNKNOWN_SERVICE';

export function classifyFailure(err: unknown): FailureKind {
  const e = err as { response?: { status?: number }; code?: string };
  if (e?.code === UNKNOWN_SERVICE) return 'permanent';
  const status = e?.response?.status;
  if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return 'permanent';
  }
  return 'transient';
}

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

/**
 * What a backup restore must carry across, read from the journal BEFORE the database is replaced:
 * the restored journal predates every erasure made after the archive, so without this export a
 * restore silently brings those accounts back (docs/wiki/account-erasure.md#a-restore-replays-the-erasures).
 */
export interface ErasureJournalExport {
  /**
   * One entry per completed subject: its digest, and the LATEST time an erasure of it was requested.
   * The time is what tells the erased account from a NEW one the same person opened afterwards
   * (allowed once every job completed, and under the same id - `users.id` is the OIDC subject).
   */
  completed: Array<{ digest: string; requestedAt: string }>;
  /** Subjects with an erasure still owed - a pending row carries the id itself. */
  pending: string[];
}

/** A subject the restored database still holds, and which the replay must erase again. */
export interface ReplayCandidate {
  subjectId: string;
  /**
   * For a completed erasure: the account is erased again ONLY if its restored row was created
   * before this time - a row created after it is the person's new account, which nobody asked to
   * erase. `null` for a pending erasure, which is replayed whatever the row's age: nobody can sign
   * in while it is pending, so any row under that id is the one being erased.
   */
  requestedBefore: string | null;
}

/**
 * Which of the restored database's accounts the export names. A completed subject is known only
 * by its digest, so every restored id is hashed ({@link subjectDigest}, the one implementation)
 * and matched; a pending one is named outright. Each subject appears once - a person with one part
 * completed and another still owed is a pending subject.
 */
export function replayCandidates(
  journal: ErasureJournalExport,
  restoredUserIds: readonly string[]
): ReplayCandidate[] {
  const candidates = new Map<string, ReplayCandidate>();
  for (const subjectId of journal.pending) {
    candidates.set(subjectId, { subjectId, requestedBefore: null });
  }
  const completed = new Map(journal.completed.map((c) => [c.digest, c.requestedAt]));
  for (const subjectId of restoredUserIds) {
    if (candidates.has(subjectId)) continue;
    const requestedAt = completed.get(subjectDigest(subjectId));
    if (requestedAt !== undefined)
      candidates.set(subjectId, { subjectId, requestedBefore: requestedAt });
  }
  return [...candidates.values()];
}

/** A replay body that is not an {@link ErasureJournalExport}; the reason names the first fault. */
export class MalformedErasureJournalError extends Error {
  readonly code = 'MALFORMED_ERASURE_JOURNAL';
}

/**
 * Checks a replay body is an {@link ErasureJournalExport} and returns it typed. A malformed body is
 * REFUSED rather than replayed in part: a restore that replays half its erasures and says nothing is
 * the defect this whole mechanism exists to prevent.
 */
export function parseErasureJournal(body: unknown): ErasureJournalExport {
  const b = body as { completed?: unknown; pending?: unknown } | null;
  if (!b || !Array.isArray(b.completed) || !Array.isArray(b.pending)) {
    throw new MalformedErasureJournalError('expected { completed: [], pending: [] }');
  }
  for (const c of b.completed as Array<{ digest?: unknown; requestedAt?: unknown }>) {
    if (typeof c?.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(c.digest)) {
      throw new MalformedErasureJournalError('a completed entry has no sha256 digest');
    }
    if (typeof c.requestedAt !== 'string' || Number.isNaN(Date.parse(c.requestedAt))) {
      throw new MalformedErasureJournalError('a completed entry has no requestedAt time');
    }
  }
  for (const p of b.pending) {
    if (typeof p !== 'string' || p.length === 0 || p.startsWith('sha256:')) {
      throw new MalformedErasureJournalError('a pending entry is not a subject id');
    }
  }
  return b as ErasureJournalExport;
}

/**
 * A failure as the journal records it: the status, plus the error CODE a service put in its body
 * (`HTTP 409 ERASURE_WORKSPACE_REPAIR_FAILED`), or the transport's error code - never a URL, which
 * would carry the id. A bare driver error carries its normalised message (see below).
 */
export function describeFailure(err: unknown): string {
  const e = err as {
    response?: { status?: number; data?: { code?: unknown } };
    code?: string;
    name?: string;
  };
  if (e?.response?.status) {
    const code = e.response.data?.code;
    const safe = typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? ` ${code}` : '';
    return `HTTP ${e.response.status}${safe}`;
  }
  if (e?.code) return e.code;
  // No status and no code (a driver error such as `Connection terminated`): the name alone would
  // make every such cause compare identical, so the message joins the fingerprint - with anything
  // that could carry an id (digits, long hex, quoted or parenthesised values) normalised away.
  const name = (e?.name ?? typeof err).slice(0, 40);
  const message = (err as { message?: unknown })?.message;
  if (typeof message !== 'string') return name;
  const normalised = message
    .replace(/\([^)]*\)|"[^"]*"|'[^']*'/g, '?')
    .replace(/[0-9a-f]{8,}/gi, '#')
    .replace(/\d+/g, 'N')
    .slice(0, 80);
  return `${name}: ${normalised}`;
}
