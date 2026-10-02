/**
 * A VOICE NOTE TAKES TURNS WITH EVERY OTHER MEDIA (user, 2026-10-02): starting one pauses the one
 * playing, whose button reads "play" again - it was paused, not ended, and keeps its place.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import VoiceMessagePlayer from './VoiceMessagePlayer.svelte';

const mounted: (() => void)[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

function mountVoice() {
  // No decode here: the waveform is not what is tested, and a refused fetch is logged, not thrown.
  vi.stubGlobal('fetch', () => Promise.reject(new Error('no network in this test')));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(VoiceMessagePlayer, { target, props: { src: 'blob:voice' } });
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
  const button = () => target.querySelector<HTMLButtonElement>('button')!;
  return { audio, button, isPlaying: () => !paused };
}

it('starting a second voice note pauses the first and its button shows play again', () => {
  const first = mountVoice();
  const second = mountVoice();
  const playLabel = first.button().getAttribute('aria-label');

  first.button().click();
  flushSync();
  expect(first.isPlaying()).toBe(true);
  expect(first.button().getAttribute('aria-label')).not.toBe(playLabel);

  second.button().click();
  flushSync();
  expect(first.isPlaying()).toBe(false);
  expect(second.isPlaying()).toBe(true);
  expect(first.button().getAttribute('aria-label'), 'back to the play button').toBe(playLabel);
});
