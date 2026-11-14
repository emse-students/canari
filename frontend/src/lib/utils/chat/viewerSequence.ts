import { isReelMessage, isReelMessageExpired } from '$lib/reels/chatReel';
import type { SharedMediaItem } from '$lib/utils/chat/sharedContent';

/** The identity of one viewable item: a message id alone would not tell two attachments apart. */
export function viewerItemKey(item: Pick<SharedMediaItem, 'messageId' | 'media'>): string {
  return `${item.messageId}:${item.media.mediaId}`;
}

/**
 * The images and videos a conversation's viewer walks through, OLDEST FIRST (left = previous =
 * older, right = next = newer, as a gallery reads).
 *
 * It is built only from rows the client ALREADY holds (`aggregateSharedContent` over the local
 * history): reaching further back is a network fetch the viewer must never trigger. Left out: a
 * CanaReel sent in the chat (a tile with its own viewer, never a chat video), a media whose
 * sender's expiry hint has passed and one this device already met a `410` for - the viewer would
 * open on a spinner or a failure box in the middle of a swipe.
 *
 * @param media the items in any order (the aggregate is newest first)
 * @param nowMs the clock, injected so the expiry rule is testable without a wall clock
 */
export function buildViewerSequence(media: SharedMediaItem[], nowMs: number): SharedMediaItem[] {
  return media
    .filter(
      (item) =>
        (item.media.type === 'image' || item.media.type === 'video') &&
        !isReelMessage(item.media) &&
        !item.purgedAt &&
        !isReelMessageExpired(item.media, nowMs)
    )
    .sort((a, b) => a.timestamp - b.timestamp || a.messageId.localeCompare(b.messageId));
}

/**
 * Which way the viewer can still move from `index`. NO WRAP-AROUND: the newest media wrapping to the
 * oldest would jump across the whole conversation on one stray swipe, and an end that stops tells
 * the reader there is nothing further (a gallery's own convention).
 */
export function viewerBounds(
  length: number,
  index: number
): { showPrev: boolean; showNext: boolean } {
  return { showPrev: index > 0, showNext: index >= 0 && index < length - 1 };
}
