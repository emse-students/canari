// @vitest-environment happy-dom
/**
 * A LANDSCAPE VIEWER OWNS THE ORIENTATION WHILE IT IS OPEN (owner, 2026-11-11): `forceLandscape`
 * requests `landscape` on the one orientation stack when the viewer opens and releases that request
 * when it closes, when `open` flips false and when the component goes away while open. Without the
 * prop it asks for nothing.
 */
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import MediaLightbox from './MediaLightbox.svelte';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

const release = vi.fn();
const request = vi.fn((_mode: string, _owner: string) => ({ release }));
vi.mock('$lib/mobile/screenOrientation.svelte', () => ({
  requestOrientation: (mode: string, owner: string) => request(mode, owner),
}));
vi.mock('$lib/actions/playWhileVisible', () => ({ holdPlayback: () => () => {} }));

afterAll(adoptTransitionAnimations());
afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

it('requests landscape while open and releases on close and on unmount', () => {
  const props = $state({ open: false, onClose: () => {}, forceLandscape: true });
  const instance = mount(MediaLightbox, { target: document.body, props });
  flushSync();
  expect(request, 'closed: nothing asked').not.toHaveBeenCalled();

  props.open = true;
  flushSync();
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith('landscape', 'media-lightbox');
  expect(release).not.toHaveBeenCalled();

  props.open = false;
  flushSync();
  expect(release, 'open flipping false hands the turn back').toHaveBeenCalledTimes(1);

  props.open = true;
  flushSync();
  expect(request).toHaveBeenCalledTimes(2);
  unmount(instance);
  expect(release, 'unmounting while open releases too').toHaveBeenCalledTimes(2);
});

it('asks for nothing without forceLandscape', () => {
  const props = $state({ open: true, onClose: () => {} });
  const instance = mount(MediaLightbox, { target: document.body, props });
  flushSync();
  expect(request).not.toHaveBeenCalled();
  unmount(instance);
});
