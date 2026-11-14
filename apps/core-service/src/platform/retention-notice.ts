import type { Logger } from '@nestjs/common';
import { mediaUrl } from '../internal/service-urls';

/** A Docker-network hop: anything slower is a failure, logged. */
export const RETENTION_NOTICE_TIMEOUT_MS = 5_000;

/**
 * Tells media-service that a retention duration changed, so it re-reads and holds the new value
 * (media-service holds the durations in memory and stamps every new file with them -
 * docs/wiki/retention-settings.md). Called after the admin's change is saved; never throws.
 *
 * A failed notice is logged at ERROR, naming what still holds: media-service keeps stamping the
 * values it read last until its next read. The setting itself is saved either way, and the admin
 * page SEES the gap - it compares what media-service holds with the columns
 * ({@link retentionAppliedState}) and offers "Renvoyer" while they differ (re-review of #3521).
 */
export async function notifyMediaRetentionChanged(
  logger: Pick<Logger, 'log' | 'error'>,
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  const url = mediaUrl('media/internal/retention-changed');
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'x-internal-secret': process.env.INTERNAL_SECRET ?? '' },
      signal: AbortSignal.timeout(RETENTION_NOTICE_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => null)) as { refreshed?: unknown } | null;
    if (res.ok && body?.refreshed === true) {
      logger.log('[RETENTION] media-service re-read the retention durations');
      return true;
    }
    logger.error(
      `[RETENTION] media-service did NOT take the new retention durations (HTTP ${res.status}, refreshed=${String(body?.refreshed)}): it stamps the values it read last until its next read`
    );
    return false;
  } catch (e) {
    logger.error(
      `[RETENTION] the notice to media-service failed (${e instanceof Error ? e.message : String(e)}): it stamps the values it read last until its next read`
    );
    return false;
  }
}

/** The two durations media-service stamps, as it reports holding them. */
export type MediaHeldRetention = { chatReelDays: number; idleFileDays: number };

/**
 * Why media-service ANSWERED without the durations it holds - an answer, never a transport failure
 * (CLAUDE.md: a status code is an answer): `secret` a 401/403 (the internal secret is misconfigured),
 * `route` a 404 (an older media-service without the route, during a deploy), `malformed` a 2xx whose
 * body is not the shape, `status` any other refusal.
 */
export type MediaRefusalReason = 'secret' | 'route' | 'malformed' | 'status';

/** What asking media-service for the durations it holds gave. */
export type MediaRetentionReport =
  /** It answered: its values (`null` before its first read) and when it read them. */
  | { kind: 'held'; held: MediaHeldRetention | null; readAt: string | null }
  /** It answered, and the answer is not the durations: the status and why. */
  | { kind: 'refused'; status: number; reason: MediaRefusalReason }
  /** No answer: the request did not complete (connection, DNS, timeout). */
  | { kind: 'unreachable'; cause: string };

/** The reason a non-2xx status from media-service names. */
function refusalReason(status: number): MediaRefusalReason {
  if (status === 401 || status === 403) return 'secret';
  if (status === 404) return 'route';
  return 'status';
}

/**
 * Asks media-service which durations it HOLDS (`GET /api/media/internal/retention`). It logs
 * nothing: the caller logs a CHANGE of the state it derives, never each ask. Never throws.
 */
export async function readMediaRetentionHeld(
  fetchImpl: typeof fetch = fetch
): Promise<MediaRetentionReport> {
  let res: Response;
  try {
    res = await fetchImpl(mediaUrl('media/internal/retention'), {
      headers: { 'x-internal-secret': process.env.INTERNAL_SECRET ?? '' },
      signal: AbortSignal.timeout(RETENTION_NOTICE_TIMEOUT_MS),
    });
  } catch (e) {
    return { kind: 'unreachable', cause: e instanceof Error ? e.message : String(e) };
  }
  if (!res.ok) return { kind: 'refused', status: res.status, reason: refusalReason(res.status) };
  const body = (await res.json().catch(() => undefined)) as
    | { held?: { chatReelDays?: unknown; idleFileDays?: unknown } | null; readAt?: unknown }
    | undefined;
  const malformed = { kind: 'refused', status: res.status, reason: 'malformed' } as const;
  if (!body || typeof body !== 'object' || !('held' in body)) return malformed;
  const readAt = typeof body.readAt === 'string' ? body.readAt : null;
  const { held } = body;
  if (held === null) return { kind: 'held', held: null, readAt };
  if (!held || typeof held.chatReelDays !== 'number' || typeof held.idleFileDays !== 'number') {
    return malformed;
  }
  return {
    kind: 'held',
    held: { chatReelDays: held.chatReelDays, idleFileDays: held.idleFileDays },
    readAt,
  };
}

/**
 * Whether new conversation files are stamped with the durations the platform holds: `refused` and
 * `unreachable` say only that media-service could not tell, each for its own reason.
 */
export type RetentionAppliedState = 'applied' | 'behind' | 'refused' | 'unreachable';

/**
 * THE VERSION IS THE VALUES THEMSELVES: media-service is up to date exactly when the durations it
 * holds EQUAL the columns. A counter would answer "has it read since the last write", which a change
 * and its undo (30 -> 7 -> 30, the 7 lost) gets wrong in the other direction; the values answer the
 * question the admin asks - "are new files stamped with what I set" - with no new column.
 * Nothing held yet is `behind`: media-service refuses conversation uploads until it reads.
 */
export function retentionAppliedState(
  configured: MediaHeldRetention,
  media: MediaRetentionReport
): RetentionAppliedState {
  if (media.kind !== 'held') return media.kind;
  const { held } = media;
  if (
    held &&
    held.chatReelDays === configured.chatReelDays &&
    held.idleFileDays === configured.idleFileDays
  ) {
    return 'applied';
  }
  return 'behind';
}
