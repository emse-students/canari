import type { Logger } from '@nestjs/common';
import type { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { mediaUrl } from './service-urls';

/**
 * The media service's retention classes, as social-service names them.
 *
 * The media service's idle sweep is an ALLOWLIST: it deletes `ephemeral` objects and nothing else.
 * `archive` (feed media) and `association` (vault documents) are kept for ever; `association` also
 * survives the uploader's account deletion. The authoritative description is `RetentionClass` in
 * `apps/media-service/src/media/media.service.ts`.
 */
export type MediaRetentionClass = 'ephemeral' | 'archive' | 'association';

/** Matches the media service's own bound on one `internal/retention-class` batch. */
const BATCH_SIZE = 500;

/**
 * Sets the retention class of existing media objects, in batches the media service accepts.
 *
 * Best-effort by contract and LOUD about it: every caller is either a boot backfill (re-applied at
 * the next boot) or a side effect of a user's write that must not fail it. A failure is logged at
 * `warn` with the class and the batch size, never swallowed.
 *
 * @param http      The caller's HttpService.
 * @param logger    The caller's logger, so the line names the service that asked.
 * @param mediaIds  Ids to classify; duplicates are collapsed.
 * @param retentionClass The class to set.
 * @returns the number of entries the media service actually changed, or `null` if a batch failed.
 */
export async function applyMediaRetentionClass(
  http: HttpService,
  logger: Logger,
  mediaIds: string[],
  retentionClass: MediaRetentionClass
): Promise<number | null> {
  const unique = [...new Set(mediaIds)];
  let changed = 0;

  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const batch = unique.slice(i, i + BATCH_SIZE);
    try {
      const res = await firstValueFrom(
        http.post<{ changed: number }>(
          mediaUrl('media/internal/retention-class'),
          { mediaIds: batch, retentionClass },
          { headers: { 'x-internal-secret': process.env.INTERNAL_SECRET ?? '' } }
        )
      );
      changed += res.data?.changed ?? 0;
    } catch (err) {
      logger.warn(
        `Retention class '${retentionClass}' failed for ${batch.length} object(s): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return null;
    }
  }

  return changed;
}
