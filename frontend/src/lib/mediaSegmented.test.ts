/**
 * The segmented media format, written and read back - and every way the bytes can lie refused.
 *
 * The writer here is the production one (`encryptSegmentedMedia`), only with a small segment size so
 * a few kilobytes make several segments. What is asserted is STREAM's promise: a reader either gets
 * exactly the file that was sealed or a typed refusal - never a shorter file, a reordered one, or
 * one with a byte changed - and the refusal says which fault it is, so no caller reads a message.
 */
import { encryptMediaBuffer } from '$lib/mediaCrypto';
import {
  SEGMENTED_MEDIA_HEADER_BYTES,
  SEGMENTED_MEDIA_WRITER_ENABLED,
  SEGMENT_TAG_BYTES,
  SegmentedMediaError,
  decryptSegmentedMediaBuffer,
  encodeSegmentedHeader,
  encryptSegmentedMedia,
  parseSegmentedHeader,
  segmentCiphertextRange,
  segmentIndexForPlaintextOffset,
  segmentNonce,
  segmentedCiphertextLength,
  writesSegmented,
} from '$lib/mediaSegmented';
import {
  memoryRangeSource,
  openSegmentedMedia,
  type CiphertextRangeSource,
} from '$lib/utils/segmentedMediaReader';

const SEGMENT = 4096;

/** `n` bytes that differ from one position to the next, so a misplaced segment cannot pass. */
function plaintextOf(n: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) bytes[i] = (i * 31 + (i >> 12)) & 0xff;
  return bytes;
}

async function seal(n: number) {
  const plain = plaintextOf(n);
  const sealed = await encryptSegmentedMedia(plain.buffer, SEGMENT);
  return { plain, ...sealed, bytes: new Uint8Array(sealed.ciphertext) };
}

async function faultOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(SegmentedMediaError);
    return (e as SegmentedMediaError).fault;
  }
  throw new Error('expected a refusal');
}

describe('the reader release writes nothing segmented', () => {
  it('keeps the writer off, for video and everything else', () => {
    expect(SEGMENTED_MEDIA_WRITER_ENABLED).toBe(false);
    expect(writesSegmented('video/mp4')).toBe(false);
    expect(writesSegmented('image/webp')).toBe(false);
  });
});

describe('the layout', () => {
  it('is the header, then each segment sealed with its tag', async () => {
    const { bytes } = await seal(3 * SEGMENT + 100);
    expect(bytes.byteLength).toBe(
      SEGMENTED_MEDIA_HEADER_BYTES + 3 * SEGMENT + 100 + 4 * SEGMENT_TAG_BYTES
    );
    expect(bytes.byteLength).toBe(segmentedCiphertextLength(3 * SEGMENT + 100, SEGMENT));
    const header = parseSegmentedHeader(bytes);
    expect(header.segmentCount).toBe(4);
    expect(header.plaintextLength).toBe(3 * SEGMENT + 100);
    expect(segmentCiphertextRange(header, 3)).toEqual([
      SEGMENTED_MEDIA_HEADER_BYTES + 3 * (SEGMENT + SEGMENT_TAG_BYTES),
      bytes.byteLength,
    ]);
  });

  it('seeks to the one segment that holds an offset', () => {
    const header = parseSegmentedHeader(encodeSegmentedHeader(SEGMENT, 3 * SEGMENT + 100));
    expect(segmentIndexForPlaintextOffset(header, 0)).toBe(0);
    expect(segmentIndexForPlaintextOffset(header, SEGMENT - 1)).toBe(0);
    expect(segmentIndexForPlaintextOffset(header, SEGMENT)).toBe(1);
    expect(segmentIndexForPlaintextOffset(header, 10 * SEGMENT)).toBe(3);
  });

  it('binds the index and the final flag into the nonce, and nothing else of the IV past 7 bytes', () => {
    const iv = new Uint8Array(12).fill(0xaa);
    expect([...segmentNonce(iv, 0, false)]).toEqual([
      0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0, 0, 0, 0, 0,
    ]);
    expect([...segmentNonce(iv, 258, true)]).toEqual([
      0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0, 0, 1, 2, 1,
    ]);
  });
});

describe('a round trip', () => {
  it.each([
    ['an empty file', 0],
    ['less than one segment', 100],
    ['exactly one segment', SEGMENT],
    ['exactly three segments', 3 * SEGMENT],
    ['three segments and a bit', 3 * SEGMENT + 1],
  ])('gives back %s exactly', async (_label, n) => {
    const { plain, ciphertext, keyHex, ivHex } = await seal(n);
    const out = new Uint8Array(await decryptSegmentedMediaBuffer(ciphertext, keyHex, ivHex));
    expect(out).toEqual(plain);
  });

  it('hands each verified segment on in order as it goes', async () => {
    const { ciphertext, keyHex, ivHex } = await seal(2 * SEGMENT + 5);
    const seen: [number, number][] = [];
    await decryptSegmentedMediaBuffer(ciphertext, keyHex, ivHex, (p, i) =>
      seen.push([i, p.byteLength])
    );
    expect(seen).toEqual([
      [0, SEGMENT],
      [1, SEGMENT],
      [2, 5],
    ]);
  });

  it('reads segment by segment through ranges, out of order, as a seek does', async () => {
    const { plain, bytes, keyHex, ivHex } = await seal(3 * SEGMENT + 7);
    const reads: [number, number][] = [];
    const inner = memoryRangeSource(bytes);
    const source: CiphertextRangeSource = {
      read(start, end) {
        reads.push([start, end]);
        return inner.read(start, end);
      },
    };
    const reader = await openSegmentedMedia(source, keyHex, ivHex);
    expect(reader.segmentCount).toBe(4);
    const target = reader.segmentForOffset(2 * SEGMENT + 10);
    expect(new Uint8Array(await reader.readSegment(target))).toEqual(
      plain.slice(2 * SEGMENT, 3 * SEGMENT)
    );
    expect(new Uint8Array(await reader.readSegment(0))).toEqual(plain.slice(0, SEGMENT));
    expect(new Uint8Array(await reader.readSegment(3))).toEqual(plain.slice(3 * SEGMENT));
    // The opening read is one range from byte 0; a seek reads its one segment and nothing before it.
    expect(reads[0][0]).toBe(0);
    expect(reads[1]).toEqual(segmentCiphertextRange(reader.header, 2));
  });
});

describe('what the bytes cannot get past', () => {
  it('refuses a TRUNCATED blob, even cut exactly at a segment boundary', async () => {
    const { bytes, keyHex, ivHex } = await seal(3 * SEGMENT + 7);
    const header = parseSegmentedHeader(bytes);
    const cut = bytes.slice(0, segmentCiphertextRange(header, 2)[1]);
    expect(await faultOf(decryptSegmentedMediaBuffer(cut.buffer, keyHex, ivHex))).toBe('length');

    // The streaming reader meets the same cut when it asks for the segment that is not there.
    const reader = await openSegmentedMedia(memoryRangeSource(cut), keyHex, ivHex);
    expect(await faultOf(reader.readSegment(3))).toBe('length');
  });

  it('refuses a truncated blob whose header was rewritten to match - the final flag catches it', async () => {
    const { bytes, keyHex, ivHex } = await seal(3 * SEGMENT + 7);
    const header = parseSegmentedHeader(bytes);
    // Drop the last segment AND claim the file was three segments long: every length now agrees,
    // but the header is every segment's AAD and segment 2 was sealed as NOT final.
    const cut = bytes.slice(0, segmentCiphertextRange(header, 2)[1]);
    cut.set(encodeSegmentedHeader(SEGMENT, 3 * SEGMENT), 0);
    expect(await faultOf(decryptSegmentedMediaBuffer(cut.buffer, keyHex, ivHex))).toBe(
      'segment-auth'
    );
  });

  it('refuses REORDERED segments', async () => {
    const { bytes, keyHex, ivHex } = await seal(3 * SEGMENT);
    const header = parseSegmentedHeader(bytes);
    const [a0, a1] = segmentCiphertextRange(header, 0);
    const [b0, b1] = segmentCiphertextRange(header, 1);
    const swapped = bytes.slice();
    swapped.set(bytes.slice(b0, b1), a0);
    swapped.set(bytes.slice(a0, a1), b0);
    const err = await decryptSegmentedMediaBuffer(swapped.buffer, keyHex, ivHex).catch((e) => e);
    expect(err).toBeInstanceOf(SegmentedMediaError);
    expect(err.fault).toBe('segment-auth');
    expect(err.segmentIndex).toBe(0);
  });

  it('refuses a TAMPERED segment and names it', async () => {
    const { bytes, keyHex, ivHex } = await seal(3 * SEGMENT);
    const header = parseSegmentedHeader(bytes);
    const tampered = bytes.slice();
    tampered[segmentCiphertextRange(header, 1)[0] + 5] ^= 0x01;
    const err = await decryptSegmentedMediaBuffer(tampered.buffer, keyHex, ivHex).catch((e) => e);
    expect(err.fault).toBe('segment-auth');
    expect(err.segmentIndex).toBe(1);
  });

  it('refuses a header whose announced length was edited', async () => {
    // A shorter length makes the blob longer than announced - refused before any segment opens.
    const { bytes, keyHex, ivHex } = await seal(2 * SEGMENT);
    const longer = bytes.slice();
    longer.set(encodeSegmentedHeader(SEGMENT, 2 * SEGMENT - 1), 0);
    expect(await faultOf(decryptSegmentedMediaBuffer(longer.buffer, keyHex, ivHex))).toBe('length');
  });

  it('refuses bytes appended after the last segment', async () => {
    const { bytes, keyHex, ivHex } = await seal(SEGMENT + 3);
    const extended = new Uint8Array(bytes.byteLength + 16);
    extended.set(bytes, 0);
    expect(await faultOf(decryptSegmentedMediaBuffer(extended.buffer, keyHex, ivHex))).toBe(
      'length'
    );
  });

  it('refuses a wrong key at the first segment', async () => {
    const { ciphertext, ivHex } = await seal(SEGMENT);
    const other = await seal(1);
    expect(await faultOf(decryptSegmentedMediaBuffer(ciphertext, other.keyHex, ivHex))).toBe(
      'segment-auth'
    );
  });

  it('refuses a header it cannot vouch for, each by its own fault', () => {
    const good = encodeSegmentedHeader(SEGMENT, 10);
    expect(() => parseSegmentedHeader(good.slice(0, 19))).toThrow(SegmentedMediaError);
    const magic = good.slice();
    magic[0] = 0x00;
    const version = good.slice();
    version[7] = 2;
    const faults = [good.slice(0, 19), magic, version, encodeSegmentedHeader(1, 10)].map((h) => {
      try {
        parseSegmentedHeader(h);
        return 'accepted';
      } catch (e) {
        return (e as SegmentedMediaError).fault;
      }
    });
    expect(faults).toEqual(['header-short', 'magic', 'version', 'segment-size']);
  });

  it('refuses a LEGACY single-block blob handed to it by a ref that says segmented', async () => {
    // The ref decides the format; the bytes never get to argue. A single block is refused by name,
    // never quietly decrypted as what it is.
    const legacy = await encryptMediaBuffer(plaintextOf(5000).buffer);
    expect(
      await faultOf(decryptSegmentedMediaBuffer(legacy.ciphertext, legacy.keyHex, legacy.ivHex))
    ).toBe('magic');
  });
});
