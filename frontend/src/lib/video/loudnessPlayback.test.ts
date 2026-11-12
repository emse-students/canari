import { describe, expect, it, vi } from 'vitest';
import {
  GAIN_DEADBAND_DB,
  LOUDNESS_TARGET_LUFS,
  LoudnessAudio,
  MAX_BOOST_DB,
  dbToGain,
  elementVolumeFor,
  loudnessGainDb,
  readerLevelOf,
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

  it('a CRAFTED measurement cannot silence a video', () => {
    // 29 LUFS would ask for -43 dB: no programme measures over 0 LUFS.
    expect(loudnessGainDb({ integratedLufs: 29, samplePeakDbfs: 30 })).toBe(0);
    // Very loud with a peak 20 dB UNDER its loudness: no signal does that.
    expect(loudnessGainDb({ integratedLufs: -1, samplePeakDbfs: -21 })).toBe(0);
  });
});

/** A `<video>` as the wiring sees it: its mute, pause and volume, and its events. */
class FakeVideo extends EventTarget {
  tagName = 'VIDEO';
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
    this.dispatchEvent(new Event('play'));
  }
  autoplayMuted() {
    this.paused = false;
    this.dispatchEvent(new Event('play'));
  }
  pause() {
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  }
  play() {
    this.paused = false;
    this.dispatchEvent(new Event('play'));
  }
}

/**
 * An HONEST `AudioContext`: an element accepts ONE source node in its life (a second
 * `createMediaElementSource` throws `InvalidStateError`, as every engine does), and `resume()` can
 * be told to never answer.
 */
class FakeContext {
  static sourced = new WeakSet<object>();
  state: AudioContextState = 'running';
  destination = { name: 'destination' };
  resumesTo: AudioContextState | null = 'running';
  /** `resume()` returns a promise that never settles. */
  resumeHangs = false;
  sources: {
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    context: FakeContext;
  }[] = [];
  gains: {
    gain: { value: number };
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }[] = [];
  resume = vi.fn(() => {
    if (this.resumeHangs) return new Promise<void>(() => {});
    if (this.resumesTo) this.state = this.resumesTo;
    return Promise.resolve();
  });
  suspend = vi.fn(async () => {
    this.state = 'suspended';
  });
  close = vi.fn(async () => {
    this.state = 'closed';
  });
  createMediaElementSource(el: object) {
    if (FakeContext.sourced.has(el)) {
      throw new DOMException('already connected to a source node', 'InvalidStateError');
    }
    FakeContext.sourced.add(el);
    const node = { connect: vi.fn(), disconnect: vi.fn(), context: this };
    this.sources.push(node);
    return node;
  }
  createGain() {
    const node = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
    this.gains.push(node);
    return node;
  }
}

function setup(
  options: {
    webkit?: boolean;
    noWebAudio?: boolean;
    initial?: AudioContextState;
    /** What `resume()` leaves the context in (`null`: unchanged). */
    resumesTo?: AudioContextState | null;
    /** `resume()` never answers. */
    resumeHangs?: boolean;
    /** The element is NOT registered with the playback arbiter. */
    unarbitrated?: boolean;
  } = {}
) {
  const contexts: FakeContext[] = [];
  let screen: ((onScreen: boolean) => void) | null = null;
  const audio = new LoudnessAudio({
    createContext: () => {
      if (options.noWebAudio) return null;
      const ctx = new FakeContext();
      if (options.initial) ctx.state = options.initial;
      if (options.resumesTo !== undefined) ctx.resumesTo = options.resumesTo;
      ctx.resumeHangs = options.resumeHangs ?? false;
      contexts.push(ctx);
      return ctx as unknown as AudioContext;
    },
    isWebKit: () => options.webkit ?? false,
    isArbitrated: () => !options.unarbitrated,
    onScreenChange: (fn) => {
      screen = fn;
      return () => (screen = null);
    },
  });
  const mount = (
    loudness?: { integratedLufs: number; samplePeakDbfs: number },
    streamed = false
  ) => {
    const video = new FakeVideo();
    const handle = audio.attach(video as unknown as HTMLMediaElement, { streamed });
    handle.setLoudness(loudness);
    return { video, handle };
  };
  return { audio, contexts, mount, leaveScreen: () => screen?.(false) };
}

const LOUD = { integratedLufs: -8, samplePeakDbfs: 0 }; // -6 dB
const QUIET = { integratedLufs: -20, samplePeakDbfs: -10 }; // +6 dB

describe('LoudnessAudio - the wiring', () => {
  it('an OLD video (no measurement) is untouched: no context, no volume', () => {
    const { contexts, mount } = setup();
    const { video, handle } = mount(undefined);
    video.unmuteAndPlay();
    handle.prime();
    expect(contexts).toHaveLength(0);
    expect(video.volume).toBe(1);
    handle.destroy();
  });

  it('muted autoplay never asks for the AudioContext', () => {
    const { contexts, mount } = setup();
    const { video, handle } = mount(LOUD);
    video.autoplayMuted();
    expect(contexts).toHaveLength(0);
    handle.destroy();
  });

  it('routes source -> gain -> destination the first time the video is audible', () => {
    const { contexts, mount } = setup();
    const { video, handle } = mount(LOUD);
    video.unmuteAndPlay();
    const [ctx] = contexts;
    expect(ctx.gains[0].gain.value).toBeCloseTo(dbToGain(-6));
    expect(ctx.sources[0].connect).toHaveBeenCalledWith(ctx.gains[0]);
    expect(ctx.gains[0].connect).toHaveBeenCalledWith(ctx.destination);
    expect(video.volume).toBe(1);
    handle.destroy();
    expect(ctx.sources[0].disconnect).toHaveBeenCalled();
    expect(ctx.gains[0].disconnect).toHaveBeenCalled();
  });

  it('a new measurement for the same element changes the gain, never makes a second source', () => {
    const { contexts, mount } = setup();
    const { video, handle } = mount(LOUD);
    video.unmuteAndPlay();
    handle.setLoudness(QUIET);
    handle.setLoudness(undefined);
    const [ctx] = contexts;
    expect(ctx.sources).toHaveLength(1);
    // A routed element sounds only through the graph: no measurement is unity, never a disconnect.
    expect(ctx.gains[0].gain.value).toBe(1);
    handle.destroy();
  });

  it('SUSPENDS the output when no routed video plays, and resumes it on play', () => {
    const { contexts, mount } = setup();
    const a = mount(LOUD);
    const b = mount(QUIET);
    a.video.unmuteAndPlay();
    b.video.unmuteAndPlay();
    const [ctx] = contexts;
    a.video.pause();
    expect(ctx.suspend).not.toHaveBeenCalled();
    b.video.pause();
    expect(ctx.suspend).toHaveBeenCalledTimes(1);
    expect(ctx.state).toBe('suspended');
    b.video.play();
    expect(ctx.resume).toHaveBeenCalled();
    a.handle.destroy();
    b.handle.destroy();
  });

  it('leaving the screen never suspends under a routed element still PLAYING (a note behind a web tab)', () => {
    // On native the arbiter pauses it first, which lands as a `pause`; on web it plays on.
    const { contexts, mount, leaveScreen } = setup();
    const { video, handle } = mount(LOUD);
    video.unmuteAndPlay();
    leaveScreen();
    expect(contexts[0].suspend).not.toHaveBeenCalled();
    expect(contexts[0].state).toBe('running');
    handle.destroy();
  });

  it('a gesture that resumed the context with NOTHING routed playing is suspended when the app leaves the screen', async () => {
    // The reviewer's case: an unmute (or a play tap) primes for a measured neighbour, but no routed
    // element ever plays - an unmeasured reel, a refused play(). Nothing else would suspend it.
    const { contexts, mount, leaveScreen, audio } = setup({ initial: 'suspended' });
    const { handle } = mount(LOUD);
    audio.prime();
    await Promise.resolve();
    expect(contexts[0].state).toBe('running');
    leaveScreen();
    expect(contexts[0].suspend).toHaveBeenCalledOnce();
    expect(contexts[0].state).toBe('suspended');
    handle.destroy();
  });

  it('a second tap that finds the waited resume still unanswered SAYS so', () => {
    const { mount } = setup({ initial: 'suspended', resumeHangs: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { handle } = mount(LOUD);
    const first = handle.prime();
    expect(first).toBeInstanceOf(Promise);
    expect(warn).not.toHaveBeenCalled();
    expect(handle.prime()).toBe(first);
    const said = warn.mock.calls.flat().map(String);
    expect(said.some((l) => l.includes('still unanswered'))).toBe(true);
    handle.destroy();
    warn.mockRestore();
  });

  it('never routes an element the playback arbiter does not know, and says so', () => {
    const { contexts, mount } = setup({ unarbitrated: true });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { video, handle } = mount(LOUD);
    video.unmuteAndPlay();
    expect(contexts[0].sources).toHaveLength(0);
    expect(String(error.mock.calls[0][0])).toContain('not registered with the playback arbiter');
    // The fallback's attenuation still applies where the engine honours a volume.
    expect(video.volume).toBeCloseTo(dbToGain(-6));
    handle.destroy();
    error.mockRestore();
    warn.mockRestore();
  });

  it('a play tap on an ALREADY ROUTED element resumes its suspended context inside the tap', async () => {
    const { contexts, mount } = setup();
    const { video, handle } = mount(LOUD);
    video.unmuteAndPlay();
    video.pause();
    expect(contexts[0].state).toBe('suspended');
    const resumes = contexts[0].resume.mock.calls.length;
    const primed = handle.prime();
    // Called synchronously, inside the gesture - and settled once it answered.
    expect(contexts[0].resume.mock.calls.length).toBe(resumes + 1);
    await primed;
    expect(contexts[0].state).toBe('running');
    handle.destroy();
  });

  it('CLOSES the context only when the last routed video unmounts, then makes a new one', () => {
    const { contexts, mount } = setup();
    const a = mount(LOUD);
    const b = mount(QUIET);
    a.video.unmuteAndPlay();
    b.video.unmuteAndPlay();
    a.handle.destroy();
    expect(contexts[0].close).not.toHaveBeenCalled();
    b.handle.destroy();
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
    const c = mount(LOUD);
    c.video.unmuteAndPlay();
    expect(contexts).toHaveLength(2);
    c.handle.destroy();
  });

  it('the unmute gesture resumes the context SYNCHRONOUSLY, before the element is audible', () => {
    const { contexts, mount, audio } = setup({ initial: 'suspended' });
    const { video, handle } = mount(QUIET);
    // The gesture: the store's unmute primes, inside the handler, before any `volumechange`.
    audio.prime();
    expect(contexts[0].resume).toHaveBeenCalledTimes(1);
    expect(contexts[0].state).toBe('running');
    video.unmuteAndPlay();
    expect(contexts[0].gains[0].gain.value).toBeCloseTo(dbToGain(6));
    handle.destroy();
  });

  it('a SUSPENDED context: the tap returns its resume to wait on, and the route is built at the gain', async () => {
    const { contexts, mount } = setup({ initial: 'suspended' });
    const { video, handle } = mount(LOUD);
    // The context is made on the tap itself.
    const primed = handle.prime();
    expect(primed).toBeInstanceOf(Promise);
    await primed;
    expect(contexts[0].state).toBe('running');
    video.unmuteAndPlay();
    expect(contexts[0].gains[0].gain.value).toBeCloseTo(dbToGain(-6));
    handle.destroy();
  });

  it('an INTERRUPTED context (a phone call on WebKit): nothing to wait on, the element plays on the volume fallback, said at warn', () => {
    const { contexts, mount } = setup({
      initial: 'interrupted' as AudioContextState,
      resumeHangs: true,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { video, handle } = mount(LOUD);
    // Its resume() is still asked inside the tap - and never answers.
    expect(handle.prime()).toBeNull();
    expect(contexts[0].resume).toHaveBeenCalledTimes(1);
    expect(video.volume).toBeCloseTo(dbToGain(-6));
    const said = warn.mock.calls.flat().map(String);
    expect(said.some((l) => l.includes('FALLBACK') && l.includes('interrupted'))).toBe(true);
    // It plays unrouted: no graph is ever built under it.
    video.unmuteAndPlay();
    expect(contexts[0].sources).toHaveLength(0);
    handle.destroy();
    warn.mockRestore();
  });

  it('a CLOSED context is not waited on either', () => {
    const { mount } = setup({ initial: 'closed', resumesTo: null });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { video, handle } = mount(LOUD);
    expect(handle.prime()).toBeNull();
    expect(video.volume).toBeCloseTo(dbToGain(-6));
    handle.destroy();
    warn.mockRestore();
  });

  it('a resume() that never answers leaves the video UNROUTED (audible) and is said', () => {
    const { contexts, mount } = setup({ initial: 'suspended', resumeHangs: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { video, handle } = mount(LOUD);
    video.unmuteAndPlay();
    video.dispatchEvent(new Event('volumechange'));
    video.dispatchEvent(new Event('volumechange'));
    expect(contexts[0].sources).toHaveLength(0);
    expect(video.muted).toBe(false);
    const said = warn.mock.calls.flat().filter((l) => String(l).includes('has not answered'));
    expect(said).toHaveLength(1);
    handle.destroy();
    warn.mockRestore();
  });

  it('a context that will not run leaves the element UNROUTED and lowers through its volume', async () => {
    const { contexts, mount } = setup({ initial: 'suspended', resumesTo: null });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { video, handle } = mount(LOUD);
    video.unmuteAndPlay();
    await vi.waitFor(() => expect(video.volume).toBeCloseTo(dbToGain(-6)));
    expect(contexts[0].sources).toHaveLength(0);
    expect(warn.mock.calls.flat().join(' ')).toContain(
      'FALLBACK: the AudioContext stayed suspended'
    );
    // A level written later keeps the attenuation, and the reader's level reads back undivided.
    expect(elementVolumeFor(video as unknown as HTMLMediaElement, 0.5)).toBeCloseTo(
      0.5 * dbToGain(-6)
    );
    expect(readerLevelOf(video as unknown as HTMLMediaElement)).toBeCloseTo(1);
    handle.destroy();
    expect(video.volume).toBeCloseTo(1);
    warn.mockRestore();
  });

  it('a routed play whose context is not running after resume() is said: routed and SILENT', async () => {
    const { contexts, mount } = setup();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { video, handle } = mount(LOUD);
    video.unmuteAndPlay();
    video.pause();
    contexts[0].resumesTo = null;
    video.play();
    await vi.waitFor(() =>
      expect(error.mock.calls.flat().join(' ')).toContain('routed and SILENT')
    );
    handle.destroy();
    error.mockRestore();
  });

  it('a STREAM on WebKit is never routed: attenuation only, said once', () => {
    const { contexts, mount } = setup({ webkit: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { video, handle } = mount(LOUD, true);
    video.unmuteAndPlay();
    handle.setLoudness(LOUD);
    expect(contexts).toHaveLength(0);
    expect(video.volume).toBeCloseTo(dbToGain(-6));
    const said = warn.mock.calls.flat().filter((l) => String(l).includes('stream on WebKit'));
    expect(said).toHaveLength(1);
    handle.destroy();
    warn.mockRestore();
  });

  it('a blob on WebKit IS routed', () => {
    const { contexts, mount } = setup({ webkit: true });
    const { video, handle } = mount(LOUD, false);
    video.unmuteAndPlay();
    expect(contexts[0].sources).toHaveLength(1);
    handle.destroy();
  });

  it('with no Web Audio, a RAISE is played as is and said', () => {
    const { mount } = setup({ noWebAudio: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { video, handle } = mount(QUIET);
    video.unmuteAndPlay();
    expect(video.volume).toBe(1);
    expect(warn.mock.calls[0][0]).toContain('played as is');
    handle.destroy();
    warn.mockRestore();
  });

  it('an engine that ignores the element volume (iOS) is read back, never assumed', () => {
    const { audio } = setup({ noWebAudio: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const video = new FakeVideo();
    video.ignoresVolume = true;
    const handle = audio.attach(video as unknown as HTMLMediaElement, { streamed: false });
    handle.setLoudness(LOUD);
    video.unmuteAndPlay();
    expect(warn.mock.calls.flat().join(' ')).toContain('ignores the element volume');
    expect(elementVolumeFor(video as unknown as HTMLMediaElement, 0.5)).toBe(0.5);
    handle.destroy();
    warn.mockRestore();
  });

  it('the fake is honest: a second source for one element throws InvalidStateError', () => {
    const ctx = new FakeContext();
    const el = {};
    ctx.createMediaElementSource(el);
    expect(() => ctx.createMediaElementSource(el)).toThrow(/already connected/);
  });
});
