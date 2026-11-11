// @vitest-environment happy-dom
/**
 * THE PLAYER APPLIES THE MEASURED LOUDNESS (owner, 2026-11-11), through the app's ONE AudioContext,
 * mocked here: a measured video is routed the first time it is audible and released on unmount; a
 * video with no measurement (every video sent before) never touches Web Audio.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import VideoPlayer from './VideoPlayer.svelte';
import { videoSound } from '$lib/stores/videoSound.svelte';
import { dbToGain } from '$lib/video/loudnessPlayback';
import type { MediaLoudness } from '$lib/video/loudnessMeter';

const source = { connect: vi.fn(), disconnect: vi.fn() };
const gains: {
  gain: { value: number };
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}[] = [];
const createMediaElementSource = vi.fn(() => source);
let contexts = 0;

class FakeAudioContext {
  state = 'running';
  destination = {};
  constructor() {
    contexts += 1;
  }
  createMediaElementSource = createMediaElementSource;
  createGain() {
    const node = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
    gains.push(node);
    return node;
  }
  resume = vi.fn(async () => {});
}

beforeEach(() => {
  videoSound.setMuted(true);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  createMediaElementSource.mockClear();
  source.connect.mockClear();
  source.disconnect.mockClear();
  gains.length = 0;
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
  const before = contexts;
  const { component, video } = mountPlayer();
  playAudible(video);
  expect(contexts).toBe(before);
  expect(createMediaElementSource).not.toHaveBeenCalled();
  unmount(component);
});

it('a loud video is routed through one gain the first time it is audible, freed on unmount', () => {
  const { component, video } = mountPlayer({ integratedLufs: -8, samplePeakDbfs: -0.5 });
  expect(createMediaElementSource).not.toHaveBeenCalled();
  playAudible(video);
  expect(createMediaElementSource).toHaveBeenCalledWith(video);
  expect(gains).toHaveLength(1);
  expect(gains[0].gain.value).toBeCloseTo(dbToGain(-6));
  unmount(component);
  expect(source.disconnect).toHaveBeenCalled();
  expect(gains[0].disconnect).toHaveBeenCalled();
});

it('two measured videos share ONE AudioContext', () => {
  const before = contexts;
  const a = mountPlayer({ integratedLufs: -8, samplePeakDbfs: -0.5 });
  const b = mountPlayer({ integratedLufs: -20, samplePeakDbfs: -12 });
  playAudible(a.video);
  playAudible(b.video);
  expect(contexts - before).toBeLessThanOrEqual(1);
  expect(contexts).toBe(1);
  expect(gains.map((g) => Number(g.gain.value.toFixed(3)))).toEqual([
    Number(dbToGain(-6).toFixed(3)),
    Number(dbToGain(6).toFixed(3)),
  ]);
  unmount(a.component);
  unmount(b.component);
});
