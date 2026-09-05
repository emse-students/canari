/**
 * WHAT CLOSES THIS MODAL, AND WHAT MUST NOT - the four dismissal paths, one file.
 *
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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { initHistoryOverlayStack } from '$lib/utils/historyOverlayStack';
import Modal from './Modal.svelte';

const mounted: (() => void)[] = [];
let stopHistoryStack: () => void;

beforeEach(() => {
  // THE LISTENER THE APP INSTALLS, installed here too - the root layout owns this call in
  // production, and without it `history.back()` closes nothing and every assertion below would be
  // about a chain that is not connected.
  stopHistoryStack = initHistoryOverlayStack();
  // The traversal itself is stubbed: jsdom keeps a real session history that accumulates across
  // tests, and a real `back()` would make one test's leftover entry decide the next one's verdict.
  // What the modal owes is the CALL - the popstate that follows is the browser's half, and the
  // tests below deliver it by hand exactly as a WebView does after an Android back press.
  vi.spyOn(history, 'back').mockImplementation(() => {});
});

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  stopHistoryStack();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

/** Mounts the modal open, and hands back the panel the person is looking at. */
function openModal(props: Record<string, unknown> = {}) {
  const onClose = vi.fn();
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(Modal, { target, props: { open: true, title: 'T', onClose, ...props } });
  mounted.push(() => void unmount(app));
  // The markup is rendered synchronously but `$effect` is not, and the history registration lives in
  // one. Without this the back-gesture assertions below measure a modal that has not opened yet -
  // and the non-dismissible one would pass for the wrong reason, which is the worst kind of green.
  flushSync();
  const panel = document.querySelector('[role="dialog"]') as HTMLElement;
  return { onClose, panel };
}

/** A real Escape, bubbling from `from` exactly as the browser delivers one. */
const escapeFrom = (from: Element) =>
  from.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

/**
 * A dismissible modal does not close SYNCHRONOUSLY, and pretending otherwise hid a whole path.
 *
 * `dismiss()` hands an open modal to `closeHistoryOverlayFromUi`, which calls `history.back()` so
 * the browser's back stack stays in step with what is on screen; the `popstate` that follows is
 * what pops the entry and calls `onClose`. So the close is one task away, and a test that asserted
 * it inline was only ever green because it ran before the effect that registers the overlay - it
 * was measuring a modal that had not finished opening.
 */
function expectClosed(onClose: ReturnType<typeof vi.fn>) {
  expect(history.back).toHaveBeenCalledTimes(1);
  window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
  expect(onClose).toHaveBeenCalledTimes(1);
}

describe('Modal', () => {
  it('closes on Escape pressed inside the panel, which is where focus starts', () => {
    const { onClose, panel } = openModal();
    expect(panel).toBeTruthy();

    // The element `focusTrap` moved focus to - a real keystroke has this as its target.
    const focused = (panel.querySelector('button') ?? panel) as HTMLElement;
    escapeFrom(focused);

    expectClosed(onClose);
  });

  it('still closes on Escape pressed on the backdrop, the origin the window listener covers', () => {
    const { onClose } = openModal();
    const backdrop = document.querySelector('[data-keyboard-aware-overlay]') as HTMLElement;

    escapeFrom(backdrop);

    expectClosed(onClose);
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

  it('does not close on a backdrop click when it is not dismissible', () => {
    const { onClose } = openModal({ dismissible: false });
    const backdrop = document.querySelector('[data-keyboard-aware-overlay]') as HTMLElement;

    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(onClose).not.toHaveBeenCalled();
  });

  /**
   * THE FOURTH DISMISSAL PATH, AND THE ONE `dismissible` USED TO MISS.
   *
   * The back gesture does not come through the backdrop, Escape or the header button - it comes
   * through the history entry `pushHistoryOverlay` pushes when the modal opens, popped by the
   * stack's own `popstate` listener, which calls `onClose`. A gate that a back press can close is
   * not a gate, and the three blocking overlays in this app were surviving only because each
   * happens to pass `onClose={() => {}}` - a property of their call sites, not of this component.
   *
   * ASSERTED ON THE HISTORY LENGTH rather than on the module, because that is what a back press
   * actually consumes: an entry pushed for a modal nothing will ever pop eats one press silently.
   */
  it('pushes no history entry when it is not dismissible, so a back press stays a navigation', () => {
    const before = history.length;

    openModal({ dismissible: false });

    expect(history.length).toBe(before);
  });

  it('does not close on a back press when it is not dismissible', () => {
    const { onClose } = openModal({ dismissible: false });

    // The event a WebView delivers when the physical Back button is pressed.
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }));

    expect(onClose).not.toHaveBeenCalled();
  });

  it('still pushes one when it is dismissible, which is what makes back close it', () => {
    const before = history.length;

    openModal();

    expect(history.length).toBe(before + 1);
  });
});
