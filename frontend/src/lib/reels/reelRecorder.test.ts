/**
 * One take: the platform's container, the bytes handed over only once the LAST chunk is in, and every
 * failure a typed fault.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REEL_RECORD_BITRATE_MAX } from './framedCapture';
import { ReelRecorder, ReelRecorderError } from './reelRecorder';
import { installFakeMediaRecorder } from './fakeMediaRecorder.test-helper';

const stream = {} as MediaStream;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ReelRecorder', () => {
  it('records the platform container at the take bitrate, in one-second chunks', () => {
    const Fake = installFakeMediaRecorder();
    ReelRecorder.start(stream, false);
    ReelRecorder.start(stream, true, 1_500_000);
    expect(Fake.instances[0].options).toEqual({
      mimeType: 'video/webm;codecs=h264,opus',
      videoBitsPerSecond: REEL_RECORD_BITRATE_MAX,
      audioBitsPerSecond: 128_000,
    });
    expect(Fake.instances[1].mimeType).toBe('video/mp4;codecs=avc1,mp4a');
    expect(Fake.instances[1].options.videoBitsPerSecond).toBe(1_500_000);
    expect(Fake.instances[0].start).toHaveBeenCalledWith(1000);
  });

  it('hands over every chunk, the last one included, typed as the container', async () => {
    const Fake = installFakeMediaRecorder();
    const take = ReelRecorder.start(stream, false);
    Fake.instances[0].ondataavailable?.({ data: new Blob(['first']) });
    const blob = await take.stop();
    expect(blob.type).toBe('video/webm;codecs=h264,opus');
    expect(await blob.text()).toBe('firsttake');
  });

  it('refuses as unsupported when the engine records none of the containers', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const Fake = installFakeMediaRecorder();
    Fake.supported = new Set();
    const err = (() => {
      try {
        ReelRecorder.start(stream, false);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ReelRecorderError);
    expect((err as ReelRecorderError).fault).toBe('unsupported');
    Fake.supported = new Set(['video/webm;codecs=vp9,opus', 'video/mp4;codecs=avc1,mp4a']);
  });

  it('an empty take is a typed refusal, not an empty video', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const Fake = installFakeMediaRecorder();
    const take = ReelRecorder.start(stream, false);
    Fake.instances[0].lastChunk = '';
    await expect(take.stop()).rejects.toMatchObject({ fault: 'empty' });
  });

  it('a failure mid-take is reported at the stop', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const Fake = installFakeMediaRecorder();
    const take = ReelRecorder.start(stream, false);
    Fake.instances[0].onerror?.(new Event('error'));
    await expect(take.stop()).rejects.toMatchObject({ fault: 'record' });
  });
});
