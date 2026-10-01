import type { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { mediaUrl } from './service-urls';

/** Matches the media service's own bound on one internal batch. */
const BATCH_SIZE = 500;

const internalHeaders = () => ({ 'x-internal-secret': process.env.INTERNAL_SECRET ?? '' });

/** What `POST media/internal/reel-purge` answers for one object - see `MediaService.purgeReels`. */
export type ReelPurgeOutcome = 'deleted' | 'absent' | 'refused' | 'failed';

/**
 * Asks the media service to classify `mediaIds` as `reel` FOR `ownerId`, which it does only for
 * objects that member uploaded. The answer is the proof the caller needs that a reel cites the
 * author's own blob.
 *
 * It THROWS on a transport or HTTP failure and returns nothing partial: a caller that cannot tell
 * whether a blob is the author's must not store the reel, and a swallowed failure here would be a
 * reel stored on trust. The caller turns it into the right status.
 */
export async function claimReelMedia(
  http: HttpService,
  mediaIds: string[],
  ownerId: string
): Promise<{ claimed: string[]; refused: string[] }> {
  const claimed: string[] = [];
  const refused: string[] = [];
  const unique = [...new Set(mediaIds)];
  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const res = await firstValueFrom(
      http.post<{ claimed: string[]; refused: string[] }>(
        mediaUrl('media/internal/reel-claim'),
        { mediaIds: unique.slice(i, i + BATCH_SIZE), ownerId },
        { headers: internalHeaders() }
      )
    );
    claimed.push(...(res.data?.claimed ?? []));
    refused.push(...(res.data?.refused ?? []));
  }
  return { claimed, refused };
}

/**
 * Deletes blobs, each on its owner's say-so (the media service's allowlist is ownership), and
 * returns ONE outcome per media id. An id listed twice under different owners keeps the WORSE
 * outcome, so a caller never reads a success that one of the entries did not earn.
 *
 * THROWS on a transport or HTTP failure of a batch. Throwing and not returning "failed" per id is
 * deliberate: the caller already treats a thrown error as "this reel's blobs are not known to be
 * gone", logs it once, and keeps the row.
 */
export async function purgeReelMedia(
  http: HttpService,
  items: Array<{ mediaId: string; ownerId: string }>
): Promise<Record<string, ReelPurgeOutcome>> {
  const rank: Record<ReelPurgeOutcome, number> = { absent: 0, deleted: 1, refused: 2, failed: 3 };
  const out: Record<string, ReelPurgeOutcome> = Object.create(null);
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const res = await firstValueFrom(
      http.post<{ results: Record<string, ReelPurgeOutcome> }>(
        mediaUrl('media/internal/reel-purge'),
        { items: items.slice(i, i + BATCH_SIZE) },
        { headers: internalHeaders() }
      )
    );
    for (const [id, outcome] of Object.entries(res.data?.results ?? {})) {
      const previous = out[id];
      if (previous === undefined || rank[outcome] > rank[previous]) out[id] = outcome;
    }
  }
  return out;
}
