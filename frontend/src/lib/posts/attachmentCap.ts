import { m } from '$lib/paraglide/messages';
import { Log } from '$lib/utils/Log';

/**
 * THE CAP ON ATTACHMENTS OF ONE POST (owner, 2026-11-02): TEN, images, videos and documents
 * together. A post of several PDFs used to be a column the length of the feed.
 *
 * Mirrors `POST_ATTACHMENTS_MAX` of social-service (`posts/post-attachment-cap.ts`), which refuses
 * the overflow with {@link POST_ATTACHMENTS_TOO_MANY}; both sides' specs assert their constants
 * against `libs/contracts/post-attachments.json`, so they cannot drift. The composers stop at the
 * cap first, so the server's refusal is a safety net a form normally never reaches. It binds
 * WRITES only: a stored post with more still renders.
 */
export const POST_ATTACHMENTS_MAX = 10;

/** The server's stable code for a post written with too many attachments. */
export const POST_ATTACHMENTS_TOO_MANY = 'POST_ATTACHMENTS_TOO_MANY';

/** What a batch of picked files comes to once the cap is applied. */
export interface AdmittedAttachments<T> {
  /** As many of `incoming`, in order, as still fit. */
  accepted: T[];
  /** How many did not fit and were dropped. */
  leftOut: number;
}

/**
 * Takes as many of `incoming` as fit under the cap beside the `held` attachments already on the post.
 *
 * @param held Attachments the post already carries (kept ones and pending ones alike).
 * @param incoming The files just picked, dropped, pasted or filmed.
 */
export function admitAttachments<T>(held: number, incoming: T[]): AdmittedAttachments<T> {
  const room = Math.max(0, POST_ATTACHMENTS_MAX - held);
  const accepted = incoming.slice(0, room);
  return { accepted, leftOut: incoming.length - accepted.length };
}

/** Whether another attachment may be added. */
export function attachmentsFull(held: number): boolean {
  return held >= POST_ATTACHMENTS_MAX;
}

/**
 * The sentence for a batch the cap trimmed or refused, or null when everything fit.
 *
 * @param admitted The result of {@link admitAttachments}.
 */
export function attachmentCapNotice<T>(admitted: AdmittedAttachments<T>): string | null {
  if (admitted.leftOut === 0) return null;
  Log.d(
    'POST_COMPOSER',
    `attachment cap: ${admitted.leftOut} left out, ${admitted.accepted.length} taken`
  );
  return admitted.accepted.length === 0
    ? m.post_attachments_full({ max: POST_ATTACHMENTS_MAX })
    : m.post_attachments_partial({
        taken: admitted.accepted.length,
        leftOut: admitted.leftOut,
        max: POST_ATTACHMENTS_MAX,
      });
}
