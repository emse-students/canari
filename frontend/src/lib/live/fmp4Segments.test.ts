/** Where a segment's init ends: after `moov`, or nowhere for a media-only fragment. */
import { describe, it, expect } from 'vitest';
import { Fmp4ParseError, initSegmentEnd } from './fmp4Segments';

/** A box of `payload` zero bytes - only its size and type are read. */
function sizedBox(type: string, payload = 0): Uint8Array {
  const b = new Uint8Array(8 + payload);
  new DataView(b.buffer).setUint32(0, 8 + payload);
  for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i);
  return b;
}
const joinBytes = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

describe('initSegmentEnd', () => {
  it('ends after moov for an init alone', () => {
    expect(initSegmentEnd(joinBytes(sizedBox('ftyp', 12), sizedBox('moov', 40)))).toBe(20 + 48);
  });

  it('ends after moov when a fragment follows (a self-contained segment)', () => {
    expect(
      initSegmentEnd(
        joinBytes(
          sizedBox('ftyp', 12),
          sizedBox('moov', 40),
          sizedBox('moof', 8),
          sizedBox('mdat', 100)
        )
      )
    ).toBe(68);
  });

  it('is 0 for a media-only fragment', () => {
    expect(initSegmentEnd(joinBytes(sizedBox('moof', 8), sizedBox('mdat', 100)))).toBe(0);
  });

  it('is 0 for a truncated box or an empty buffer', () => {
    expect(
      initSegmentEnd(joinBytes(sizedBox('ftyp', 12), sizedBox('moov', 40)).subarray(0, 30))
    ).toBe(0);
    expect(initSegmentEnd(new Uint8Array(0))).toBe(0);
  });

  it('reads a 64-bit box size', () => {
    const big = new Uint8Array(16 + 4);
    const v = new DataView(big.buffer);
    v.setUint32(0, 1);
    big.set([0x66, 0x72, 0x65, 0x65], 4); // free
    v.setUint32(12, 20);
    expect(initSegmentEnd(joinBytes(big, sizedBox('moov', 4)))).toBe(32);
  });
});

describe('initSegmentEnd on a box it cannot frame', () => {
  it('throws the typed error for a size-0 box and for a size under its own header', () => {
    expect(() => initSegmentEnd(joinBytes(sizedBox('ftyp', 12), new Uint8Array(8)))).toThrow(
      Fmp4ParseError
    );
    const tiny = sizedBox('free');
    new DataView(tiny.buffer).setUint32(0, 4);
    expect(() => initSegmentEnd(tiny)).toThrow(Fmp4ParseError);
  });
});
