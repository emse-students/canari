// @vitest-environment happy-dom
/**
 * A MODAL'S FOCUS TRAP FINDS THE BODY'S OWN CONTROLS. `focusTrap` reads the first focusable at the
 * moment its action starts, and the panel renders its children INSIDE the trapped node: if Svelte
 * starts the action before them (5.59 may), the trap would silently fall back to the container.
 *
 * The title bar's close button renders BEFORE the children and would take the focus either way, so
 * every case here has no title bar and is not dismissible: the only focusable control is the body's.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRawSnippet, flushSync, mount, tick } from 'svelte';
import { initHistoryOverlayStack } from '$lib/utils/historyOverlayStack';
import Modal from './Modal.svelte';
import ModalOverlay from './ModalOverlay.svelte';

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

/** Where the trap SENT the focus: the portal moves the overlay one effect later and a moved node
 *  loses focus (happy-dom and browsers alike), so where it STAYS says nothing. */
async function firstFocusTarget(mountIt: () => void) {
  const focus = vi.spyOn(HTMLElement.prototype, 'focus');
  mountIt();
  flushSync();
  await tick();
  return focus.mock.contexts[0] as HTMLElement | undefined;
}

describe('focus trap', () => {
  it('Modal sends the focus to the body control, not to the container', async () => {
    const target = await firstFocusTarget(() =>
      mount(Modal, {
        target: document.body,
        props: {
          open: true,
          dismissible: false,
          showTitleBar: false,
          title: 'T',
          onClose: () => {},
          children: body,
        },
      })
    );
    expect(target?.getAttribute('data-testid')).toBe('first-field');
  });

  it('ModalOverlay sends the focus to the body control, not to the container', async () => {
    const target = await firstFocusTarget(() =>
      mount(ModalOverlay, {
        target: document.body,
        props: { open: true, dismissible: false, label: 'T', onClose: () => {}, children: body },
      })
    );
    expect(target?.getAttribute('data-testid')).toBe('first-field');
  });
});
