import { describe, it, expect } from 'vitest';
import { SegmentedMediaError } from '$lib/mediaSegmented';
import {
  MediaDecryptError,
  MediaDownloadError,
  MediaNotFoundError,
  MediaPurgedError,
  MediaUnreachableError,
  MEDIA_PURGED_MESSAGE,
  isMediaPurgedError,
  isRetryableMediaFailure,
  mediaFailureCause,
} from './mediaErrors';

describe('mediaFailureCause - one cause per type, never per message', () => {
  it.each([
    [new MediaUnreachableError(new TypeError('Failed to fetch')), 'unreachable', true],
    [new MediaPurgedError(), 'expired', false],
    [new MediaNotFoundError(), 'not-found', false],
    [new MediaDecryptError(new DOMException('', 'OperationError')), 'corrupt', true],
    [new MediaDownloadError(503), 'other', true],
    // The streaming reader throws these raw: a segment whose tag fails, a blob cut short.
    [new SegmentedMediaError('segment-auth', 'segment 3', 3), 'corrupt', true],
    [new SegmentedMediaError('length', 'segment 19 short', 19), 'corrupt', true],
  ] as const)('%s -> %s', (err, cause, retryable) => {
    expect(mediaFailureCause(err)).toBe(cause);
    expect(isRetryableMediaFailure(cause)).toBe(retryable);
  });

  it('reads no prose: a look-alike message is "other"', () => {
    expect(mediaFailureCause(new Error('Media not found (404)'))).toBe('other');
    expect(mediaFailureCause(new TypeError('Failed to fetch'))).toBe('other');
    expect(mediaFailureCause(undefined)).toBe('other');
  });

  it('carries the status as a field', () => {
    expect(new MediaDownloadError(502).status).toBe(502);
  });
});

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
