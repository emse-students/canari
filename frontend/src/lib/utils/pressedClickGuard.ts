import { Log } from '$lib/utils/Log';

/**
 * Whether a click may reach its target, given the element the press BEGAN on.
 *
 * A click belongs to the component the finger came down on. When a press changes the layout (a tap
 * on a salon row opens the salon) and the click is then dispatched at the NEW layout, it lands on
 * whatever is now under the finger: a mention chip opened someone's profile, a bubble opened its
 * read receipts. Same element, or one containing the other (an icon inside its button), passes; so
 * does a label and the control it names. Clicks with no press (`detail === 0`: keyboard, assistive
 * tech, `.click()`) are never filtered - they have no finger to disagree with.
 */
export function clickMatchesPress(
  pressed: EventTarget | null,
  clicked: EventTarget | null,
  detail: number
): boolean {
  if (detail === 0 || !pressed) return true;
  if (!(pressed instanceof Node) || !(clicked instanceof Node)) return true;
  if (pressed === clicked || pressed.contains(clicked) || clicked.contains(pressed)) return true;
  const label = pressed instanceof Element ? pressed.closest('label') : null;
  return !!label && label.control === clicked;
}

/**
 * Whether a click is the one a pointer press produces, and therefore the one that answers for it.
 *
 * ONLY THAT CLICK MAY CONSUME THE PRESS. A script can dispatch a click in the middle of a tap - a
 * plain `Event` with no `detail` at all, or a `.click()` with `detail === 0` - and if it consumed the
 * press, the browser's own click would arrive with nothing left to be judged against and pass
 * whatever it landed on. That is exactly how the guard was defeated on the salon list (2026-10-13):
 * `svelte-dnd-action` dispatched its own click on `touchend`, the row opened the salon, and the
 * browser's click then reached the message now under the finger. A pointer's click is a
 * `MouseEvent` (a `PointerEvent` in Chromium) whose `detail` counts the presses, so it is >= 1.
 */
export function isPointerClick(e: Event): boolean {
  return e instanceof MouseEvent && e.detail > 0;
}

/**
 * Installs the guard on a document: one capture-phase pair, no timer. The press is state the browser
 * already hands us, so a click is judged by what it BEGAN on, never by how long ago.
 *
 * @returns a disposer.
 */
export function installPressedClickGuard(doc: Document = document): () => void {
  let pressed: EventTarget | null = null;
  const onDown = (e: Event) => {
    pressed = e.target;
  };
  const onCancel = () => {
    pressed = null;
  };
  const onClick = (e: Event) => {
    // A click no press produced has no finger to disagree with, and it leaves the press in place
    // for the click that does answer for it.
    if (!isPointerClick(e)) return;
    const press = pressed;
    pressed = null;
    if (clickMatchesPress(press, e.target, (e as MouseEvent).detail)) return;
    Log.d('pressedClickGuard: click refused, it began on another element', {
      pressed: (press as Element | null)?.tagName,
      clicked: (e.target as Element | null)?.tagName,
    });
    e.stopImmediatePropagation();
    e.preventDefault();
  };
  doc.addEventListener('pointerdown', onDown, true);
  doc.addEventListener('pointercancel', onCancel, true);
  doc.addEventListener('click', onClick, true);
  return () => {
    doc.removeEventListener('pointerdown', onDown, true);
    doc.removeEventListener('pointercancel', onCancel, true);
    doc.removeEventListener('click', onClick, true);
  };
}
