/**
 * ONE CHANNEL, WHATEVER THE ENGINE GRANTED (iPhone 12, `1.7.3-alpha.4`: a voice note was AAC in two
 * channels while mono was asked). The decision is the track's reported channel count; the graph is
 * the engine's own downmix, pinned to one channel.
 */
import { describe, it, expect, vi } from 'vitest';
import { DownmixNotRunningError, monoRecordingStream } from './monoRecording';

function microphone(settings: MediaTrackSettings) {
  const track = { getSettings: () => settings, stop: vi.fn() };
  return { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
}

function fakeContext(state: AudioContextState = 'running') {
  const sinkTrack = { stop: vi.fn() };
  const sink = {
    channelCount: 2,
    channelCountMode: 'max' as ChannelCountMode,
    channelInterpretation: 'discrete' as ChannelInterpretation,
    stream: { getTracks: () => [sinkTrack] },
  };
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const context = {
    state: state as AudioContextState,
    sampleRate: 48000,
    onstatechange: null as (() => void) | null,
    createMediaStreamSource: vi.fn(() => source),
    createMediaStreamDestination: vi.fn(() => sink),
    resume: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  };
  return { context, sink, source, sinkTrack };
}

describe('monoRecordingStream', () => {
  it('records a track that reports one channel as granted, with no graph at all', async () => {
    const create = vi.fn();
    const mic = microphone({ channelCount: 1, sampleRate: 48000 });
    const recorded = await monoRecordingStream(mic, create);
    expect(recorded.stream).toBe(mic);
    expect(recorded.downmixed).toBe(false);
    expect(create).not.toHaveBeenCalled();
    recorded.release();
  });

  it.each([
    ['two channels', { channelCount: 2, sampleRate: 48000 }],
    ['no channel count reported (WebKit)', { sampleRate: 48000 }],
  ])('downmixes %s to ONE channel and records the downmix', async (_name, settings) => {
    const fake = fakeContext();
    const create = vi.fn(() => fake.context as unknown as AudioContext);
    const recorded = await monoRecordingStream(microphone(settings), create);

    expect(create).toHaveBeenCalledWith(48000);
    expect(recorded.downmixed).toBe(true);
    expect(recorded.stream).toBe(fake.sink.stream);
    expect(fake.sink.channelCount).toBe(1);
    expect(fake.sink.channelCountMode).toBe('explicit');
    expect(fake.sink.channelInterpretation).toBe('speakers');
    expect(fake.source.connect).toHaveBeenCalledWith(fake.sink);
    expect(fake.context.resume).not.toHaveBeenCalled();
  });

  it('resolves a context the engine made suspended only once it RUNS', async () => {
    const fake = fakeContext('suspended');
    fake.context.resume.mockImplementation(() => {
      fake.context.state = 'running';
      return Promise.resolve();
    });
    const recorded = await monoRecordingStream(
      microphone({}),
      () => fake.context as unknown as AudioContext
    );
    expect(fake.context.resume).toHaveBeenCalledTimes(1);
    expect(recorded.downmixed).toBe(true);
    expect(fake.context.close).not.toHaveBeenCalled();
  });

  it('REJECTS a context still not running after resume - it would record silence - and closes it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fake = fakeContext('suspended');
    await expect(
      monoRecordingStream(microphone({}), () => fake.context as unknown as AudioContext)
    ).rejects.toBeInstanceOf(DownmixNotRunningError);
    expect(fake.context.close).toHaveBeenCalledTimes(1);
    expect(fake.sinkTrack.stop).toHaveBeenCalledTimes(1);
  });

  it('REJECTS a resume the engine refuses, and closes the context', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fake = fakeContext('suspended');
    fake.context.resume.mockImplementation(() =>
      Promise.reject(new DOMException('not allowed', 'NotAllowedError'))
    );
    await expect(
      monoRecordingStream(microphone({}), () => fake.context as unknown as AudioContext)
    ).rejects.toThrow('not allowed');
    expect(fake.context.close).toHaveBeenCalledTimes(1);
  });

  it('releases the graph, its track and its context once, however often it is asked', async () => {
    const fake = fakeContext();
    const recorded = await monoRecordingStream(
      microphone({ channelCount: 2 }),
      () => fake.context as unknown as AudioContext
    );
    recorded.release();
    recorded.release();
    expect(fake.source.disconnect).toHaveBeenCalledTimes(1);
    expect(fake.sinkTrack.stop).toHaveBeenCalledTimes(1);
    expect(fake.context.close).toHaveBeenCalledTimes(1);
  });

  it('closes the context and rejects when the engine refuses the graph', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fake = fakeContext();
    fake.context.createMediaStreamSource.mockImplementation(() => {
      throw new DOMException('refused', 'NotSupportedError');
    });
    await expect(
      monoRecordingStream(microphone({}), () => fake.context as unknown as AudioContext)
    ).rejects.toThrow('refused');
    expect(fake.context.close).toHaveBeenCalledTimes(1);
  });
});

/**
 * A STEREO INPUT LEAVES MONO WITH ITS HIGH BAND INTACT (reading `1.7.3-alpha.6`, voice row 3: the
 * bench room was silent, so the 12 kHz cutoff of a real note was not read). The graph is the
 * engine's own; this code's part is the configuration that picks the Web Audio spec's `speakers`
 * stereo-to-mono rule, `(L + R) / 2`. Pinned together: the destination is configured so, and that
 * rule applied to a synthetic 48 kHz stereo buffer (1 kHz and 14 kHz tones, in phase as the two
 * capsules of one phone hear one source) keeps the 14 kHz tone at full level. A `discrete` interpretation
 * would drop a channel; an anti-phase sum would cancel the tone - neither is what is configured.
 */
describe('the one-channel downmix keeps the high band', () => {
  const RATE = 48_000;

  /** Amplitude of `hz` in `plane`, by a single-bin Goertzel pass over whole cycles. */
  function amplitudeAt(plane: Float32Array, hz: number): number {
    let re = 0;
    let im = 0;
    for (let i = 0; i < plane.length; i++) {
      const phase = (2 * Math.PI * hz * i) / RATE;
      re += plane[i] * Math.cos(phase);
      im += plane[i] * Math.sin(phase);
    }
    return (2 * Math.hypot(re, im)) / plane.length;
  }

  function stereoTones(): [Float32Array, Float32Array] {
    const frames = RATE; // a whole number of cycles of both tones
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      const v =
        0.2 * Math.sin((2 * Math.PI * 1000 * i) / RATE) +
        0.2 * Math.sin((2 * Math.PI * 14_000 * i) / RATE);
      left[i] = v;
      right[i] = v;
    }
    return [left, right];
  }

  it('configures the spec L/R average on a destination of exactly one channel', async () => {
    const fake = fakeContext();
    await monoRecordingStream(
      microphone({ channelCount: 2, sampleRate: RATE }),
      () => fake.context as unknown as AudioContext
    );
    expect(fake.sink.channelCount).toBe(1);
    expect(fake.sink.channelCountMode).toBe('explicit');
    expect(fake.sink.channelInterpretation).toBe('speakers');
  });

  it('a stereo buffer averaged to one channel keeps its 14 kHz tone (cutoff at or above 12 kHz)', () => {
    const [left, right] = stereoTones();
    const mono = left.map((l, i) => (l + right[i]) / 2);
    expect(mono.length).toBe(left.length);
    expect(amplitudeAt(mono, 1000)).toBeCloseTo(0.2, 3);
    expect(amplitudeAt(mono, 14_000)).toBeCloseTo(0.2, 3);
  });
});
