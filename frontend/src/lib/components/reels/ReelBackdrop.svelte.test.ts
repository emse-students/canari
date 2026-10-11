/** The backdrop samples only while it can be seen, and releases everything when it stops. */
import { afterEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ReelBackdrop from './ReelBackdrop.svelte';

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup(active: boolean) {
  const host = document.createElement('div');
  const video = document.createElement('video');
  host.append(video);
  document.body.append(host);
  const addSpy = vi.spyOn(host, 'addEventListener');
  const removeSpy = vi.spyOn(host, 'removeEventListener');
  const target = document.createElement('div');
  document.body.append(target);
  const component = mount(ReelBackdrop, { target, props: { host, active } });
  flushSync();
  return { target, component, addSpy, removeSpy };
}

it('renders and listens nothing when the frame fills the stage', () => {
  const { target, addSpy } = setup(false);
  expect(target.querySelector('[data-reel-backdrop]')).toBeNull();
  expect(addSpy).not.toHaveBeenCalled();
});

it('listens while active and removes its listeners and timer on unmount', () => {
  vi.useFakeTimers();
  const clearSpy = vi.spyOn(globalThis, 'clearInterval');
  const { target, component, addSpy, removeSpy } = setup(true);
  expect(target.querySelector('[data-reel-backdrop]')).not.toBeNull();
  expect(addSpy).toHaveBeenCalledWith('loadeddata', expect.any(Function), true);
  void unmount(component);
  expect(removeSpy).toHaveBeenCalledWith('loadeddata', expect.any(Function), true);
  expect(clearSpy).toHaveBeenCalled();
});
