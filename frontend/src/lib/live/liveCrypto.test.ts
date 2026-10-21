/**
 * THE LIVE SEGMENT SEAL, v1 (docs/wiki/frontend/modules/live.md, "The segment seal format, v1").
 *
 * Pinned: the round trip; every tamper (key, live id, index, format version, a flipped byte, a
 * truncation, an IV of another length) refused as a typed `LiveSegmentOpenError`; a fresh IV per
 * seal; and the byte layout and AAD against an INDEPENDENT AES-256-GCM (node:crypto), both ways.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createCipheriv } from 'node:crypto';
import { LiveSegmentOpenError, openLiveSegment, sealLiveSegment } from './liveCrypto';

const KEY = '00112233445566778899aabbccddeeff'.repeat(2);
const OTHER_KEY = 'ff'.repeat(32);
const LIVE = '0b6f3a2e-9c1d-4e5f-8a7b-1c2d3e4f5a6b';
const OTHER_LIVE = '0b6f3a2e-9c1d-4e5f-8a7b-1c2d3e4f5a6c';
const PLAIN = new TextEncoder().encode('ftyp....moof....mdat fMP4 bytes');

/** The v1 AAD, built here from the spec and NOT from the module. */
function specAad(label: string, liveId: string, index: number): Buffer {
  const idx = Buffer.alloc(4);
  idx.writeUInt32BE(index);
  return Buffer.concat([
    Buffer.from(label, 'ascii'),
    Buffer.from([0]),
    Buffer.from(liveId.replaceAll('-', ''), 'hex'),
    idx,
  ]);
}

/** iv || ciphertext || tag, sealed by node:crypto - an implementation the module does not share. */
function nodeSeal(iv: Buffer, plain: Uint8Array, aad: Buffer, keyHex = KEY): Uint8Array {
  const c = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return new Uint8Array(Buffer.concat([iv, ct, c.getAuthTag()]));
}

async function refusal(p: Promise<unknown>): Promise<LiveSegmentOpenError> {
  const e = await p.catch((x: unknown) => x);
  expect(e).toBeInstanceOf(LiveSegmentOpenError);
  return e as LiveSegmentOpenError;
}

afterEach(() => vi.restoreAllMocks());

describe('sealLiveSegment / openLiveSegment', () => {
  it('round-trips, and the sealed size is iv + plaintext + tag', async () => {
    const sealed = await sealLiveSegment(KEY, LIVE, 7, PLAIN);
    expect(sealed.byteLength).toBe(12 + PLAIN.byteLength + 16);
    expect(await openLiveSegment(KEY, LIVE, 7, sealed)).toEqual(PLAIN);
    // An ArrayBuffer and a view at an offset open the same.
    expect(await openLiveSegment(KEY, LIVE, 7, sealed.buffer)).toEqual(PLAIN);
    const padded = new Uint8Array(sealed.byteLength + 5);
    padded.set(sealed, 5);
    expect(await openLiveSegment(KEY, LIVE, 7, padded.subarray(5))).toEqual(PLAIN);
  });

  it('round-trips an empty plaintext and a 2 MB one', async () => {
    const empty = await sealLiveSegment(KEY, LIVE, 0, new Uint8Array(0));
    expect(empty.byteLength).toBe(28);
    expect((await openLiveSegment(KEY, LIVE, 0, empty)).byteLength).toBe(0);

    const big = new Uint8Array(2 * 1024 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;
    const sealed = await sealLiveSegment(KEY, LIVE, 0xffff_ffff, big);
    const opened = await openLiveSegment(KEY, LIVE, 0xffff_ffff, sealed);
    // Buffer.equals, not toEqual: a deep equality walks 2 M elements one by one (seconds).
    expect(Buffer.from(opened).equals(Buffer.from(big))).toBe(true);
  });

  it('seals and opens the bytes as they were AT THE CALL, whatever the caller does meanwhile', async () => {
    const buf = PLAIN.slice();
    const sealing = sealLiveSegment(KEY, LIVE, 3, buf);
    buf.fill(0); // the caller reuses its buffer before the seal resolves
    const sealed = await sealing;
    expect(await openLiveSegment(KEY, LIVE, 3, sealed)).toEqual(PLAIN);

    const view = sealed.slice();
    const opening = openLiveSegment(KEY, LIVE, 3, view);
    view.fill(0);
    expect(await opening).toEqual(PLAIN);

    const ab = sealed.slice().buffer;
    const openingAb = openLiveSegment(KEY, LIVE, 3, ab);
    new Uint8Array(ab).fill(0);
    expect(await openingAb).toEqual(PLAIN);
  });

  it('draws a fresh IV per seal: the same bytes sealed twice differ', async () => {
    const a = await sealLiveSegment(KEY, LIVE, 1, PLAIN);
    const b = await sealLiveSegment(KEY, LIVE, 1, PLAIN);
    expect(a.subarray(0, 12)).not.toEqual(b.subarray(0, 12));
    expect(a).not.toEqual(b);
  });

  it('matches an independent AES-256-GCM byte for byte (known answer, both directions)', async () => {
    const iv = Buffer.from('a0a1a2a3a4a5a6a7a8a9aaab', 'hex');
    const expected = nodeSeal(iv, PLAIN, specAad('canari-live-v1', LIVE, 0x01020304));
    expect(specAad('canari-live-v1', LIVE, 0x01020304).byteLength).toBe(14 + 1 + 16 + 4);

    vi.spyOn(crypto, 'getRandomValues').mockImplementation(
      <T extends ArrayBufferView | null>(arr: T): T => {
        new Uint8Array(arr!.buffer, arr!.byteOffset, arr!.byteLength).set(iv);
        return arr;
      }
    );
    expect(await sealLiveSegment(KEY, LIVE, 0x01020304, PLAIN)).toEqual(expected);
    vi.restoreAllMocks();

    expect(await openLiveSegment(KEY, LIVE, 0x01020304, expected)).toEqual(PLAIN);
  });

  describe('refuses, typed, every segment that is not this live, this index, this format', () => {
    it('a wrong key', async () => {
      const sealed = await sealLiveSegment(KEY, LIVE, 3, PLAIN);
      expect((await refusal(openLiveSegment(OTHER_KEY, LIVE, 3, sealed))).reason).toBe(
        'unauthentic'
      );
    });

    it('another live id (cross-live replay)', async () => {
      const sealed = await sealLiveSegment(KEY, LIVE, 3, PLAIN);
      // The tag is bound to the live id through the AAD, so this is an authentication failure and
      // not a layout one.
      expect((await refusal(openLiveSegment(KEY, OTHER_LIVE, 3, sealed))).reason).toBe(
        'unauthentic'
      );
    });

    it('another index (reorder or replay within the live)', async () => {
      const sealed = await sealLiveSegment(KEY, LIVE, 3, PLAIN);
      const e = await refusal(openLiveSegment(KEY, LIVE, 4, sealed));
      expect(e.index).toBe(4);
    });

    it('another format version', async () => {
      const iv = Buffer.alloc(12, 9);
      const v2 = nodeSeal(iv, PLAIN, specAad('canari-live-v2', LIVE, 3));
      // Well-formed (iv + ciphertext + tag, right length), refused only because the AAD label differs.
      expect((await refusal(openLiveSegment(KEY, LIVE, 3, v2))).reason).toBe('unauthentic');
    });

    it('a flipped byte in the IV, the ciphertext or the tag', async () => {
      const sealed = await sealLiveSegment(KEY, LIVE, 3, PLAIN);
      for (const at of [0, 12, sealed.byteLength - 1]) {
        const bad = sealed.slice();
        bad[at] ^= 0x01;
        expect((await refusal(openLiveSegment(KEY, LIVE, 3, bad))).reason).toBe('unauthentic');
      }
    });

    it('a truncation: one byte short, and below iv + tag', async () => {
      const sealed = await sealLiveSegment(KEY, LIVE, 3, PLAIN);
      expect(
        (await refusal(openLiveSegment(KEY, LIVE, 3, sealed.subarray(0, sealed.length - 1)))).reason
      ).toBe('unauthentic');
      expect((await refusal(openLiveSegment(KEY, LIVE, 3, sealed.subarray(0, 27)))).reason).toBe(
        'malformed'
      );
      expect((await refusal(openLiveSegment(KEY, LIVE, 3, new Uint8Array(0)))).reason).toBe(
        'malformed'
      );
    });

    it('a segment sealed with an IV of another length', async () => {
      const iv16 = Buffer.alloc(16, 7);
      const sealed = nodeSeal(iv16, PLAIN, specAad('canari-live-v1', LIVE, 3));
      expect((await refusal(openLiveSegment(KEY, LIVE, 3, sealed))).reason).toBe('unauthentic');
    });
  });

  it('refuses arguments no caller should pass, as a RangeError, on both sides', async () => {
    const sealed = await sealLiveSegment(KEY, LIVE, 0, PLAIN);
    for (const [k, id, i] of [
      ['ab'.repeat(31), LIVE, 0],
      ['zz'.repeat(32), LIVE, 0],
      [KEY, 'not-a-uuid', 0],
      [KEY, LIVE, -1],
      [KEY, LIVE, 1.5],
      [KEY, LIVE, 2 ** 32],
    ] as const) {
      await expect(sealLiveSegment(k, id, i, PLAIN)).rejects.toBeInstanceOf(RangeError);
      await expect(openLiveSegment(k, id, i, sealed)).rejects.toBeInstanceOf(RangeError);
    }
  });
});
