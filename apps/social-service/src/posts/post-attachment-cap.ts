import { BadRequestException } from '@nestjs/common';

/**
 * THE CAP ON ATTACHMENTS OF ONE POST (owner, 2026-11-02): TEN, images, videos and documents
 * together. Equal to `libs/contracts/post-attachments.json`, which the spec reads, and mirrored by
 * the composers (`frontend/src/lib/posts/attachmentCap.ts`) so the refusal below is a safety net
 * they normally never reach.
 *
 * It binds WRITES only. A post stored before the cap with more attachments still loads and renders,
 * and can still be edited as long as the edit does not grow it (`assertWithinPostAttachmentCap`).
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

/**
 * Throws the refusal when a write leaves `count` attachments, more than the cap AND more than the
 * post already held (`previous`, 0 for a new post): an old post over the cap may be edited down or
 * left as it is, never grown.
 */
export function assertWithinPostAttachmentCap(count: number, previous = 0): void {
  if (count > POST_ATTACHMENTS_MAX && count > previous) {
    throw postAttachmentsTooManyRefusal(count);
  }
}
