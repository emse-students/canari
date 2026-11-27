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
  byId: ReadonlyMap<string, { content: string }>,
  quotedId: string
): QuotedVisual | null {
  const msg = byId.get(quotedId);
  if (!msg) return null;
  // Answered per CONTENT and kept, so an original that did not change yields the SAME object: a
  // reply is not handed a new `quotedMedia` on every thread update, and its deriveds do not re-run.
  const known = answers.get(msg.content);
  if (known !== undefined) return known;
  const answer = visualOf(msg.content);
  if (answers.size >= ANSWERS_MAX) answers.clear();
  answers.set(msg.content, answer);
  return answer;
}

const ANSWERS_MAX = 500;
const answers = new Map<string, QuotedVisual | null>();

function visualOf(content: string): QuotedVisual | null {
  const env = parseEnvelope(content);
  if (env.kind !== 'media') return null;
  const ref = env.media;
  if (ref.type !== 'image' && ref.type !== 'video') return null;
  if (isReelMessage(ref) || !ref.mediaId) return null;
  return { ref, caption: env.caption ?? '' };
}

/**
 * The id of the message a row answers: the in-memory reference when the row has one (a send this
 * session, a live delivery), else the one its stored body carries. A row read back from the store
 * has NO `replyTo` field - the reference lives in its envelope - so reading the field alone drew the
 * quote's thumbnail before a restart and not after it. `undefined` for a row that answers nothing.
 */
export function quotedIdOf(msg: { content: string; replyTo?: { id: string } }): string | undefined {
  if (msg.replyTo) return msg.replyTo.id;
  // Answered per CONTENT, like `quotedVisualMedia`: the thread asks for every row at every render.
  if (quotedIds.has(msg.content)) return quotedIds.get(msg.content);
  const env = parseEnvelope(msg.content);
  const id = env.kind === 'text' || env.kind === 'media' ? env.replyTo?.id : undefined;
  if (quotedIds.size >= ANSWERS_MAX) quotedIds.clear();
  quotedIds.set(msg.content, id);
  return id;
}

const quotedIds = new Map<string, string | undefined>();
