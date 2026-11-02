import { BadRequestException } from '@nestjs/common';

/**
 * THE CAP ON ATTACHMENTS OF ONE POST (owner, 2026-11-02): TEN, images, videos and documents
 * together. Equal to `libs/contracts/post-attachments.json`, which the spec reads, and mirrored by
 * the composers (`frontend/src/lib/posts/attachmentCap.ts`) so the refusal below is a safety net
 * they normally never reach.
 *
 * It binds WRITES only: a stored post with more would still load and render. None exists - measured
 * on production on 2026-11-02, 0 of 213 posts held more than 10 (the maximum is 6), and 0 on dev - so
 * there is no exception for an edit: any write over the cap is refused, create or edit alike.
 */
export const POST_ATTACHMENTS_MAX = 10;

/** The stable code the client maps to its own sentence - never the message. */
export const POST_ATTACHMENTS_TOO_MANY = 'POST_ATTACHMENTS_TOO_MANY';

/** The refusal of a write that would leave a post with more than {@link POST_ATTACHMENTS_MAX}. */
export function postAttachmentsTooManyRefusal(count: number): BadRequestException {
  return new BadRequestException({
    code: POST_ATTACHMENTS_TOO_MANY,
    max: POST_ATTACHMENTS_MAX,
    message: `A post has at most ${POST_ATTACHMENTS_MAX} attachments (asked for ${count}).`,
  });
}

/** Throws the refusal when a write leaves `count` attachments, more than {@link POST_ATTACHMENTS_MAX}. */
export function assertWithinPostAttachmentCap(count: number): void {
  if (count > POST_ATTACHMENTS_MAX) throw postAttachmentsTooManyRefusal(count);
}
