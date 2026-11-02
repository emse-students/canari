/**
 * A CanaReel RECEIVED IN A CONVERSATION (`MediaMsg.intent = REEL_MESSAGE`), as the reader draws it:
 * a tile, a tap, the reel viewer, and a tombstone once the blob is gone
 * ([reels-in-chat](docs/wiki/frontend/modules/reels-in-chat.md)).
 *
 * Pure functions: the clock is passed in, so a test never asserts a wall clock.
 */
import type { MediaRef } from '$lib/media';
import type { PostEntity } from '$lib/posts/api';

/**
 * Whether a media ref is a reel message. The intent is DECLARED by the sender, so a picked clip
 * (the same bytes) is never one, and a ref with an intent this client does not know has had it
 * dropped at decode and is an ordinary video.
 */
export function isReelMessage(ref: Pick<MediaRef, 'type' | 'intent'> | null | undefined): boolean {
  return !!ref && ref.type === 'video' && ref.intent === 'reel-message';
}

/**
 * Whether the tile draws its tombstone WITHOUT a request: the sender's `expiresAtMs` hint has
 * passed. A hint, never the authority - the server sweeps on its own clock and answers 410 to
 * whoever asks. No hint is no tombstone.
 */
export function isReelMessageExpired(ref: Pick<MediaRef, 'expiresAtMs'>, nowMs: number): boolean {
  return typeof ref.expiresAtMs === 'number' && ref.expiresAtMs > 0 && ref.expiresAtMs <= nowMs;
}

/**
 * Which tombstone a reel message's tile draws, or `null` while it is still watchable.
 *
 * - `deleted` ("CanaReel supprime"): the blob answered `410` BEFORE the sender's expiry hint - an
 *   early loss (a moderator's purge in another conversation that shares the file, the sender's
 *   delete, an account deletion). The REASON is never drawn: a DM is not told a salon was moderated.
 * - `expired` ("CanaReel expire"): the hint has passed, or the `410` came after it.
 *
 * Two facts decide, in this order: the `410` THIS device met and recorded on the message's local
 * row (`purgedAtMs`, the instant it was met), then the hint read against `nowMs`. A `410` on a
 * message with NO hint reads `expired`: every writer sets the hint (`chatReelDeclaration`), so a
 * hint-less reel is from no shipped writer and the neutral reading is the class's ordinary end.
 * Pure: both instants are passed in.
 */
export type ReelTombstone = 'deleted' | 'expired';

/** See {@link ReelTombstone}: the purge instant this device recorded first, then the hint. */
export function reelTombstoneOf(
  ref: Pick<MediaRef, 'expiresAtMs'>,
  purgedAtMs: number | null | undefined,
  nowMs: number
): ReelTombstone | null {
  if (typeof purgedAtMs === 'number' && purgedAtMs > 0) {
    const hinted = typeof ref.expiresAtMs === 'number' && ref.expiresAtMs > 0;
    return hinted && !isReelMessageExpired(ref, purgedAtMs) ? 'deleted' : 'expired';
  }
  return isReelMessageExpired(ref, nowMs) ? 'expired' : null;
}

/**
 * The post-shaped entity the reel viewer plays for a received reel message. The viewer is the
 * feed's (`ReelViewer`), so the message is given the one shape it reads: the video with its key,
 * the sender's name, the day it was sent and the caption.
 *
 * No `authorId` is set, and nothing in the viewer asks the server about this id: it is the
 * message's id, the key of the slide and the file name of a save.
 */
export function reelMessageAsPost(input: {
  messageId: string;
  media: MediaRef;
  caption: string;
  senderName: string;
  sentAt: Date;
}): PostEntity {
  const iso = input.sentAt.toISOString();
  return {
    id: input.messageId,
    kind: 'reel',
    markdown: input.caption,
    mentions: [],
    links: [],
    media: [input.media],
    images: [],
    polls: [],
    authorDisplayName: input.senderName,
    createdAt: iso,
    publishedAt: iso,
    updatedAt: iso,
  } as PostEntity;
}
