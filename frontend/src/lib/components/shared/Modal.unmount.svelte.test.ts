// @vitest-environment happy-dom
/**
 * A MODAL THE PARENT UNMOUNTS WITH `open` STILL TRUE LEAVES NO BACK ENTRY BEHIND.
 *
 * Several sheets (the booking, block and range sheets) are drawn as `{#if sheet}<Sheet open .../>`
 * and handed over by setting the state to null: `open` never turns false, the component is simply
 * destroyed. The stack entry was released only when `open` flipped, so the dead entry stayed on the
 * stack and one Android Back then closed a layer nobody was looking at - it "did nothing".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { historyOverlayStackDepth, initHistoryOverlayStack } from '$lib/utils/historyOverlayStack';
import Modal from './Modal.svelte';

let stop: () => void;
beforeEach(() => {
  stop = initHistoryOverlayStack();
  vi.spyOn(history, 'back').mockImplementation(() => {});
  history.replaceState(null, '');
});
afterEach(() => {
  stop();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('Modal teardown', () => {
  it('releases its back entry when the parent destroys it with open still true', () => {
    const app = mount(Modal, { target: document.body, props: { open: true, onClose: () => {} } });
    flushSync();
    expect(historyOverlayStackDepth()).toBe(1);
    unmount(app, { outro: false });
    flushSync();
    expect(historyOverlayStackDepth()).toBe(0);
  });
});
