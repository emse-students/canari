/**
 * THE PREVIEW SEAL: it opens for its own live and key only, and it is never a segment - the two
 * formats carry different labels in their authenticated data.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openLiveSegment, sealLiveSegment } from './liveCrypto';
import { LivePosterOpenError, openLivePoster, sealLivePoster } from './livePosterCrypto';

const KEY = 'ab'.repeat(32);
const OTHER_KEY = 'cd'.repeat(32);
const LIVE = '0b6f3a2e-9c1d-4e5f-8a7b-1c2d3e4f5a6b';
const OTHER_LIVE = '1b6f3a2e-9c1d-4e5f-8a7b-1c2d3e4f5a6b';
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the live poster seal, v1', () => {
  it('opens back to the same bytes, with a fresh IV each time', async () => {
    const a = await sealLivePoster(KEY, LIVE, JPEG);
    const b = await sealLivePoster(KEY, LIVE, JPEG);
    expect(a).not.toEqual(b);
    expect(a.byteLength).toBe(12 + JPEG.byteLength + 16);
    await expect(openLivePoster(KEY, LIVE, a)).resolves.toEqual(JPEG);
  });

  it('refuses another key, another live, a changed byte and a stub, typed', async () => {
    const sealed = await sealLivePoster(KEY, LIVE, JPEG);
    const flipped = sealed.slice();
    flipped[20] ^= 1;
    for (const attempt of [
      openLivePoster(OTHER_KEY, LIVE, sealed),
      openLivePoster(KEY, OTHER_LIVE, sealed),
      openLivePoster(KEY, LIVE, flipped),
    ]) {
      await expect(attempt).rejects.toMatchObject({ reason: 'unauthentic' });
    }
    await expect(openLivePoster(KEY, LIVE, new Uint8Array(10))).rejects.toBeInstanceOf(
      LivePosterOpenError
    );
  });

  it('is never read as a segment, nor a segment as a poster', async () => {
    const poster = await sealLivePoster(KEY, LIVE, JPEG);
    await expect(openLiveSegment(KEY, LIVE, 0, poster)).rejects.toMatchObject({
      reason: 'unauthentic',
    });
    const segment = await sealLiveSegment(KEY, LIVE, 0, JPEG);
    await expect(openLivePoster(KEY, LIVE, segment)).rejects.toMatchObject({
      reason: 'unauthentic',
    });
  });
});
