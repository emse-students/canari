/**
 * `prepareForQueue`: a CanaReels TAKE is prepared as the camera's publish step prepared it (its cap,
 * trimmed to its picture, its sound removed when the member removed it), under the encoder lease the
 * chat take shares; an ordinary post media is prepared as before, with neither.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const preparePostMedia = vi.fn();
const withEncoderLease = vi.fn();
vi.mock('$lib/media', () => ({ preparePostMedia: (...a: unknown[]) => preparePostMedia(...a) }));
vi.mock('$lib/reels/reelFirstFrame', () => ({
  preparedMediaPlaceholder: async () => 'HASH',
}));
vi.mock('$lib/video/encoderLease', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/video/encoderLease')>()),
  withEncoderLease: (...a: unknown[]) => withEncoderLease(...a),
}));

import { prepareForQueue } from './prepareForQueue';
import { EncoderLeaseAbortedError } from '$lib/video/encoderLease';
import { VideoPrepareError } from '$lib/video/prepareVideoForUpload';

const media = { uploadLimits: async () => ({ maxPlaintextBytes: 1234 }) } as never;
const video = new File([new Uint8Array([1])], 'canareel.mp4', { type: 'video/mp4' });
const photo = new File([new Uint8Array([1])], 'p.jpg', { type: 'image/jpeg' });

beforeEach(() => {
  preparePostMedia.mockReset();
  withEncoderLease.mockReset();
  preparePostMedia.mockImplementation(async (file: File) => ({ file }));
  withEncoderLease.mockImplementation(
    async (_holder: string, _signal: AbortSignal, encode: () => Promise<unknown>) => encode()
  );
});

describe('prepareForQueue', () => {
  it('maps a take to the camera options - its cap, trimmed to its picture, its sound removed - under the lease', async () => {
    const signal = new AbortController().signal;
    const onProgress = () => undefined;
    const out = await prepareForQueue(media, video, onProgress, signal, {
      maxDurationMs: 90_000,
      removeAudio: true,
    });
    expect(withEncoderLease).toHaveBeenCalledWith('publish', signal, expect.any(Function));
    expect(preparePostMedia).toHaveBeenCalledWith(video, {
      maxBytes: 1234,
      onProgress,
      signal,
      maxSeconds: 90,
      removeAudio: true,
      trimToVideo: true,
    });
    expect(out).toMatchObject({ file: video, placeholder: 'HASH' });
  });

  it('a take that kept its sound says so (removeAudio false), never undefined', async () => {
    await prepareForQueue(media, video, () => undefined, new AbortController().signal, {
      maxDurationMs: 30_000,
    });
    expect(preparePostMedia.mock.calls[0][1]).toMatchObject({
      maxSeconds: 30,
      removeAudio: false,
      trimToVideo: true,
    });
  });

  it('an ordinary post video has no cap, no trim, no lease', async () => {
    await prepareForQueue(media, video, () => undefined, new AbortController().signal, undefined);
    expect(withEncoderLease).not.toHaveBeenCalled();
    const options = preparePostMedia.mock.calls[0][1];
    expect(options.maxBytes).toBe(1234);
    expect(options).not.toHaveProperty('maxSeconds');
    expect(options).not.toHaveProperty('trimToVideo');
  });

  it('a take PHOTO is prepared without the lease and without asking the video limits', async () => {
    const limits = vi.fn();
    await prepareForQueue(
      { uploadLimits: limits } as never,
      photo,
      () => undefined,
      new AbortController().signal,
      { maxDurationMs: 90_000 }
    );
    expect(withEncoderLease).not.toHaveBeenCalled();
    expect(limits).not.toHaveBeenCalled();
    expect(preparePostMedia.mock.calls[0][1].maxBytes).toBeUndefined();
  });

  it('a wait for the encoder ABANDONED is the prepare step aborted (a VideoPrepareError), not a refusal', async () => {
    const cause = new EncoderLeaseAbortedError('paused');
    withEncoderLease.mockRejectedValueOnce(cause);
    const error = await prepareForQueue(
      media,
      video,
      () => undefined,
      new AbortController().signal,
      { maxDurationMs: 90_000 }
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VideoPrepareError);
    expect((error as VideoPrepareError).fault).toBe('aborted');
    expect((error as VideoPrepareError).cause).toBe(cause);
  });

  it('any other failure under the lease goes through unchanged', async () => {
    const boom = new Error('encoder crashed');
    withEncoderLease.mockRejectedValueOnce(boom);
    await expect(
      prepareForQueue(media, video, () => undefined, new AbortController().signal, {
        maxDurationMs: 90_000,
      })
    ).rejects.toBe(boom);
  });
});
