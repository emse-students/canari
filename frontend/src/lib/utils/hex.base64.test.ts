/**
 * Base64 of a queued attachment: the chunked encoder and the loop decoder must stay byte-identical
 * to the platform's `btoa`/`atob`, across the 32 KiB slice boundary the encoder works in.
 */
import { decodeOutboxEntry } from '$lib/db/outboxCodec';
import { fromBase64, toBase64 } from './hex';

function patterned(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) bytes[i] = (i * 31 + (i >> 8)) & 0xff;
  return bytes;
}

/**
 * The platform's own base64 of `bytes`, built from 32 KiB slices: one string per byte, joined, cost a
 * million-element array and timed out under a loaded full run.
 */
function referenceBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** The first index where `a` and `b` differ, or -1 - a byte loop, not two deep-compared copies. */
function firstDifference(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

describe('toBase64 / fromBase64', () => {
  it.each([0, 1, 2, 3, 32767, 32768, 32769, 65536 + 5, 1_000_003])(
    'round-trips %i bytes and matches btoa',
    (n) => {
      const bytes = patterned(n);
      const encoded = toBase64(bytes);
      expect(encoded).toBe(referenceBase64(bytes));
      expect(firstDifference(fromBase64(encoded), bytes)).toBe(-1);
    }
  );

  it('decodes a legacy inline attachment through the outbox codec unchanged', () => {
    const fileBytes = patterned(200_000);
    // A row written before attachments moved to the blob store: inline base64, still readable.
    const payload = {
      media: {
        kind: 4,
        mimeType: 'application/pdf',
        size: fileBytes.length,
        fileBytesB64: toBase64(fileBytes),
      },
    };
    const clear = {
      id: 'm1',
      conversationId: 'c1',
      sentAt: 1,
      kind: 'media',
      status: 'pending',
      attempts: 0,
      createdAt: 1,
    } as const;
    const back = decodeOutboxEntry({ ...clear }, JSON.parse(JSON.stringify(payload)));
    expect(back.media?.fileBytes).toEqual(fileBytes);
  });
});
