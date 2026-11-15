// @vitest-environment happy-dom
/**
 * THE CONVERSATION VIEWER'S SEEK LINE IS TOUCHABLE (owner, 2026-11-15: *"la barre de lecture n'est
 * pas 'touchable'"*).
 *
 * The player's `line` scrubber was fine alone (its own tests drag it); inside the viewer, an EMPTY
 * immersive footer - an absolute, `z-20` strip at the bottom of the picture, at least the safe inset
 * tall - sat over the lower part of its 32 px touch zone and took the finger. The footer is an
 * overlay now: it lets every touch through, and the controls it carries opt back in.
 */
import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import MediaLightboxVideoHost from './MediaLightboxVideoHost.test-helper.svelte';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

afterAll(adoptTransitionAnimations());

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function openConversationViewer() {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  const instance = mount(MediaLightboxVideoHost, {
    target: document.body,
    props: { slide: 'video-a', variant: 'conversation' },
  });
  mounted.push(() => unmount(instance));
  flushSync();
  const video = document.querySelector('video')!;
  Object.defineProperty(video, 'duration', { configurable: true, get: () => 40 });
  video.dispatchEvent(new Event('durationchange'));
  flushSync();
  return { video };
}

function pointer(el: Element, type: string, clientX: number) {
  el.dispatchEvent(
    new PointerEvent(type, { bubbles: true, pointerId: 7, pointerType: 'touch', clientX })
  );
}

describe('the conversation viewer: the seek line under a finger', () => {
  it('nothing in the viewer chrome covers the line: the footer overlay takes no touch', () => {
    openConversationViewer();
    const footer = document.querySelector<HTMLElement>('[data-viewer-footer]');
    expect(footer, 'the viewer draws its footer overlay').not.toBeNull();
    expect(footer!.className).toContain('pointer-events-none');
  });

  it('a touch drag on the line seeks, press then move, and never the viewer', () => {
    const { video } = openConversationViewer();
    const slider = document.querySelector<HTMLElement>('[role="slider"]')!;
    slider.getBoundingClientRect = () => ({ left: 0, width: 200, top: 0, height: 32 }) as DOMRect;
    pointer(slider, 'pointerdown', 50);
    expect(video.currentTime).toBe(10);
    pointer(slider, 'pointermove', 150);
    expect(video.currentTime).toBe(30);
    pointer(slider, 'pointerup', 150);
    flushSync();
    expect(slider.querySelector('[data-video-time-bubble]')).toBeNull();
    expect(
      document.querySelector('[data-video-time-bubble]'),
      'the bubble leaves with the drag'
    ).toBeNull();
  });
});
