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
