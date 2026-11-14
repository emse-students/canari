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
 * What media-service HOLDS right now (`GET /api/media/internal/retention`): its values and when it
 * read them, `held: null` before its first successful read, or `'unreachable'` when it could not be
 * asked (logged at warn). Never throws.
 */
export async function readMediaRetentionHeld(
  logger: Pick<Logger, 'warn'>,
  fetchImpl: typeof fetch = fetch
): Promise<{ held: MediaHeldRetention | null; readAt: string | null } | 'unreachable'> {
  try {
    const res = await fetchImpl(mediaUrl('media/internal/retention'), {
      headers: { 'x-internal-secret': process.env.INTERNAL_SECRET ?? '' },
      signal: AbortSignal.timeout(RETENTION_NOTICE_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn(`[RETENTION] media-service answered ${res.status} for the durations it holds`);
      return 'unreachable';
    }
    const body = (await res.json()) as {
      held?: { chatReelDays?: unknown; idleFileDays?: unknown } | null;
      readAt?: unknown;
    };
    const held = body?.held;
    const readAt = typeof body?.readAt === 'string' ? body.readAt : null;
    if (held === null || held === undefined) return { held: null, readAt };
    if (typeof held.chatReelDays !== 'number' || typeof held.idleFileDays !== 'number') {
      logger.warn('[RETENTION] media-service reported durations that are not numbers');
      return 'unreachable';
    }
    return { held: { chatReelDays: held.chatReelDays, idleFileDays: held.idleFileDays }, readAt };
  } catch (e) {
    logger.warn(
      `[RETENTION] media-service could not be asked which durations it holds: ${e instanceof Error ? e.message : String(e)}`
    );
    return 'unreachable';
  }
}

/** Whether new conversation files are stamped with the durations the platform holds. */
export type RetentionAppliedState = 'applied' | 'behind' | 'unreachable';

/**
 * THE VERSION IS THE VALUES THEMSELVES: media-service is up to date exactly when the durations it
 * holds EQUAL the columns. A counter would answer "has it read since the last write", which a change
 * and its undo (30 -> 7 -> 30, the 7 lost) gets wrong in the other direction; the values answer the
 * question the admin asks - "are new files stamped with what I set" - with no new column.
 * Nothing held yet is `behind`: media-service refuses conversation uploads until it reads.
 */
export function retentionAppliedState(
  configured: MediaHeldRetention,
  media: { held: MediaHeldRetention | null } | 'unreachable'
): RetentionAppliedState {
  if (media === 'unreachable') return 'unreachable';
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
