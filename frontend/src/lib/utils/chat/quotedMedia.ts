import type { MediaRef } from '$lib/media';
import { parseEnvelope } from '$lib/envelope';
import { isReelMessage } from '$lib/reels/chatReel';

/** The quoted attachment and the caption it was sent with, if any. */
export interface QuotedVisual {
  ref: MediaRef;
  caption: string;
}

/**
 * The picture or video a reply QUOTES, found among the messages the thread already holds.
 *
 * A stored quote carries only a text preview ("Photo"), never the media, so drawing a thumbnail
 * needs the quoted message itself - and only the copy already in the thread's list counts: a quote
 * never fetches anything to draw itself (messages are end-to-end encrypted, and a quote is not worth
 * a download). Not found, deleted, not a still or a video, or a CanaReel (a tile that fetches nothing
 * until tapped): `null`, and the quote keeps its text label.
 */
export function quotedVisualMedia(
  messages: Iterable<{ id: string; content: string }>,
  quotedId: string
): QuotedVisual | null {
  for (const msg of messages) {
    if (msg.id !== quotedId) continue;
    const env = parseEnvelope(msg.content);
    if (env.kind !== 'media') return null;
    const ref = env.media;
    if (ref.type !== 'image' && ref.type !== 'video') return null;
    if (isReelMessage(ref) || !ref.mediaId) return null;
    return { ref, caption: env.caption ?? '' };
  }
  return null;
}
