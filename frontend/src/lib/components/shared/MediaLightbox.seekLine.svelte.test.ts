// @vitest-environment happy-dom
/**
 * THE CONVERSATION VIEWER'S SEEK LINE IS TOUCHABLE (owner, 2026-11-15: *"la barre de lecture n'est
 * pas 'touchable'"*).
 *
 * The player's `line` scrubber was fine alone (its own tests drag it); inside the viewer, an EMPTY
 * immersive footer - an absolute, `z-20` strip at the bottom of the picture, at least the safe inset
 * tall - sat over the lower part of its 32 px touch zone and took the finger. The footer is an
 * overlay now: it lets every touch through, and the controls it carries opt back in. Review: the
 * dots wrapper of a gallery was the same strip (`pointer-events-auto`), and a hidden footer's dots
 * stayed tappable; the first test pins the wrapper and the second the `inert`.
 */
import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { createRawSnippet, flushSync, mount, unmount } from 'svelte';
import MediaLightbox from './MediaLightbox.svelte';
import FullScreenViewer from './FullScreenViewer.svelte';
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

/** The class tokens of an element. */
const tokens = (el: Element) => new Set((el.getAttribute('class') ?? '').split(/\s+/));

describe('the viewer chrome over a video: only a control takes a touch', () => {
  it('the footer overlay takes no touch, with or without gallery dots', () => {
    for (const dotCount of [0, 3]) {
      const instance = mount(MediaLightbox, {
        target: document.body,
        props: {
          open: true,
          onClose: () => {},
          dotCount,
          dotIndex: 0,
          onDotSelect: () => {},
        },
      });
      mounted.push(() => unmount(instance));
      flushSync();
    }
    const footers = document.querySelectorAll<HTMLElement>('[data-viewer-footer]');
    expect(footers).toHaveLength(2);
    for (const footer of footers) {
      expect(tokens(footer).has('pointer-events-none')).toBe(true);
      // Every descendant either takes no touch (an inherited none) or is an interactive control that
      // opted in: a wrapper that took touches would cover a video's seek line again.
      for (const el of footer.querySelectorAll('*')) {
        const optedIn = tokens(el).has('pointer-events-auto');
        if (el.tagName === 'BUTTON') expect(optedIn, 'a dot opts in').toBe(true);
        else expect(optedIn, `<${el.tagName.toLowerCase()}> must not take touches`).toBe(false);
      }
    }
    expect(footers[1].querySelectorAll('button')).toHaveLength(3);
  });

  it('a hidden footer is inert: invisible dots are neither tappable nor focusable', () => {
    const instance = mount(FullScreenViewer, {
      target: document.body,
      props: {
        ariaLabel: 'x',
        onClose: () => {},
        immersive: true,
        chromeHidden: true,
        footer: createRawSnippet(() => ({ render: () => '<button type="button">dot</button>' })),
      },
    });
    mounted.push(() => unmount(instance));
    flushSync();
    const footer = document.querySelector<HTMLElement>('[data-viewer-footer]')!;
    expect(footer.hasAttribute('inert')).toBe(true);
    expect(tokens(footer).has('opacity-0')).toBe(true);
  });

  // NOT a stacking test (happy-dom dispatches straight to the slider): it pins the player's own
  // contract inside the viewer - a touch press then a drag seeks, and the bubble leaves with the drag.
  it("the player's line seeks on a touch press then drag, mounted in the viewer", () => {
    const { video } = openConversationViewer();
    const slider = document.querySelector<HTMLElement>('[role="slider"]')!;
    slider.getBoundingClientRect = () => ({ left: 0, width: 200, top: 0, height: 32 }) as DOMRect;
    pointer(slider, 'pointerdown', 50);
    expect(video.currentTime).toBe(10);
    pointer(slider, 'pointermove', 150);
    expect(video.currentTime).toBe(30);
    pointer(slider, 'pointerup', 150);
    flushSync();
    expect(document.querySelector('[data-video-time-bubble]'), 'the bubble leaves').toBeNull();
  });
});
