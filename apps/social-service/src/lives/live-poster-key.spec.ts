/**
 * The preview key is HKDF of the live key, pinned to ONE vector - the same one
 * `frontend/src/lib/live/livePosterCrypto.test.ts` asserts for the WebCrypto derivation, so the
 * broadcaster's seal and the list's key cannot drift apart.
 */
import { Logger } from '@nestjs/common';
import { derivePosterKey, LIVE_POSTER_KEY_INFO, servedPoster } from './live-poster-key';

const LIVE_KEY = 'ab'.repeat(32);
const LIVE_ID = '0b6f3a2e-9c1d-4e5f-8a7b-1c2d3e4f5a6b';

describe('derivePosterKey', () => {
  it('is HKDF-SHA256(liveKey, salt = live id bytes, info = "canari-live-poster-v1")', () => {
    expect(LIVE_POSTER_KEY_INFO).toBe('canari-live-poster-v1');
    expect(derivePosterKey(LIVE_KEY, LIVE_ID)).toBe(
      'f5fcbcc316af61a8152e91d6ea0badf771964e87caeca777471280aabb78b0af'
    );
  });

  it('is never the live key, and differs per live', () => {
    const other = '1b6f3a2e-9c1d-4e5f-8a7b-1c2d3e4f5a6b';
    expect(derivePosterKey(LIVE_KEY, LIVE_ID)).not.toBe(LIVE_KEY);
    expect(derivePosterKey(LIVE_KEY, other)).not.toBe(derivePosterKey(LIVE_KEY, LIVE_ID));
  });

  it('refuses what is not a live key or a live id', () => {
    expect(() => derivePosterKey('zz', LIVE_ID)).toThrow(RangeError);
    expect(() => derivePosterKey(LIVE_KEY, 'not-a-uuid')).toThrow(RangeError);
  });
});

describe('servedPoster', () => {
  const stored = { liveKey: LIVE_KEY, liveKeyCiphertext: null, liveKeyVersion: null };
  it('serves the name, its age and the poster key together', () => {
    expect(servedPoster(LIVE_ID, { ...stored, posterName: 'n', posterAgeMs: 1500 })).toEqual({
      poster: { name: 'n', ageMs: 1500 },
      posterKey: derivePosterKey(LIVE_KEY, LIVE_ID),
    });
  });
  it('serves nothing without a name, or for a name whose time is unknown - never an age of 0', () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const none = { poster: null, posterKey: null };
    expect(servedPoster(LIVE_ID, { ...stored, posterName: null, posterAgeMs: 5 })).toEqual(none);
    expect(servedPoster(LIVE_ID, { ...stored, posterName: 'n', posterAgeMs: null })).toEqual(none);
    expect(servedPoster(LIVE_ID, { ...stored, posterName: 'n', posterAgeMs: undefined })).toEqual(
      none
    );
  });
});
