/**
 * Base64 of a queued attachment: the chunked encoder and the loop decoder must stay byte-identical
 * to the platform's `btoa`/`atob`, across the 32 KiB slice boundary the encoder works in.
 */
import { decodeOutboxEntry, encodeOutboxSensitive } from '$lib/db/outboxCodec';
import { fromBase64, toBase64 } from './hex';

function patterned(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) bytes[i] = (i * 31 + (i >> 8)) & 0xff;
  return bytes;
}

describe('toBase64 / fromBase64', () => {
  it.each([0, 1, 2, 3, 32767, 32768, 32769, 65536 + 5, 1_000_003])(
    'round-trips %i bytes and matches btoa',
    (n) => {
      const bytes = patterned(n);
      const expected = btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));
      const encoded = toBase64(bytes);
      expect(encoded).toBe(expected);
      expect(Array.from(fromBase64(encoded))).toEqual(Array.from(bytes));
    }
  );

  it('carries a queued attachment through the outbox codec unchanged', () => {
    const fileBytes = patterned(200_000);
    const payload = encodeOutboxSensitive({
      id: 'm1',
      conversationId: 'c1',
      sentAt: 1,
      kind: 'media',
      media: { kind: 4, mimeType: 'application/pdf', size: fileBytes.length, fileBytes },
      status: 'pending',
      attempts: 0,
      createdAt: 1,
    });
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
