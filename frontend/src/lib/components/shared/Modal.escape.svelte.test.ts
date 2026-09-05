/**
 * ESCAPE CLOSES A MODAL, AND THE KEY IS PRESSED WHERE A PERSON ACTUALLY PRESSES IT.
 *
 * The defect this pins shipped in every one of this component's twenty-two consumers and was
 * invisible to reading: `handleKeydown` was bound on `svelte:window`, which is a BUBBLE-phase
 * listener, while the dialog panel stopped `keydown` from bubbling - a mirror of the `click` stop
 * that keeps a click inside the panel from reaching the dismissing backdrop. `focusTrap` focuses the
 * first control inside the panel on mount, so every keystroke made with a modal open originates
 * inside it, is stopped one node up, and the window listener never runs.
 *
 * Measured on the community-settings modal on 2026-09-05: the keydown reached `window` in the
 * CAPTURE phase and never came back in the bubble phase; `[role=dialog]` was still there afterwards.
 *
 * SO THE TEST DISPATCHES FROM THE FOCUSED ELEMENT, NOT FROM `window`. A test that dispatched on
 * `window` would have passed against the broken build - it is the origin of the event, not the key,
 * that this is about.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mount, unmount } from 'svelte';
import Modal from './Modal.svelte';

const mounted: (() => void)[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

/** Mounts the modal open, and hands back the panel the person is looking at. */
function openModal(props: Record<string, unknown> = {}) {
  const onClose = vi.fn();
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(Modal, { target, props: { open: true, title: 'T', onClose, ...props } });
  mounted.push(() => void unmount(app));
  const panel = document.querySelector('[role="dialog"]') as HTMLElement;
  return { onClose, panel };
}

/** A real Escape, bubbling from `from` exactly as the browser delivers one. */
const escapeFrom = (from: Element) =>
  from.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

describe('Modal', () => {
  it('closes on Escape pressed inside the panel, which is where focus starts', () => {
    const { onClose, panel } = openModal();
    expect(panel).toBeTruthy();

    // The element `focusTrap` moved focus to - a real keystroke has this as its target.
    const focused = (panel.querySelector('button') ?? panel) as HTMLElement;
    escapeFrom(focused);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('still closes on Escape pressed on the backdrop, the origin the window listener covers', () => {
    const { onClose } = openModal();
    const backdrop = document.querySelector('[data-keyboard-aware-overlay]') as HTMLElement;

    escapeFrom(backdrop);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close on Escape when it is not dismissible', () => {
    // PlatformGateOverlay and the PIN modals rely on this: a gate a keystroke could dismiss is not
    // a gate. The panel keeps stopping the event either way.
    const { onClose, panel } = openModal({ dismissible: false });

    escapeFrom((panel.querySelector('button') ?? panel) as HTMLElement);

    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps the keystroke inside the panel, so a stacked modal cannot be dismissed by proxy', () => {
    // Two modals are portaled as SIBLINGS of `body`, so both window listeners are live at once. The
    // stop is what makes one Escape close one modal rather than the whole stack.
    const { panel } = openModal();
    const seenAtWindow = vi.fn();
    window.addEventListener('keydown', seenAtWindow);

    escapeFrom((panel.querySelector('button') ?? panel) as HTMLElement);

    window.removeEventListener('keydown', seenAtWindow);
    expect(seenAtWindow).not.toHaveBeenCalled();
  });

  it('ignores a key that is not Escape', () => {
    const { onClose, panel } = openModal();

    (panel.querySelector('button') ?? panel).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'a', bubbles: true })
    );

    expect(onClose).not.toHaveBeenCalled();
  });
});
