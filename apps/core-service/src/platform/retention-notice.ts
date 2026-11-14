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
 * values it read last until its next read (its next boot, or social-service's next boot, which
 * sends the same notice). The setting itself is saved either way, and the next change notifies again.
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
