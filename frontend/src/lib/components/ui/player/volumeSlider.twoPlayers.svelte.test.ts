// @vitest-environment happy-dom
/**
 * ONE LEVEL FOR EVERY VIDEO (owner, 2026-11-11): two players mounted together follow the store's
 * volume, and a player mounted later starts at it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import VideoPlayer from '$lib/components/shared/VideoPlayer.svelte';
import { videoSound } from '$lib/stores/videoSound.svelte';

const mounted: (() => void)[] = [];

beforeEach(() => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
  localStorage.clear();
  videoSound.setVolume(1);
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

function player() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const c = mount(VideoPlayer, { target, props: { src: 'blob:clip', variant: 'feed' } });
  mounted.push(() => unmount(c));
  flushSync();
  return target.querySelector('video')!;
}

describe('two players', () => {
  it('share the level, and a late one starts at it', () => {
    const a = player();
    const b = player();
    videoSound.setVolume(0.3);
    flushSync();
    expect(a.volume).toBeCloseTo(0.3);
    expect(b.volume).toBeCloseTo(0.3);
    expect(player().volume).toBeCloseTo(0.3);
  });
});
