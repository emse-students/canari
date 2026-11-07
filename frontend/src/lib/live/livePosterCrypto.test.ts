/**
 * THE PREVIEW SEAL: it opens for its own live and key only, and it is never a segment - the two
 * formats carry different labels in their authenticated data.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openLiveChatMessage, sealLiveChatMessage } from './liveChatCrypto';
import { openLiveSegment, sealLiveSegment } from './liveCrypto';
import {
  deriveLivePosterKey,
  LivePosterOpenError,
  openLivePoster,
  sealLivePoster,
} from './livePosterCrypto';

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

  it('derives the poster key exactly as the server does (one vector, pinned on both sides)', async () => {
    // apps/social-service/src/lives/live-poster-key.spec.ts asserts the same three values.
    await expect(deriveLivePosterKey('ab'.repeat(32), LIVE)).resolves.toBe(
      'f5fcbcc316af61a8152e91d6ea0badf771964e87caeca777471280aabb78b0af'
    );
    await expect(deriveLivePosterKey(KEY, OTHER_LIVE)).resolves.not.toBe(
      await deriveLivePosterKey(KEY, LIVE)
    );
  });

  it('THE POSTER KEY OPENS NO SEGMENT AND NO CHAT LINE: the list never serves the live key', async () => {
    const posterKey = await deriveLivePosterKey(KEY, LIVE);
    expect(posterKey).not.toBe(KEY);
    const segment = await sealLiveSegment(KEY, LIVE, 0, JPEG);
    await expect(openLiveSegment(posterKey, LIVE, 0, segment)).rejects.toMatchObject({
      reason: 'unauthentic',
    });
    const CLIENT = '2b6f3a2e-9c1d-4e5f-8a7b-1c2d3e4f5a6b';
    const AUTHOR = '3b6f3a2e-9c1d-4e5f-8a7b-1c2d3e4f5a6b';
    const line = await sealLiveChatMessage(KEY, LIVE, CLIENT, AUTHOR, 'bonjour');
    await expect(openLiveChatMessage(posterKey, LIVE, CLIENT, AUTHOR, line)).rejects.toMatchObject({
      reason: 'unauthentic',
    });
    // And the broadcaster's seal under the poster key opens with the key the list serves.
    const poster = await sealLivePoster(posterKey, LIVE, JPEG);
    await expect(openLivePoster(posterKey, LIVE, poster)).resolves.toEqual(JPEG);
    await expect(openLivePoster(KEY, LIVE, poster)).rejects.toMatchObject({
      reason: 'unauthentic',
    });
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
