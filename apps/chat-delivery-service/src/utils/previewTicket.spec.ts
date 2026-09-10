import { createHmac } from 'crypto';

import {
  PREVIEW_TICKET_BUCKET_MS,
  mintPreviewTicket,
  previewTicketBucket,
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
});
