// @vitest-environment happy-dom
/**
 * A VOICE NOTE PLAYS NEAR ONE LOUDNESS (owner, 2026-11-12), through the video's ONE route
 * (`loudnessPlayback.ts`, the real singleton here - nothing of it is mocked): a measured note is
 * routed through Web Audio at the law's gain, and a note sent before the measurement existed is
 * never routed at all. Only the engine's `AudioContext` is a fake, the one thing happy-dom lacks.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import VoiceMessagePlayer from './VoiceMessagePlayer.svelte';
import { dbToGain } from '$lib/video/loudnessPlayback';
import type { MediaLoudness } from '$lib/video/loudnessMeter';

/** The contexts the player's route made, in order. */
const contexts: FakeContext[] = [];

/** An `AudioContext` reduced to what the route calls; it starts suspended, as before a gesture. */
class FakeContext {
  state: AudioContextState = 'suspended';
  destination = { name: 'destination' };
  sources: object[] = [];
  gains: { gain: { value: number }; connect: () => void; disconnect: () => void }[] = [];
  resume = vi.fn(() => {
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
  Object.defineProperty(window, 'AudioContext', { configurable: true, value: FakeContext });
});

afterEach(() => {
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
  const tapPlay = async () => {
    target.querySelector<HTMLButtonElement>('button')!.click();
    flushSync();
    // The route connects once the gesture's `resume()` has answered.
    await Promise.resolve();
    await Promise.resolve();
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
