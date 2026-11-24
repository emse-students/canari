// @vitest-environment happy-dom
/**
 * A MODAL'S FOCUS TRAP FINDS THE PANEL'S CONTROLS. `focusTrap` reads the first focusable at the
 * moment its action starts, and the panel renders its children INSIDE the trapped node: if Svelte
 * starts the action before them (5.59 may), the trap would silently fall back to the container.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRawSnippet, flushSync, mount, tick } from 'svelte';
import { initHistoryOverlayStack } from '$lib/utils/historyOverlayStack';
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

const body = createRawSnippet(() => ({
  render: () => '<div><input data-testid="first-field" /><button>Go</button></div>',
}));

describe('Modal focus trap', () => {
  it('puts the focus on the first control of the panel, not on the container', async () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    mount(Modal, {
      target: document.body,
      props: { open: true, title: 'T', onClose: () => {}, children: body },
    });
    flushSync();
    await tick();
    // The portal moves the overlay one effect later and a moved node loses focus, in happy-dom as in
    // a browser, so what is asserted is where the trap SENT the focus, not where it stays.
    const target = focus.mock.contexts[0] as HTMLElement;
    expect(target.tagName).toBe('BUTTON');
    expect(target.getAttribute('role')).not.toBe('dialog');
  });
});
