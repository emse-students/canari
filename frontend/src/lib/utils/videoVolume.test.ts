/**
 * ONE RULE FOR AN ELEMENT'S VOLUME: the reader's level (the desktop slider, #3372) TIMES the loudness
 * factor the fallback put on it (#3378) - and the level read back is the reader's, never the product.
 * Pinned on the case the fallback exists for: a loud STREAM on WebKit, which is not routed through
 * Web Audio and is lowered through its volume.
 */
import { describe, expect, it, vi } from 'vitest';
import { applyVideoLevel, readVideoLevel } from './videoVolume';
import { LoudnessAudio, dbToGain } from '$lib/video/loudnessPlayback';

/** A `<video>` as the two layers see it: its volume, mute, pause and events. */
class FakeVideo extends EventTarget {
  muted = false;
  paused = false;
  volume = 1;
}

/** WebKit, with Web Audio present: a stream is still never routed. */
function webkit() {
  const createContext = vi.fn(() => null);
  const audio = new LoudnessAudio({
    createContext,
    isWebKit: () => true,
    isArbitrated: () => true,
  });
  return { audio, createContext };
}

const LOUD = { integratedLufs: -8, samplePeakDbfs: 0 }; // -6 dB
const asVideo = (v: FakeVideo) => v as unknown as HTMLVideoElement;

describe('the reader level x the loudness factor', () => {
  it('a loud WebKit stream at a slider level of 0.5 plays at 0.5 x -6 dB, and reads back 0.5', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { audio, createContext } = webkit();
    const video = new FakeVideo();
    applyVideoLevel(asVideo(video), 0.5);
    const handle = audio.attach(asVideo(video), { streamed: true });
    handle.setLoudness(LOUD);
    expect(createContext).not.toHaveBeenCalled();
    expect(video.volume).toBeCloseTo(0.5 * dbToGain(-6));
    expect(readVideoLevel(asVideo(video))).toBeCloseTo(0.5);

    // The slider moves afterwards: the product follows, the factor is kept.
    applyVideoLevel(asVideo(video), 0.8);
    expect(video.volume).toBeCloseTo(0.8 * dbToGain(-6));
    expect(readVideoLevel(asVideo(video))).toBeCloseTo(0.8);

    // Unmounted: the element is back at the reader's level alone.
    handle.destroy();
    expect(video.volume).toBeCloseTo(0.8);
    expect(readVideoLevel(asVideo(video))).toBeCloseTo(0.8);
    warn.mockRestore();
  });

  it('a video with no fallback factor is at the reader level exactly (the Web Audio route, an old video)', () => {
    const video = new FakeVideo();
    applyVideoLevel(asVideo(video), 0.3);
    expect(video.volume).toBe(0.3);
    expect(readVideoLevel(asVideo(video))).toBe(0.3);
  });
});
