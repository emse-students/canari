import type { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { mediaUrl } from './service-urls';

/** Matches the media service's own bound on one internal batch. */
const BATCH_SIZE = 500;

const internalHeaders = () => ({ 'x-internal-secret': process.env.INTERNAL_SECRET ?? '' });

/**
 * What `POST media/internal/reel-purge` (and `chat-reel-purge`) answers for one object - see
 * `MediaService.purgeReels`. `released` is a success: the post's hold went, and a conversation's
 * chat hold keeps the file (reels-in-chat 15.3).
 */
export type ReelPurgeOutcome = 'deleted' | 'released' | 'absent' | 'refused' | 'failed';

/**
 * Why a reel's life ends (reels-in-chat 15.4): `moderation` purges the file with every hold on it,
 * so a take also sent to conversations is erased there too (the owner's choice); `author` (the
 * post's own delete) and `retention` (its 30 days) release the post's hold alone (D-postdelete).
 */
export type ReelPurgeReason = 'moderation' | 'author' | 'retention';

/** Worse outcomes rank higher: one id listed twice keeps the outcome it did NOT earn twice. */
const OUTCOME_RANK: Record<ReelPurgeOutcome, number> = {
  absent: 0,
  released: 1,
  deleted: 2,
  refused: 3,
  failed: 4,
};

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
 * Ends blobs, each on its owner's say-so (the media service's allowlist is ownership), for the
 * REASON named, and returns ONE outcome per media id. An id listed twice under different owners
 * keeps the WORSE outcome, so a caller never reads a success that one of the entries did not earn.
 *
 * THROWS on a transport or HTTP failure of a batch. Throwing and not returning "failed" per id is
 * deliberate: the caller already treats a thrown error as "this reel's blobs are not known to be
 * gone", logs it once, and keeps the row.
 */
export async function purgeReelMedia(
  http: HttpService,
  items: Array<{ mediaId: string; ownerId: string }>,
  reason: ReelPurgeReason
): Promise<Record<string, ReelPurgeOutcome>> {
  return postPurgeBatches(http, 'media/internal/reel-purge', items, { reason });
}

/**
 * A salon MODERATOR's purge of reel files that salon's messages declare (reels-in-chat 15.4):
 * `ownerId` is each row's proven author, and the media service deletes only a file that author
 * uploaded AND a conversation holds - every hold at once, so every conversation and the feed read
 * `410` after. Outcomes and throwing as {@link purgeReelMedia}.
 */
export async function purgeChatReelMedia(
  http: HttpService,
  items: Array<{ mediaId: string; ownerId: string }>
): Promise<Record<string, ReelPurgeOutcome>> {
  return postPurgeBatches(http, 'media/internal/chat-reel-purge', items, {});
}

/** One POST per batch of {@link BATCH_SIZE}, the outcomes merged worst-first. */
async function postPurgeBatches(
  http: HttpService,
  path: string,
  items: Array<{ mediaId: string; ownerId: string }>,
  extra: Record<string, string>
): Promise<Record<string, ReelPurgeOutcome>> {
  const out: Record<string, ReelPurgeOutcome> = Object.create(null);
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const res = await firstValueFrom(
      http.post<{ results: Record<string, ReelPurgeOutcome> }>(
        mediaUrl(path),
        { items: items.slice(i, i + BATCH_SIZE), ...extra },
        { headers: internalHeaders() }
      )
    );
    for (const [id, outcome] of Object.entries(res.data?.results ?? {})) {
      const previous = out[id];
      if (previous === undefined || OUTCOME_RANK[outcome] > OUTCOME_RANK[previous]) {
        out[id] = outcome;
      }
    }
  }
  return out;
}
