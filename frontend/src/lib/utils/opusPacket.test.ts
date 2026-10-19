import { describe, expect, it } from 'vitest';
import { isValidOpusPacket } from './opusPacket';

const bytes = (...b: number[]) => Uint8Array.from(b);
/** TOC byte: config (0-31), stereo flag, frame-count code. */
const toc = (config: number, code: number) => (config << 3) | code;

describe('isValidOpusPacket (RFC 6716 section 3.4)', () => {
  it('R1: refuses an empty packet, accepts a lone TOC (DTX)', () => {
    expect(isValidOpusPacket(new Uint8Array(0))).toBe(false);
    expect(isValidOpusPacket(bytes(toc(31, 0)))).toBe(true);
  });

  it('R2: code 0 - one frame up to 1275 bytes', () => {
    expect(isValidOpusPacket(new Uint8Array(1 + 1275).fill(toc(31, 0), 0, 1))).toBe(true);
    expect(isValidOpusPacket(new Uint8Array(1 + 1276).fill(toc(31, 0), 0, 1))).toBe(false);
  });

  it('R3: code 1 - two equal frames, so an even remainder', () => {
    expect(isValidOpusPacket(bytes(toc(31, 1), 1, 2, 3, 4))).toBe(true);
    expect(isValidOpusPacket(bytes(toc(31, 1), 1, 2, 3))).toBe(false);
  });

  it('R4: code 2 - the coded first length must fit', () => {
    expect(isValidOpusPacket(bytes(toc(31, 2), 2, 9, 9, 7))).toBe(true);
    expect(isValidOpusPacket(bytes(toc(31, 2), 200, 9, 9))).toBe(false);
    expect(isValidOpusPacket(bytes(toc(31, 2)))).toBe(false);
  });

  it('R5: code 3 - at least one frame and at most 120 ms', () => {
    // config 31 = CELT 20 ms: 6 frames = 120 ms is the limit, 7 is over.
    expect(isValidOpusPacket(bytes(toc(31, 3), 6, ...Array.from({ length: 12 }, () => 1)))).toBe(
      true
    );
    expect(isValidOpusPacket(bytes(toc(31, 3), 7, ...Array.from({ length: 14 }, () => 1)))).toBe(
      false
    );
    expect(isValidOpusPacket(bytes(toc(31, 3), 0))).toBe(false);
  });

  it('R6: code 3 CBR - the data divides evenly, after the padding', () => {
    // 2 frames, padded by 1 byte (0x40 flag, padding length 1): 4 data bytes + 1 padding.
    expect(isValidOpusPacket(bytes(toc(31, 3), 0x40 | 2, 1, 5, 5, 5, 5, 0))).toBe(true);
    expect(isValidOpusPacket(bytes(toc(31, 3), 2, 5, 5, 5))).toBe(false);
  });

  it('R7: code 3 VBR - the coded lengths must fit', () => {
    expect(isValidOpusPacket(bytes(toc(31, 3), 0x80 | 2, 1, 9, 8, 8))).toBe(true);
    expect(isValidOpusPacket(bytes(toc(31, 3), 0x80 | 2, 9, 9, 8))).toBe(false);
  });

  it('accepts what a 20 ms Opus encoder emits (code 0, hybrid and CELT configs)', () => {
    for (const config of [1, 9, 13, 15, 27, 31]) {
      expect(isValidOpusPacket(new Uint8Array(120).fill(toc(config, 0), 0, 1))).toBe(true);
    }
  });

  it('refuses a large share of random payloads - what ciphertext fed to a decoder looks like', () => {
    let seed = 12345;
    const next = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed >>> 24;
    };
    let invalid = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) {
      const p = new Uint8Array(100 + (i % 60));
      for (let k = 0; k < p.length; k++) p[k] = next();
      if (!isValidOpusPacket(p)) invalid++;
    }
    // Code 0 (a quarter of random TOCs) is always valid; the other three codes mostly are not.
    expect(invalid / n).toBeGreaterThan(0.3);
    expect(invalid / n).toBeLessThan(0.75);
  });
});
