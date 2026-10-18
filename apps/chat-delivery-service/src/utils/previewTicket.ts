import { InternalServerErrorException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';

/**
 * The secret every ticket is HMAC'd with.
 *
 * `INTERNAL_SHARED_SECRET` is the same secret `HeaderAuthGuard` verifies nginx's per-minute token
 * with, and `env-from-prod.sh` regenerates it for every estate, so it is present wherever this
 * service runs. It FAILS CLOSED when it is not: a ticket nobody can verify is a route nobody can
 * refuse, which is the state this replaced.
 */
export function requireTicketSecret(): string {
  const secret = process.env.INTERNAL_SHARED_SECRET?.trim();
  if (!secret) {
    throw new InternalServerErrorException(
      'INTERNAL_SHARED_SECRET is not configured - an image ticket cannot be minted or verified'
    );
  }
  return secret;
}

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

/**
 * The GIF relay's bucket: a DAY, not five minutes, and the reason is the reader's HTTP cache.
 *
 * The ticket rides in the `<img src>`, so it is part of the URL the browser caches under. A
 * five-minute ticket gave every GIF a new URL every five minutes - each conversation reopened, each
 * GIF scrolled back into a remounted row, downloaded again, up to 12 MiB a time on a phone's data.
 * What the ticket protects on `mls/gifs/media` is narrower than on the preview route (one allowlisted
 * CDN, not any URL), so a day-long window costs little and keeps the browser's cache working.
 */
export const GIF_MEDIA_TICKET_BUCKET_MS = 24 * 60 * 60 * 1000;

/**
 * What one kind of ticket is: the label its HMAC is taken over and how long a bucket lasts. The
 * label is what keeps two kinds apart - a link-preview ticket is never a GIF ticket, nor the reverse,
 * nor either the per-minute internal token, which is HMAC'd with the same secret over
 * `${userId}:${minute}`.
 */
interface TicketKind {
  label: string;
  bucketMs: number;
}

const PREVIEW_IMAGE: TicketKind = {
  label: 'link-preview-image',
  bucketMs: PREVIEW_TICKET_BUCKET_MS,
};
const GIF_MEDIA: TicketKind = { label: 'gif-media', bucketMs: GIF_MEDIA_TICKET_BUCKET_MS };

/** The bucket `at` falls in. Exported so a test can name a bucket rather than wait for one. */
export function previewTicketBucket(at: number): number {
  return Math.floor(at / PREVIEW_TICKET_BUCKET_MS);
}

/** The ticket of `kind` for `bucket`, as hex. */
function sign(secret: string, kind: TicketKind, bucket: number): string {
  return createHmac('sha256', secret).update(`${kind.label}:${bucket}`).digest('hex');
}

/**
 * Mints a ticket of `kind`, and says when it stops being minted at the earliest.
 *
 * `expiresInMs` is the remainder of the CURRENT bucket, never the full two-bucket window: handing
 * back the optimistic figure would have clients refresh at the moment their ticket is already in
 * its grace period, which is the same defect as a cache that reports the age it wishes it had.
 */
function mint(
  secret: string,
  kind: TicketKind,
  now: number
): { ticket: string; expiresInMs: number } {
  const bucket = Math.floor(now / kind.bucketMs);
  return { ticket: sign(secret, kind, bucket), expiresInMs: (bucket + 1) * kind.bucketMs - now };
}

/**
 * Whether `ticket` is a `kind` ticket of the current or the previous bucket.
 *
 * The previous bucket is accepted so that a ticket obtained one millisecond before a boundary is
 * not refused one millisecond after it - the same reason `HeaderAuthGuard` accepts two minutes of
 * its own token. Comparison is constant-time: the value is an HMAC, and an HMAC compared with
 * `===` tells its caller how much of a guess was right.
 */
function verify(ticket: unknown, secret: string, kind: TicketKind, now: number): boolean {
  if (typeof ticket !== 'string' || ticket.length === 0) return false;
  const bucket = Math.floor(now / kind.bucketMs);
  return [bucket, bucket - 1].some((b) => {
    const expected = sign(secret, kind, b);
    try {
      return timingSafeEqual(Buffer.from(ticket, 'hex'), Buffer.from(expected, 'hex'));
    } catch {
      // A non-hex ticket, or one of the wrong length: `timingSafeEqual` throws rather than
      // returning false, and a refusal is the answer either way.
      return false;
    }
  });
}

/** Mints the ticket `mls/link-preview/image` accepts - see {@link mint}. */
export function mintPreviewTicket(
  secret: string,
  now: number = Date.now()
): { ticket: string; expiresInMs: number } {
  return mint(secret, PREVIEW_IMAGE, now);
}

/** Whether `ticket` opens `mls/link-preview/image` now - see {@link verify}. */
export function verifyPreviewTicket(
  ticket: unknown,
  secret: string,
  now: number = Date.now()
): boolean {
  return verify(ticket, secret, PREVIEW_IMAGE, now);
}

/** Mints the ticket `mls/gifs/media` accepts (a day-long bucket, {@link GIF_MEDIA_TICKET_BUCKET_MS}). */
export function mintGifMediaTicket(
  secret: string,
  now: number = Date.now()
): { ticket: string; expiresInMs: number } {
  return mint(secret, GIF_MEDIA, now);
}

/** Whether `ticket` opens `mls/gifs/media` now - see {@link verify}. */
export function verifyGifMediaTicket(
  ticket: unknown,
  secret: string,
  now: number = Date.now()
): boolean {
  return verify(ticket, secret, GIF_MEDIA, now);
}
