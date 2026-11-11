// @vitest-environment happy-dom
/**
 * THE REEL PLAYER'S "PLEIN ECRAN" CHIP (owner, 2026-11-11): drawn only when the caller hands the
 * player `onOpen` (a landscape file), it opens the viewer through `openViewer` - so the position is
 * noted for the viewer to resume - and no other variant grows one.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import VideoPlayer from './VideoPlayer.svelte';
import { takeVideoPosition } from '$lib/utils/videoResume';

const mounted: (() => void)[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function mountReel(props: Record<string, unknown>) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(VideoPlayer, {
    target,
    props: { src: 'blob:reel', variant: 'reel', positionKey: 'media-ls', ...props },
  });
  mounted.push(() => unmount(component));
  flushSync();
  return target;
}

it('draws no chip for a reel with no viewer to open (a portrait file)', () => {
  expect(mountReel({}).querySelector('[data-reel-fullscreen]')).toBeNull();
});

it('draws the chip, named "Plein ecran", and opens the viewer at the playing position', () => {
  const onOpen = vi.fn();
  const target = mountReel({ onOpen });
  const chip = target.querySelector<HTMLButtonElement>('[data-reel-fullscreen]')!;
  expect(chip).not.toBeNull();
  expect(chip.getAttribute('aria-label')).toBeTruthy();
  target.querySelector('video')!.currentTime = 7;
  chip.click();
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(takeVideoPosition('media-ls')).toBe(7);
});
