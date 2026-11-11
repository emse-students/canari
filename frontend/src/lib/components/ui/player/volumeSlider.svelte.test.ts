// @vitest-environment happy-dom
/**
 * THE DESKTOP VOLUME SLIDER (owner, 2026-11-11): it rises above the speaker on hover and focus under a
 * mouse only, is a real accessible range, never lets a drag reach the player's tap.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount, type ComponentProps } from 'svelte';
import VideoSoundButton from './VideoSoundButton.svelte';
import VideoVolumeSlider from './VideoVolumeSlider.svelte';
import { m } from '$lib/paraglide/messages';
import { videoSound } from '$lib/stores/videoSound.svelte';
import { FINE_HOVER_QUERY } from '$lib/utils/pointerDevice';

const mounted: (() => void)[] = [];

function stubMedia(fineHover: boolean) {
  const media = (query: string) =>
    ({
      matches: query === FINE_HOVER_QUERY ? fineHover : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList;
  vi.stubGlobal('matchMedia', media);
  window.matchMedia = media;
}

function render(props: ComponentProps<typeof VideoSoundButton>) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const instance = mount(VideoSoundButton, { target, props });
  mounted.push(() => unmount(instance));
  flushSync();
  return target;
}

beforeEach(() => {
  localStorage.clear();
  videoSound.setVolume(1);
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('the speaker with its slider', () => {
  it('draws no slider on a touch screen', () => {
    stubMedia(false);
    const target = render({ muted: false, onToggle: () => {}, onLevel: () => {} });
    expect(target.querySelector('[data-video-volume]')).toBeNull();
  });

  it('draws no slider for a speaker that gave no handler (a silent take)', () => {
    stubMedia(true);
    const target = render({ muted: false, onToggle: () => {} });
    expect(target.querySelector('[data-video-volume]')).toBeNull();
  });

  it('opens on hover, stays open while the pointer is on the pill, closes on leave', () => {
    stubMedia(true);
    const target = render({ muted: false, onToggle: () => {}, onLevel: () => {} });
    const host = target.querySelector<HTMLElement>('[data-video-volume-host]')!;
    const popover = target.querySelector<HTMLElement>('[data-video-volume-popover]')!;
    expect(popover.dataset.videoVolumePopover).toBe('closed');
    host.dispatchEvent(new PointerEvent('pointerenter'));
    flushSync();
    expect(popover.dataset.videoVolumePopover).toBe('open');
    // The pill is INSIDE the host: moving onto it fires no leave on the host.
    expect(host.contains(popover)).toBe(true);
    host.dispatchEvent(new PointerEvent('pointerleave'));
    flushSync();
    expect(popover.dataset.videoVolumePopover).toBe('closed');
  });

  it('opens on keyboard focus and closes when focus leaves the host', () => {
    stubMedia(true);
    const target = render({ muted: false, onToggle: () => {}, onLevel: () => {} });
    const host = target.querySelector<HTMLElement>('[data-video-volume-host]')!;
    const popover = target.querySelector<HTMLElement>('[data-video-volume-popover]')!;
    host.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    flushSync();
    expect(popover.dataset.videoVolumePopover).toBe('open');
    host.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body }));
    flushSync();
    expect(popover.dataset.videoVolumePopover).toBe('closed');
  });

  it('shows 0 while muted and the level otherwise, as a labelled range with a percentage', () => {
    stubMedia(true);
    videoSound.setLevel(0.35);
    const muted = render({ muted: true, onToggle: () => {}, onLevel: () => {} });
    expect(muted.querySelector<HTMLInputElement>('input[type=range]')!.value).toBe('0');
    const live = render({ muted: false, onToggle: () => {}, onLevel: () => {} });
    const range = live.querySelector<HTMLInputElement>('input[type=range]')!;
    expect(range.value).toBe('35');
    expect(range.getAttribute('aria-valuetext')).toBe(m.video_volume_valuetext({ percent: 35 }));
    expect(range.getAttribute('aria-label')).toBeTruthy();
  });
});

describe('the slider', () => {
  it('reports a fraction on input, and 0 for mute', () => {
    const onChange = vi.fn();
    const target = document.createElement('div');
    document.body.appendChild(target);
    const c = mount(VideoVolumeSlider, { target, props: { value: 1, onChange } });
    mounted.push(() => unmount(c));
    flushSync();
    const range = target.querySelector<HTMLInputElement>('input')!;
    range.value = '25';
    range.dispatchEvent(new Event('input', { bubbles: true }));
    range.value = '0';
    range.dispatchEvent(new Event('input', { bubbles: true }));
    expect(onChange.mock.calls).toEqual([[0.25], [0]]);
  });

  it('keeps presses, clicks and arrow keys from the player around it', () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    const c = mount(VideoVolumeSlider, { target, props: { value: 0.5, onChange: () => {} } });
    mounted.push(() => unmount(c));
    flushSync();
    const above = vi.fn();
    for (const type of ['pointerdown', 'pointerup', 'click', 'keydown'])
      document.body.addEventListener(type, above);
    const range = target.querySelector('input')!;
    range.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    range.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    range.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(above).not.toHaveBeenCalled();
    expect(target.querySelector('[data-video-volume]')!.hasAttribute('data-video-controls')).toBe(
      true
    );
  });
});
