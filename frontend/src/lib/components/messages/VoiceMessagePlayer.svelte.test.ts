// @vitest-environment happy-dom
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

/** A mounted player with a known length, whose strip is 200 px wide starting at x = 0. */
function mountScrubbable(resumeKey = '') {
  vi.stubGlobal('fetch', () => Promise.reject(new Error('no network in this test')));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(VoiceMessagePlayer, {
    target,
    props: { src: 'blob:voice', resumeKey },
  });
  let unmounted = false;
  const unmountOnce = () => {
    if (!unmounted) void unmount(component);
    unmounted = true;
  };
  mounted.push(unmountOnce);
  flushSync();
  const audio = target.querySelector('audio')!;
  Object.defineProperty(audio, 'duration', { configurable: true, get: () => 40 });
  audio.dispatchEvent(new Event('loadedmetadata'));
  flushSync();
  const slider = target.querySelector<HTMLElement>('[role="slider"]')!;
  slider.getBoundingClientRect = () => ({ left: 0, width: 200 }) as DOMRect;
  return { audio, slider, unmount: unmountOnce };
}

const press = (type: string, clientX: number) =>
  Object.assign(new Event(type, { bubbles: true }), {
    clientX,
    pointerId: 1,
    pointerType: 'touch',
  });

it('a press on the waveform seeks to its proportional position, and a drag follows it', () => {
  const { audio, slider } = mountScrubbable();
  slider.dispatchEvent(press('pointerdown', 50));
  flushSync();
  expect(audio.currentTime).toBe(10);
  slider.dispatchEvent(press('pointermove', 150));
  expect(audio.currentTime).toBe(30);
  slider.dispatchEvent(press('pointerup', 150));
  slider.dispatchEvent(press('pointermove', 20));
  expect(audio.currentTime, 'a released pointer no longer scrubs').toBe(30);
  flushSync();
  expect(slider.getAttribute('aria-valuenow')).toBe('30');
});

it('the slider answers the arrow keys and exposes its value', () => {
  const { audio, slider } = mountScrubbable();
  slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  flushSync();
  expect(audio.currentTime).toBe(5);
  slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  flushSync();
  expect(audio.currentTime).toBe(40);
  expect(slider.getAttribute('aria-valuemax')).toBe('40');
  expect(slider.hasAttribute('data-scrub')).toBe(true);
});

it('a player rebuilt for the same attachment resumes where the first one was', () => {
  const first = mountScrubbable('att-1');
  Object.defineProperty(first.audio, 'paused', { configurable: true, get: () => true });
  first.audio.currentTime = 12;
  first.unmount();
  flushSync();

  const second = mountScrubbable('att-1');
  expect(second.audio.currentTime).toBe(12);
  expect(second.slider.getAttribute('aria-valuenow')).toBe('12');
});
