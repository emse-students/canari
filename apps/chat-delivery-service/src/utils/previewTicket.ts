import { createHmac, timingSafeEqual } from 'crypto';

/**
 * A SHORT-LIVED TICKET, BECAUSE AN `<img>` CANNOT CARRY A BEARER TOKEN.
 *
 * `GET mls/link-preview/image` is put straight into an `<img src>`: the browser makes that request
 * itself, and a subresource request carries no `Authorization` header - on `tauri://localhost` it
 * carries no cookie either. So the route cannot be closed with a guard the way its two JSON
 * siblings can, and leaving it open made Canari an image proxy for anybody who could name a URL
 * (measured 2026-09-10: 5430 bytes of a Google favicon relayed with no session at all).
 *
 * The discriminator is therefore carried to where the decision is made, which is the standing rule:
 * an AUTHENTICATED call mints a ticket, and the image route verifies the ticket instead of the
 * session. Nothing about the caller is encoded in it - it says only "somebody with a session asked
 * for this recently", which is exactly the fact the image route needs and the only one it can act
 * on.
 *
 * It is a time bucket rather than stored state, for the same reason the internal token is: a value
 * that has to be looked up is a value that has to be written, expired and replicated, and none of
 * that buys anything here.
 */

/** How long one bucket lasts. Two buckets are accepted, so a ticket is valid for 5 to 10 minutes. */
export const PREVIEW_TICKET_BUCKET_MS = 5 * 60 * 1000;

/** The bucket `at` falls in. Exported so a test can name a bucket rather than wait for one. */
export function previewTicketBucket(at: number): number {
  return Math.floor(at / PREVIEW_TICKET_BUCKET_MS);
}

/**
 * The ticket for `bucket`, as hex.
 *
 * The message is prefixed with this ticket's own name so that a value minted here can never be
 * mistaken for - or replayed as - the per-minute internal token, which is HMAC'd with the same
 * secret over `${userId}:${minute}`.
 */
function sign(secret: string, bucket: number): string {
  return createHmac('sha256', secret).update(`link-preview-image:${bucket}`).digest('hex');
}

/**
 * Mints a ticket for the caller, and says when it stops being accepted at the earliest.
 *
 * `expiresInMs` is the remainder of the CURRENT bucket, never the full two-bucket window: handing
 * back the optimistic figure would have clients refresh at the moment their ticket is already in
 * its grace period, which is the same defect as a cache that reports the age it wishes it had.
 */
export function mintPreviewTicket(
  secret: string,
  now: number = Date.now()
): { ticket: string; expiresInMs: number } {
  const bucket = previewTicketBucket(now);
  return {
    ticket: sign(secret, bucket),
    expiresInMs: (bucket + 1) * PREVIEW_TICKET_BUCKET_MS - now,
  };
}

/**
 * Whether `ticket` was minted for the current or the previous bucket.
 *
 * The previous bucket is accepted so that a ticket obtained one millisecond before a boundary is
 * not refused one millisecond after it - the same reason `HeaderAuthGuard` accepts two minutes of
 * its own token. Comparison is constant-time: the value is an HMAC, and an HMAC compared with
 * `===` tells its caller how much of a guess was right.
 */
export function verifyPreviewTicket(
  ticket: unknown,
  secret: string,
  now: number = Date.now()
): boolean {
  if (typeof ticket !== 'string' || ticket.length === 0) return false;
  const bucket = previewTicketBucket(now);
  return [bucket, bucket - 1].some((b) => {
    const expected = sign(secret, b);
    try {
      return timingSafeEqual(Buffer.from(ticket, 'hex'), Buffer.from(expected, 'hex'));
    } catch {
      // A non-hex ticket, or one of the wrong length: `timingSafeEqual` throws rather than
      // returning false, and a refusal is the answer either way.
      return false;
    }
  });
}
