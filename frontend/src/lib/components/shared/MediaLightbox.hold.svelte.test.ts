// @vitest-environment happy-dom
/**
 * A PHOTO IN FULL SCREEN STOPS THE FEED BEHIND IT (owner, 2026-11-06). Only a mounted video player
 * counted as an open viewer, so a photo lightbox left the feed's video playing. The lightbox holds
 * playback while `open` and releases when it closes or unmounts.
 */
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import MediaLightbox from './MediaLightbox.svelte';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

const release = vi.fn();
const hold = vi.fn((_reason: string) => release);
vi.mock('$lib/actions/playWhileVisible', () => ({
  holdPlayback: (reason: string) => hold(reason),
}));

afterAll(adoptTransitionAnimations());
afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

it('holds playback while open, and releases on close and on unmount', () => {
  const props = $state({ open: false, onClose: () => {} });
  const instance = mount(MediaLightbox, { target: document.body, props });
  flushSync();
  expect(hold, 'closed: nothing held').not.toHaveBeenCalled();

  props.open = true;
  flushSync();
  expect(hold).toHaveBeenCalledTimes(1);
  expect(release).not.toHaveBeenCalled();

  props.open = false;
  flushSync();
  expect(release, 'closing gives the feed back').toHaveBeenCalledTimes(1);

  props.open = true;
  flushSync();
  expect(hold).toHaveBeenCalledTimes(2);
  unmount(instance);
  expect(release, 'unmounting while open releases too').toHaveBeenCalledTimes(2);
});
