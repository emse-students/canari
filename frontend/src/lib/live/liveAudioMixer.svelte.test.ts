/**
 * THE DESKTOP LIVE'S SOUND (owner, 2026-11-14): one output track for the whole live, the microphone
 * muted by its gain (never a stopped track), the share's sound heard only while the screen is
 * shown, an input replaced behind the same output, and the context's state READ, never awaited.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveAudioMixer, type MixerContext } from './liveAudioMixer.svelte';
import { FakeMediaStream } from './liveStudio.test-helper';

function fakeContext(initial: AudioContextState = 'suspended') {
  const listeners: (() => void)[] = [];
  const gains: { gain: { value: number }; connect: ReturnType<typeof vi.fn> }[] = [];
  const sources: { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = [];
  const out = { kind: 'audio', stop: vi.fn() };
  const ctx = {
    state: initial,
    resume: vi.fn(() => new Promise<void>(() => {})),
    close: vi.fn(async () => {
      ctx.state = 'closed';
    }),
    addEventListener: vi.fn((_t: string, l: () => void) => listeners.push(l)),
    createGain: vi.fn(() => {
      const g = { gain: { value: -1 }, connect: vi.fn() };
      gains.push(g);
      return g;
    }),
    createMediaStreamSource: vi.fn(() => {
      const s = { connect: vi.fn(), disconnect: vi.fn() };
      sources.push(s);
      return s;
    }),
    createMediaStreamDestination: vi.fn(() => ({ stream: new FakeMediaStream([out as never]) })),
  };
  return {
    ctx,
    gains,
    sources,
    out,
    /** The engine changes the state and fires `statechange`. */
    becomes(state: AudioContextState) {
      ctx.state = state;
      for (const l of listeners) l();
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('MediaStream', FakeMediaStream);
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const audio = () => ({ kind: 'audio', stop: vi.fn() }) as unknown as MediaStreamTrack;

describe('LiveAudioMixer', () => {
  it('starts with the microphone open and the share silent', () => {
    const f = fakeContext();
    const mixer = new LiveAudioMixer(f.ctx as unknown as MixerContext);
    const [mic, share] = f.gains;
    expect(mic.gain.value).toBe(1);
    expect(share.gain.value).toBe(0);
    expect(mixer.track).toBe(f.out);
  });

  it('mutes the microphone by its gain - the output track is never stopped', () => {
    const f = fakeContext();
    const mixer = new LiveAudioMixer(f.ctx as unknown as MixerContext);
    mixer.setMic(audio());
    mixer.setMicMuted(true);
    expect(f.gains[0].gain.value).toBe(0);
    expect(f.out.stop).not.toHaveBeenCalled();
    mixer.setMicMuted(false);
    expect(f.gains[0].gain.value).toBe(1);
  });

  it("the share's sound is heard only while the scene shows the screen", () => {
    const f = fakeContext();
    const mixer = new LiveAudioMixer(f.ctx as unknown as MixerContext);
    mixer.setShare(audio());
    mixer.setShareAudible(true);
    expect(f.gains[1].gain.value).toBe(1);
    mixer.setShareAudible(false);
    expect(f.gains[1].gain.value).toBe(0);
  });

  it('a replaced input is disconnected and the new one feeds the SAME output', () => {
    const f = fakeContext();
    const mixer = new LiveAudioMixer(f.ctx as unknown as MixerContext);
    const track = mixer.track;
    mixer.setMic(audio());
    mixer.setMic(audio());
    expect(f.sources[0].disconnect).toHaveBeenCalled();
    expect(f.sources[1].connect).toHaveBeenCalledWith(f.gains[0]);
    mixer.setMic(null);
    expect(f.sources[1].disconnect).toHaveBeenCalled();
    expect(mixer.track).toBe(track);
  });

  it("follows the context's state by its event, and wakes it without awaiting", () => {
    const f = fakeContext('suspended');
    const mixer = new LiveAudioMixer(f.ctx as unknown as MixerContext);
    expect(mixer.state).toBe('suspended');
    // `resume()` never settles here (a resume outside a gesture can stay pending): wake returns anyway.
    mixer.wake();
    expect(f.ctx.resume).toHaveBeenCalledTimes(1);
    f.becomes('running');
    expect(mixer.state).toBe('running');
    mixer.wake();
    expect(f.ctx.resume).toHaveBeenCalledTimes(1);
  });

  it('close stops the output and closes the context', () => {
    const f = fakeContext('running');
    const mixer = new LiveAudioMixer(f.ctx as unknown as MixerContext);
    mixer.close();
    expect(f.out.stop).toHaveBeenCalled();
    expect(f.ctx.close).toHaveBeenCalled();
  });
});
