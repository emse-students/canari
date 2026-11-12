// @vitest-environment happy-dom
/**
 * THE PLAYER APPLIES THE MEASURED LOUDNESS (owner, 2026-11-11), through the app's ONE AudioContext,
 * mocked here HONESTLY (one source node per element, a second one throws): a measured video is
 * routed the first time it is audible, the context is closed when the last routed video unmounts,
 * the reader's unmute resumes it INSIDE the gesture, and a video with no measurement never touches
 * Web Audio.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import VideoPlayer from './VideoPlayer.svelte';
import { videoSound } from '$lib/stores/videoSound.svelte';
import { dbToGain } from '$lib/video/loudnessPlayback';
import { isArbitrated } from '$lib/actions/playbackArbiter';
import type { MediaLoudness } from '$lib/video/loudnessMeter';

const sourced = new WeakSet<object>();
const contexts: FakeAudioContext[] = [];
let initialState: AudioContextState = 'running';

class FakeAudioContext {
  state: AudioContextState = initialState;
  destination = {};
  sources: {
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    context: unknown;
  }[] = [];
  gains: {
    gain: { value: number };
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }[] = [];
  constructor() {
    contexts.push(this);
  }
  createMediaElementSource(el: object) {
    if (sourced.has(el)) throw new DOMException('already connected', 'InvalidStateError');
    sourced.add(el);
    const node = { connect: vi.fn(), disconnect: vi.fn(), context: this };
    this.sources.push(node);
    return node;
  }
  createGain() {
    const node = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
    this.gains.push(node);
    return node;
  }
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
}

beforeEach(() => {
  videoSound.setMuted(true);
  initialState = 'running';
  contexts.length = 0;
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});
afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mountPlayer(loudness?: MediaLoudness) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(VideoPlayer, {
    target,
    props: { src: 'blob:clip', variant: 'chat', ...(loudness ? { loudness } : {}) },
  });
  flushSync();
  return { component, video: target.querySelector('video')! };
}

/** The reader turns the sound on and it plays, as the engine reports it. */
function playAudible(video: HTMLVideoElement) {
  Object.defineProperty(video, 'paused', { configurable: true, get: () => false });
  video.muted = false;
  video.dispatchEvent(new Event('volumechange'));
  video.dispatchEvent(new Event('play'));
  flushSync();
}

it('an OLD video (no measurement) plays as it always did: no Web Audio at all', () => {
  const { component, video } = mountPlayer();
  playAudible(video);
  expect(contexts).toHaveLength(0);
  unmount(component);
});

it('a loud video is routed the first time it is audible; its unmount releases and CLOSES', () => {
  const { component, video } = mountPlayer({ integratedLufs: -8, samplePeakDbfs: -0.5 });
  expect(contexts).toHaveLength(0);
  playAudible(video);
  const [ctx] = contexts;
  expect(ctx.sources).toHaveLength(1);
  expect(ctx.gains[0].gain.value).toBeCloseTo(dbToGain(-6));
  unmount(component);
  expect(ctx.sources[0].disconnect).toHaveBeenCalled();
  expect(ctx.gains[0].disconnect).toHaveBeenCalled();
  expect(ctx.close).toHaveBeenCalledTimes(1);
});

it('two measured videos share ONE AudioContext', () => {
  const a = mountPlayer({ integratedLufs: -8, samplePeakDbfs: -0.5 });
  const b = mountPlayer({ integratedLufs: -20, samplePeakDbfs: -12 });
  playAudible(a.video);
  playAudible(b.video);
  expect(contexts).toHaveLength(1);
  expect(contexts[0].gains.map((g) => Number(g.gain.value.toFixed(3)))).toEqual([
    Number(dbToGain(-6).toFixed(3)),
    Number(dbToGain(6).toFixed(3)),
  ]);
  unmount(a.component);
  expect(contexts[0].close).not.toHaveBeenCalled();
  unmount(b.component);
  expect(contexts[0].close).toHaveBeenCalledTimes(1);
});

it("the reader's unmute resumes the context INSIDE the gesture, before any element event", () => {
  initialState = 'suspended';
  const { component } = mountPlayer({ integratedLufs: -20, samplePeakDbfs: -12 });
  videoSound.setMuted(false);
  // Synchronously, in the same call: WebKit honours a resume() only inside the gesture.
  expect(contexts).toHaveLength(1);
  expect(contexts[0].resume).toHaveBeenCalledTimes(1);
  unmount(component);
});

it('a new object with the same numbers changes nothing', async () => {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const props = $state({
    src: 'blob:clip',
    variant: 'chat' as const,
    loudness: { integratedLufs: -8, samplePeakDbfs: -0.5 },
  });
  const component = mount(VideoPlayer, { target, props });
  flushSync();
  const video = target.querySelector('video')!;
  playAudible(video);
  props.loudness = { integratedLufs: -8, samplePeakDbfs: -0.5 };
  flushSync();
  expect(contexts[0].sources).toHaveLength(1);
  expect(contexts[0].gains).toHaveLength(1);
  unmount(component);
});

it.each(['lightbox', 'reel', 'feed', 'chat', 'conversation'] as const)(
  'a %s video is registered with the playback arbiter - the route only takes a registered element',
  (variant) => {
    // The output's lifetime rests on the arbiter's pauses (review of #3394): an unregistered
    // element is never routed, so every variant must register its element.
    const target = document.createElement('div');
    document.body.appendChild(target);
    const component = mount(VideoPlayer, { target, props: { src: 'blob:clip', variant } });
    flushSync();
    expect(isArbitrated(target.querySelector('video')!)).toBe(true);
    unmount(component);
  }
);
