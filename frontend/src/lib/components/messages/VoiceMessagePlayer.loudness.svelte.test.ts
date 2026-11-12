// @vitest-environment happy-dom
/**
 * A VOICE NOTE PLAYS NEAR ONE LOUDNESS (owner, 2026-11-12), through the video's ONE route
 * (`loudnessPlayback.ts`, the real singleton here - nothing of it is mocked): a measured note is
 * routed through Web Audio at the law's gain, and a note sent before the measurement existed is
 * never routed at all. Only the engine's `AudioContext` is a fake, the one thing happy-dom lacks -
 * the playback arbiter is the real one too, since the output's lifetime rests on its pauses.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/** Whether this test runs as the native app (the arbiter pauses everything on leaving the screen). */
const runtime = vi.hoisted(() => ({ native: false }));
vi.mock('$lib/utils/appVersion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/appVersion')>()),
  isMobileTauriRuntime: () => runtime.native,
}));

import { flushSync, mount, unmount } from 'svelte';
import VoiceMessagePlayer from './VoiceMessagePlayer.svelte';
import { dbToGain } from '$lib/video/loudnessPlayback';
import { isArbitrated } from '$lib/actions/playbackArbiter';
import type { MediaLoudness } from '$lib/video/loudnessMeter';

/** The contexts the player's route made, in order. */
const contexts: FakeContext[] = [];
/** The state a new context starts in, and whether its `resume()` ever answers. */
const engine = { initial: 'suspended' as AudioContextState, resumeHangs: false };

/** An `AudioContext` reduced to what the route calls; it starts suspended, as before a gesture. */
class FakeContext {
  state: AudioContextState = engine.initial;
  destination = { name: 'destination' };
  sources: object[] = [];
  gains: { gain: { value: number }; connect: () => void; disconnect: () => void }[] = [];
  resume = vi.fn(() => {
    if (engine.resumeHangs) return new Promise<void>(() => {});
    this.state = 'running';
    return Promise.resolve();
  });
  suspend = vi.fn(async () => {
    this.state = 'suspended';
  });
  close = vi.fn(async () => {
    this.state = 'closed';
  });
  constructor() {
    contexts.push(this);
  }
  createMediaElementSource(el: object) {
    this.sources.push(el);
    return { connect: () => {}, disconnect: () => {}, context: this };
  }
  createGain() {
    const node = { gain: { value: 1 }, connect: () => {}, disconnect: () => {} };
    this.gains.push(node);
    return node;
  }
}

const mounted: (() => void)[] = [];

beforeEach(() => {
  contexts.length = 0;
  engine.initial = 'suspended';
  engine.resumeHangs = false;
  Object.defineProperty(window, 'AudioContext', { configurable: true, value: FakeContext });
});

/** The page's visibility, as a tab switch changes it. */
function setTabHidden(hidden: boolean) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

afterEach(() => {
  setTabHidden(false);
  runtime.native = false;
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mountVoice(loudness?: MediaLoudness) {
  // No decode here: the waveform is not what is tested, and a refused fetch is logged, not thrown.
  vi.stubGlobal('fetch', () => Promise.reject(new Error('no network in this test')));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(VoiceMessagePlayer, {
    target,
    props: { src: 'blob:voice', ...(loudness ? { loudness } : {}) },
  });
  mounted.push(() => unmount(component));
  flushSync();
  const audio = target.querySelector('audio')!;
  let paused = true;
  Object.defineProperty(audio, 'paused', { configurable: true, get: () => paused });
  audio.play = vi.fn(() => {
    paused = false;
    audio.dispatchEvent(new Event('play'));
    return Promise.resolve();
  });
  audio.pause = vi.fn(() => {
    paused = true;
    audio.dispatchEvent(new Event('pause'));
  });
  const tapPlay = async () => {
    target.querySelector<HTMLButtonElement>('button')!.click();
    flushSync();
    // `play()` waits for the gesture's `resume()`; the route connects on the `play` that follows.
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { audio, tapPlay };
}

it('routes a LOUD measured note through Web Audio and lowers it to the target', async () => {
  const { audio, tapPlay } = mountVoice({ integratedLufs: -6, samplePeakDbfs: -1 });
  await tapPlay();
  expect(contexts).toHaveLength(1);
  // A decrypted blob is routed on WebKit too - happy-dom's engine reads as WebKit.
  expect(contexts[0].sources).toEqual([audio]);
  expect(contexts[0].gains).toHaveLength(1);
  // -14 LUFS target, -6 measured: -8 dB.
  expect(contexts[0].gains[0].gain.value).toBeCloseTo(dbToGain(-8), 6);
});

it('raises a QUIET measured note by at most the boost cap', async () => {
  const { tapPlay } = mountVoice({ integratedLufs: -26, samplePeakDbfs: -10 });
  await tapPlay();
  expect(contexts[0].gains[0].gain.value).toBeCloseTo(dbToGain(6), 6);
});

it('resumes the context INSIDE the play tap, before play() is asked', async () => {
  const { audio, tapPlay } = mountVoice({ integratedLufs: -6, samplePeakDbfs: -1 });
  const calls: string[] = [];
  const play = audio.play;
  audio.play = vi.fn(() => {
    calls.push(`play (context ${contexts[0]?.resume.mock.calls.length ?? 0} resume)`);
    return play.call(audio);
  });
  await tapPlay();
  expect(calls).toEqual(['play (context 1 resume)']);
});

it('leaves an OLD note - no measurement - unrouted and at its own volume', async () => {
  const { audio, tapPlay } = mountVoice();
  await tapPlay();
  expect(contexts).toHaveLength(0);
  expect(audio.volume).toBe(1);
});

it('ON WEB, a routed note keeps sounding behind another tab - its output is never suspended', async () => {
  const { audio, tapPlay } = mountVoice({ integratedLufs: -6, samplePeakDbfs: -1 });
  await tapPlay();
  expect(contexts[0].state).toBe('running');
  setTabHidden(true);
  // The arbiter keeps a note the reader started (web and desktop), and so does the route.
  expect(audio.pause).not.toHaveBeenCalled();
  expect(contexts[0].suspend).not.toHaveBeenCalled();
  expect(contexts[0].state).toBe('running');
});

it('ON NATIVE, leaving the screen pauses the note through the arbiter, and that pause suspends', async () => {
  runtime.native = true;
  const { audio, tapPlay } = mountVoice({ integratedLufs: -6, samplePeakDbfs: -1 });
  await tapPlay();
  setTabHidden(true);
  expect(audio.pause).toHaveBeenCalledOnce();
  expect(contexts[0].suspend).toHaveBeenCalledOnce();
  expect(contexts[0].state).toBe('suspended');
});

it('starts the note only once the resume answered: the first syllable is already at its gain', async () => {
  const { audio, tapPlay } = mountVoice({ integratedLufs: -6, samplePeakDbfs: -1 });
  const stateAtPlay: string[] = [];
  const play = audio.play;
  audio.play = vi.fn(() => {
    stateAtPlay.push(contexts[0].state);
    return play.call(audio);
  });
  await tapPlay();
  expect(stateAtPlay).toEqual(['running']);
  // Built on that very `play`, before a sample left unrouted.
  expect(contexts[0].gains).toHaveLength(1);
});

it('the element of a note is registered with the playback arbiter - the route only takes those', () => {
  const { audio } = mountVoice();
  expect(isArbitrated(audio)).toBe(true);
});

it('an INTERRUPTED context (WebKit, a phone call) never holds the tap: play() runs in it, on the volume fallback', () => {
  engine.initial = 'interrupted' as AudioContextState;
  engine.resumeHangs = true;
  const { audio } = mountVoice({ integratedLufs: -6, samplePeakDbfs: -1 });
  const warn = vi.mocked(console.warn);
  document.querySelector<HTMLButtonElement>('button')!.click();
  // Synchronously, inside the tap - no wait on a resume() that may never answer.
  expect(audio.play).toHaveBeenCalledOnce();
  expect(contexts[0].sources).toHaveLength(0);
  expect(
    warn.mock.calls
      .flat()
      .map(String)
      .some((l) => l.includes('FALLBACK'))
  ).toBe(true);
});
