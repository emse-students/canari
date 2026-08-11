import { describe, it, expect } from 'vitest';
import { MediaPurgedError, MEDIA_PURGED_MESSAGE, isMediaPurgedError } from './mediaErrors';

describe('media error classification', () => {
  it('recognises the purged error', () => {
    expect(isMediaPurgedError(new MediaPurgedError())).toBe(true);
  });

  it('is an Error, so an unaware catch still logs something useful', () => {
    const err = new MediaPurgedError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('MediaPurgedError');
    expect(err.message).toBe(MEDIA_PURGED_MESSAGE);
  });

  it('does NOT classify an ordinary download failure as purged', () => {
    expect(isMediaPurgedError(new Error('Media download failed: 500 Internal Server Error'))).toBe(
      false
    );
    expect(isMediaPurgedError(new Error('Failed to fetch'))).toBe(false);
  });

  it('does not accept a look-alike message - the type is the contract, not the prose', () => {
    expect(isMediaPurgedError(new Error(MEDIA_PURGED_MESSAGE))).toBe(false);
  });

  it('tolerates non-Error rejections', () => {
    expect(isMediaPurgedError(MEDIA_PURGED_MESSAGE)).toBe(false);
    expect(isMediaPurgedError(undefined)).toBe(false);
    expect(isMediaPurgedError(null)).toBe(false);
    expect(isMediaPurgedError({ message: MEDIA_PURGED_MESSAGE })).toBe(false);
  });
});
