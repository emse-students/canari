import { createHmac } from 'crypto';

import {
  GIF_MEDIA_TICKET_BUCKET_MS,
  PREVIEW_TICKET_BUCKET_MS,
  mintGifMediaTicket,
  mintPreviewTicket,
  previewTicketBucket,
  verifyGifMediaTicket,
  verifyPreviewTicket,
} from './previewTicket';

const SECRET = 'a-shared-secret-for-tests';

/** A time inside a bucket, far from its edges, so a test says what it means to say. */
const MID_BUCKET = 7 * PREVIEW_TICKET_BUCKET_MS + PREVIEW_TICKET_BUCKET_MS / 2;

describe('previewTicket', () => {
  it('accepts the ticket it just minted', () => {
    const { ticket } = mintPreviewTicket(SECRET, MID_BUCKET);
    expect(verifyPreviewTicket(ticket, SECRET, MID_BUCKET)).toBe(true);
  });

  it('refuses a ticket minted with another secret', () => {
    const { ticket } = mintPreviewTicket('somebody-elses-secret', MID_BUCKET);
    expect(verifyPreviewTicket(ticket, SECRET, MID_BUCKET)).toBe(false);
  });

  it('refuses a value that is not a ticket at all', () => {
    // `timingSafeEqual` THROWS on a length mismatch and on a non-hex buffer rather than answering
    // false, so each of these would be a 500 on the image route if the throw were not caught.
    for (const value of ['', 'not-hex', 'ab', undefined, null, 42, {}]) {
      expect(verifyPreviewTicket(value, SECRET, MID_BUCKET)).toBe(false);
    }
  });

  it('still accepts a ticket from the PREVIOUS bucket, and refuses the one before that', () => {
    const { ticket } = mintPreviewTicket(SECRET, MID_BUCKET);

    // One bucket on: the grace window that stops a ticket obtained a millisecond before a boundary
    // from being refused a millisecond after it.
    expect(verifyPreviewTicket(ticket, SECRET, MID_BUCKET + PREVIEW_TICKET_BUCKET_MS)).toBe(true);
    // Two buckets on: expired.
    expect(verifyPreviewTicket(ticket, SECRET, MID_BUCKET + 2 * PREVIEW_TICKET_BUCKET_MS)).toBe(
      false
    );
  });

  it('reports the remainder of the CURRENT bucket, never the two-bucket window', () => {
    const quarter = PREVIEW_TICKET_BUCKET_MS / 4;
    const at = previewTicketBucket(MID_BUCKET) * PREVIEW_TICKET_BUCKET_MS + quarter;

    // Handing back the optimistic figure would have a client refresh at the moment its ticket is
    // already inside its grace period - the same defect as a cache reporting the age it wishes for.
    expect(mintPreviewTicket(SECRET, at).expiresInMs).toBe(PREVIEW_TICKET_BUCKET_MS - quarter);
  });

  it('cannot be replayed as the per-minute internal token, and the reverse', () => {
    // Both are HMAC-SHA256 over the SAME secret, so what separates them has to be the message.
    const bucket = previewTicketBucket(MID_BUCKET);
    const internalTokenShape = createHmac('sha256', SECRET)
      .update(`a-user-id:${bucket}`)
      .digest('hex');

    expect(mintPreviewTicket(SECRET, MID_BUCKET).ticket).not.toBe(internalTokenShape);
    expect(verifyPreviewTicket(internalTokenShape, SECRET, MID_BUCKET)).toBe(false);
  });

  it('gives every bucket a different ticket', () => {
    const a = mintPreviewTicket(SECRET, MID_BUCKET).ticket;
    const b = mintPreviewTicket(SECRET, MID_BUCKET + PREVIEW_TICKET_BUCKET_MS).ticket;
    expect(a).not.toBe(b);
  });

  it('keeps the link-preview ticket byte-identical to what clients already hold', () => {
    // The refactor into kinds must not change the preview HMAC's message, or every ticket in a
    // client at deploy time is refused for up to ten minutes.
    const bucket = previewTicketBucket(MID_BUCKET);
    const expected = createHmac('sha256', SECRET)
      .update(`link-preview-image:${bucket}`)
      .digest('hex');
    expect(mintPreviewTicket(SECRET, MID_BUCKET).ticket).toBe(expected);
  });
});

describe('the GIF relay ticket', () => {
  const MID_DAY = 400 * GIF_MEDIA_TICKET_BUCKET_MS + GIF_MEDIA_TICKET_BUCKET_MS / 2;

  it('is accepted for its day and the next, and refused after', () => {
    const { ticket } = mintGifMediaTicket(SECRET, MID_DAY);
    expect(verifyGifMediaTicket(ticket, SECRET, MID_DAY)).toBe(true);
    expect(verifyGifMediaTicket(ticket, SECRET, MID_DAY + GIF_MEDIA_TICKET_BUCKET_MS)).toBe(true);
    expect(verifyGifMediaTicket(ticket, SECRET, MID_DAY + 2 * GIF_MEDIA_TICKET_BUCKET_MS)).toBe(
      false
    );
  });

  it('does not change for a whole day, so a GIF keeps ONE URL in the browser cache', () => {
    const early = MID_DAY - GIF_MEDIA_TICKET_BUCKET_MS / 2 + 1;
    const late = MID_DAY + GIF_MEDIA_TICKET_BUCKET_MS / 2 - 1;
    expect(mintGifMediaTicket(SECRET, early).ticket).toBe(mintGifMediaTicket(SECRET, late).ticket);
  });

  it('never opens the other route: the two kinds are not interchangeable', () => {
    const gif = mintGifMediaTicket(SECRET, MID_DAY).ticket;
    const preview = mintPreviewTicket(SECRET, MID_DAY).ticket;
    expect(verifyPreviewTicket(gif, SECRET, MID_DAY)).toBe(false);
    expect(verifyGifMediaTicket(preview, SECRET, MID_DAY)).toBe(false);
  });
});
