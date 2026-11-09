// @vitest-environment happy-dom
/**
 * THE VIDEO PLAYER'S CONTROLS KIT (owner, 2026-11-09) - one speaker, one play disc, one expand chip,
 * one scrubber and one gesture glyph for every video surface.
 *
 * Pinned: each control is a real, labelled button with a 44px target that keeps its press from the
 * player's tap; the speaker's state is its shape and `aria-pressed`, yellow only when on; the
 * scrubber seeks on a drag and shows the time it would land on only while dragged; a sound change is
 * announced, a pause is not.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount, type Component } from 'svelte';
import VideoSoundButton from './VideoSoundButton.svelte';
import VideoPlayDisc from './VideoPlayDisc.svelte';
import VideoExpandButton from './VideoExpandButton.svelte';
import VideoScrubber from './VideoScrubber.svelte';
import VideoFeedbackGlyph from './VideoFeedbackGlyph.svelte';

const mounted: (() => void)[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function render<P extends Record<string, unknown>>(component: Component<P>, props: P) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const instance = mount(component, { target, props });
  mounted.push(() => unmount(instance));
  flushSync();
  return target;
}

/**
 * The player around the control, which would take the press as its tap if the control let it
 * through. On `body`, ABOVE the mount target: Svelte delegates `click` and `pointerdown` to the
 * target itself, so a listener there would run beside the handler rather than after it.
 */
function listenAbove() {
  const onParent = vi.fn();
  document.body.addEventListener('click', onParent);
  document.body.addEventListener('pointerdown', onParent);
  mounted.push(() => {
    document.body.removeEventListener('click', onParent);
    document.body.removeEventListener('pointerdown', onParent);
  });
  return onParent;
}

describe('the speaker', () => {
  it('says its state by shape and aria-pressed, yellow only when the sound is on', () => {
    const props = $state({ muted: true, onToggle: vi.fn() });
    const target = render(VideoSoundButton, props);
    const button = target.querySelector('button')!;
    expect(button.getAttribute('aria-label')).toBeTruthy();
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(target.querySelector('[data-video-sound="off"]')).not.toBeNull();
    expect(button.className, 'a 44px target, whatever the drawing').toContain('ui-icon-button');

    props.muted = false;
    flushSync();
    expect(button.getAttribute('aria-pressed')).toBe('true');
    const on = target.querySelector('[data-video-sound="on"]')!;
    expect(on.getAttribute('class')).toContain('text-accent');
  });

  it("toggles on a click and keeps the press from the player's tap", () => {
    const onToggle = vi.fn();
    const target = render(VideoSoundButton, { muted: true, onToggle });
    const onParent = listenAbove();
    const button = target.querySelector('button')!;
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    button.click();
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onParent).not.toHaveBeenCalled();
    expect(button.hasAttribute('data-video-controls')).toBe(true);
  });

  it("is the reel rail's speaker too: a bare glyph with a tooltip and the call site's marker", () => {
    const target = render(VideoSoundButton, {
      muted: true,
      onToggle: vi.fn(),
      rail: true,
      'data-reel-rail-sound': true,
    });
    const button = target.querySelector('button')!;
    expect(button.hasAttribute('data-reel-rail-sound')).toBe(true);
    expect(button.getAttribute('title')).toBeTruthy();
    expect(target.querySelector('.glass-video'), 'the rail draws no chip').toBeNull();
  });

  it('draws its own glass chip alone, and no second blur inside a glass bar', () => {
    const alone = render(VideoSoundButton, { muted: true, onToggle: vi.fn() });
    expect(alone.querySelector('.glass-video')).not.toBeNull();
    const inBar = render(VideoSoundButton, { muted: true, onToggle: vi.fn(), glass: false });
    expect(inBar.querySelector('.glass-video')).toBeNull();
  });
});

describe('the play disc and the expand chip', () => {
  it('the disc is a glass play button, never the amber sticker', () => {
    const onclick = vi.fn();
    const target = render(VideoPlayDisc, { onclick });
    const onParent = listenAbove();
    const disc = target.querySelector('button')!;
    expect(disc.className).toContain('glass-video');
    expect(disc.className).not.toContain('bg-accent');
    expect(disc.getAttribute('aria-label')).toBeTruthy();
    disc.click();
    expect(onclick).toHaveBeenCalledTimes(1);
    expect(onParent).not.toHaveBeenCalled();
  });

  it('the expand chip opens the viewer, with a label of its own', () => {
    const onclick = vi.fn();
    const target = render(VideoExpandButton, { onclick });
    const chip = target.querySelector('button')!;
    expect(chip.getAttribute('aria-label')).toBeTruthy();
    chip.click();
    expect(onclick).toHaveBeenCalledTimes(1);
  });
});

describe('the scrubber', () => {
  function scrubber(variant: 'line' | 'bar') {
    const onSeek = vi.fn();
    const onScrubbingChange = vi.fn();
    const target = render(VideoScrubber, {
      currentTime: 10,
      duration: 100,
      buffered: 0.5,
      variant,
      onSeek,
      onScrubbingChange,
    });
    const slider = target.querySelector<HTMLElement>('[role="slider"]')!;
    slider.getBoundingClientRect = () =>
      ({ left: 0, width: 200, top: 0, height: 32, right: 200, bottom: 32 }) as DOMRect;
    return { target, slider, onSeek, onScrubbingChange };
  }

  it('is a slider stating where the playhead is', () => {
    const { slider } = scrubber('bar');
    expect(slider.getAttribute('aria-valuenow')).toBe('10');
    expect(slider.getAttribute('aria-valuemax')).toBe('100');
    expect(slider.getAttribute('aria-valuetext')).toBeTruthy();
  });

  it('seeks along a drag, shows the time bubble only while dragged, and keeps the press its own', () => {
    const { target, slider, onSeek, onScrubbingChange } = scrubber('line');
    const onParent = listenAbove();
    expect(target.querySelector('[data-video-time-bubble]')).toBeNull();

    slider.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 50 }));
    flushSync();
    expect(onSeek).toHaveBeenLastCalledWith(25);
    expect(onScrubbingChange).toHaveBeenLastCalledWith(true);
    expect(target.querySelector('[data-video-time-bubble]')).not.toBeNull();

    slider.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 150 }));
    expect(onSeek).toHaveBeenLastCalledWith(75);

    slider.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    flushSync();
    expect(onScrubbingChange).toHaveBeenLastCalledWith(false);
    expect(target.querySelector('[data-video-time-bubble]')).toBeNull();
    expect(onParent).not.toHaveBeenCalled();
  });

  it('spends the yellow on the played part only, and draws buffered in the bar', () => {
    const line = scrubber('line').target;
    expect(line.querySelector('[data-video-played]')!.className).toContain('bg-accent');
    const bar = scrubber('bar').target;
    expect(bar.querySelectorAll('[data-video-line] > div').length, 'buffered + played').toBe(2);
  });
});

describe('the gesture glyph', () => {
  it('announces a sound change, pops for a pause, and draws nothing before a gesture', () => {
    const props = $state<{
      feedback: { kind: 'play' | 'pause' | 'sound-on' | 'sound-off'; n: number } | null;
    }>({ feedback: null });
    const target = render(VideoFeedbackGlyph, props);
    const live = target.querySelector('[aria-live="polite"]')!;
    expect(target.querySelector('[data-video-glyph]')).toBeNull();

    props.feedback = { kind: 'sound-on', n: 1 };
    flushSync();
    expect(target.querySelector('[data-video-glyph="sound-on"]')).not.toBeNull();
    expect(live.textContent).toBeTruthy();

    props.feedback = { kind: 'pause', n: 2 };
    flushSync();
    expect(target.querySelector('[data-video-glyph="pause"]')).not.toBeNull();
    expect(live.textContent, 'a pause is seen, not announced').toBe('');
  });

  it('leaves no static announcement: the glyph and its text go when its fade ends', () => {
    const props = $state<{
      feedback: { kind: 'play' | 'pause' | 'sound-on' | 'sound-off'; n: number } | null;
    }>({ feedback: { kind: 'sound-off', n: 1 } });
    const target = render(VideoFeedbackGlyph, props);
    const live = target.querySelector('[aria-live="polite"]')!;
    expect(live.textContent).toBeTruthy();
    target.querySelector('[data-video-glyph]')!.dispatchEvent(new Event('animationend'));
    flushSync();
    expect(target.querySelector('[data-video-glyph]')).toBeNull();
    expect(live.textContent).toBe('');

    props.feedback = { kind: 'sound-on', n: 2 };
    flushSync();
    expect(
      target.querySelector('[data-video-glyph="sound-on"]'),
      'the next gesture pops'
    ).not.toBeNull();
  });
});
