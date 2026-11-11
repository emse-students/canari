import { describe, expect, it, vi } from 'vitest';
import {
  GAIN_DEADBAND_DB,
  LOUDNESS_TARGET_LUFS,
  MAX_BOOST_DB,
  attachLoudnessGain,
  dbToGain,
  elementVolumeFor,
  loudnessGainDb,
  type LoudnessEnvironment,
} from './loudnessPlayback';

describe('loudnessGainDb - the law', () => {
  it('brings a loud video DOWN to the target, without floor', () => {
    expect(loudnessGainDb({ integratedLufs: -8, samplePeakDbfs: 0 })).toBeCloseTo(-6);
    expect(loudnessGainDb({ integratedLufs: 0, samplePeakDbfs: 0 })).toBeCloseTo(
      LOUDNESS_TARGET_LUFS
    );
  });

  it('raises a quiet one, capped at +6 dB', () => {
    expect(loudnessGainDb({ integratedLufs: -18, samplePeakDbfs: -12 })).toBeCloseTo(4);
    expect(loudnessGainDb({ integratedLufs: -40, samplePeakDbfs: -30 })).toBeCloseTo(MAX_BOOST_DB);
  });

  it('never raises the measured peak past -1 dBFS', () => {
    // Wants +6, but its peak at -4 dBFS leaves 3 dB of headroom under the ceiling.
    expect(loudnessGainDb({ integratedLufs: -20, samplePeakDbfs: -4 })).toBeCloseTo(3);
  });

  it('a quiet video already peaking over the ceiling plays at 0 dB - the clamp never lowers', () => {
    expect(loudnessGainDb({ integratedLufs: -22, samplePeakDbfs: 0.3 })).toBe(0);
  });

  it('applies nothing inside the dead band', () => {
    expect(
      loudnessGainDb({
        integratedLufs: LOUDNESS_TARGET_LUFS - GAIN_DEADBAND_DB / 2,
        samplePeakDbfs: -10,
      })
    ).toBe(0);
  });

  it('applies nothing to a video with no measurement, or one no real signal gives', () => {
    expect(loudnessGainDb(undefined)).toBe(0);
    expect(loudnessGainDb(null)).toBe(0);
    expect(loudnessGainDb({ integratedLufs: Number.NaN, samplePeakDbfs: -1 } as never)).toBe(0);
  });
});

/** A `<video>` as the wiring sees it: its mute, pause and volume, and its two events. */
class FakeVideo extends EventTarget {
  muted = true;
  paused = true;
  #volume = 1;
  /** iOS: a written volume is ignored. */
  ignoresVolume = false;
  get volume() {
    return this.#volume;
  }
  set volume(v: number) {
    if (!this.ignoresVolume) this.#volume = v;
  }
  unmuteAndPlay() {
    this.muted = false;
    this.paused = false;
    this.dispatchEvent(new Event('volumechange'));
  }
  autoplayMuted() {
    this.paused = false;
    this.dispatchEvent(new Event('play'));
  }
}

/** A mocked `AudioContext` that records the graph it is asked to build. */
function fakeContext(initial: AudioContextState = 'running', resumesTo?: AudioContextState) {
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
  const ctx = {
    state: initial,
    destination: { name: 'destination' },
    createMediaElementSource: vi.fn(() => source),
    createGain: vi.fn(() => ({ ...gain, gain: { value: 1 } })),
    resume: vi.fn(async () => {
      if (resumesTo) ctx.state = resumesTo;
    }),
  };
  return { ctx, source };
}

function envOf(ctx: unknown): LoudnessEnvironment & { calls: number } {
  const env = {
    calls: 0,
    audioContext: () => {
      env.calls += 1;
      return ctx as AudioContext | null;
    },
  };
  return env;
}

const LOUD = { integratedLufs: -8, samplePeakDbfs: 0 }; // -6 dB
const QUIET = { integratedLufs: -20, samplePeakDbfs: -10 }; // +6 dB

describe('attachLoudnessGain - the wiring', () => {
  it('an OLD video (no measurement) is untouched: no context, no listener, no volume', () => {
    const video = new FakeVideo();
    const env = envOf(fakeContext().ctx);
    const stop = attachLoudnessGain(video as unknown as HTMLMediaElement, undefined, env);
    video.unmuteAndPlay();
    expect(env.calls).toBe(0);
    expect(video.volume).toBe(1);
    stop();
  });

  it('muted autoplay never asks for the AudioContext', () => {
    const video = new FakeVideo();
    const env = envOf(fakeContext().ctx);
    const stop = attachLoudnessGain(video as unknown as HTMLMediaElement, LOUD, env);
    video.autoplayMuted();
    expect(env.calls).toBe(0);
    stop();
  });

  it('routes source -> gain -> destination the first time the video is audible', () => {
    const video = new FakeVideo();
    const { ctx, source } = fakeContext();
    const stop = attachLoudnessGain(video as unknown as HTMLMediaElement, LOUD, envOf(ctx));
    video.unmuteAndPlay();
    expect(ctx.createMediaElementSource).toHaveBeenCalledWith(video);
    const gainNode = ctx.createGain.mock.results[0].value;
    expect(gainNode.gain.value).toBeCloseTo(dbToGain(-6));
    expect(source.connect).toHaveBeenCalledWith(gainNode);
    expect(gainNode.connect).toHaveBeenCalledWith(ctx.destination);
    // The reader's volume and mute stay theirs on this route.
    expect(video.volume).toBe(1);
    stop();
    expect(source.disconnect).toHaveBeenCalled();
    expect(gainNode.disconnect).toHaveBeenCalled();
  });

  it('a suspended context is resumed, and the graph built once it runs', async () => {
    const video = new FakeVideo();
    const { ctx } = fakeContext('suspended', 'running');
    const stop = attachLoudnessGain(video as unknown as HTMLMediaElement, QUIET, envOf(ctx));
    video.unmuteAndPlay();
    expect(ctx.createMediaElementSource).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(ctx.createGain).toHaveBeenCalledTimes(1));
    expect(ctx.createGain.mock.results[0].value.gain.value).toBeCloseTo(dbToGain(6));
    stop();
  });

  it('a context that will not run leaves the element UNROUTED and lowers through its volume', async () => {
    const video = new FakeVideo();
    const { ctx } = fakeContext('suspended', 'suspended');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stop = attachLoudnessGain(video as unknown as HTMLMediaElement, LOUD, envOf(ctx));
    video.unmuteAndPlay();
    await vi.waitFor(() => expect(video.volume).toBeCloseTo(dbToGain(-6)));
    expect(ctx.createMediaElementSource).not.toHaveBeenCalled();
    expect(warn.mock.calls[0][0]).toContain('FALLBACK');
    // A level written later keeps the attenuation (the shared volume level, PR #3372).
    expect(elementVolumeFor(video as unknown as HTMLMediaElement, 0.5)).toBeCloseTo(
      0.5 * dbToGain(-6)
    );
    stop();
    expect(video.volume).toBeCloseTo(1);
    warn.mockRestore();
  });

  it('with no Web Audio, a RAISE is played as is and said', () => {
    const video = new FakeVideo();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stop = attachLoudnessGain(video as unknown as HTMLMediaElement, QUIET, envOf(null));
    video.unmuteAndPlay();
    expect(video.volume).toBe(1);
    expect(warn.mock.calls[0][0]).toContain('played as is');
    stop();
    warn.mockRestore();
  });

  it('an engine that ignores the element volume (iOS) is read back, never assumed', () => {
    const video = new FakeVideo();
    video.ignoresVolume = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stop = attachLoudnessGain(video as unknown as HTMLMediaElement, LOUD, envOf(null));
    video.unmuteAndPlay();
    expect(warn.mock.calls[0][0]).toContain('ignores the element volume');
    expect(elementVolumeFor(video as unknown as HTMLMediaElement, 0.5)).toBe(0.5);
    stop();
    warn.mockRestore();
  });

  it('an element routed before is re-connected at unity when its next attach has no gain', () => {
    const video = new FakeVideo();
    const { ctx, source } = fakeContext();
    const env = envOf(ctx);
    const first = attachLoudnessGain(video as unknown as HTMLMediaElement, LOUD, env);
    video.unmuteAndPlay();
    first();
    // Routed once, the element sounds only through the graph: an attach with no measurement must
    // connect it again, or it would play silent.
    const second = attachLoudnessGain(video as unknown as HTMLMediaElement, undefined, env);
    expect(ctx.createMediaElementSource).toHaveBeenCalledTimes(1);
    const unity = ctx.createGain.mock.results[1].value;
    expect(unity.gain.value).toBe(1);
    expect(source.connect).toHaveBeenLastCalledWith(unity);
    second();
  });

  it('a play on a routed video resumes a context the system suspended', () => {
    const video = new FakeVideo();
    const { ctx } = fakeContext();
    const stop = attachLoudnessGain(video as unknown as HTMLMediaElement, LOUD, envOf(ctx));
    video.unmuteAndPlay();
    ctx.state = 'suspended';
    video.dispatchEvent(new Event('play'));
    expect(ctx.resume).toHaveBeenCalledTimes(1);
    stop();
  });
});
