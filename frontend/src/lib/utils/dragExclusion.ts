/**
 * WHICH TARGETS MAY START A DRAG - the one rule every reorderable surface shares.
 *
 * A card made `draggable` as a whole hijacks the press of everything inside it: in Chromium and
 * WebKit a press-and-move in a text field inside a draggable ancestor drags the CARD instead of
 * selecting text, so a question title could not be selected by dragging across it. The rule: the
 * editable and interactive parts win, the handle and the inert parts of the card start the drag.
 */

/** Elements whose own press-and-move (caret, selection, slider, activation) must never be a drag. */
export const DRAG_EXCLUDED_SELECTOR = [
  'input',
  'textarea',
  'select',
  'button',
  'a[href]',
  'label',
  'summary',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="textbox"]',
  '[data-no-drag]',
].join(',');

/** Attribute marking the grip that STARTS a drag even when it is itself a `<button>`. */
export const DRAG_HANDLE_ATTRIBUTE = 'data-drag-handle';

/**
 * True when a press on `target` must not start a drag of the draggable that contains it.
 *
 * The nearest handle wins over an enclosing interactive element, and an interactive element wins
 * over the card it sits in. A non-element target (a text node) is judged by its parent.
 */
export function isDragExcludedTarget(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : (target as Node | null)?.parentElement;
  if (!el) return false;
  const handle = el.closest(`[${DRAG_HANDLE_ATTRIBUTE}]`);
  const excluded = el.closest(DRAG_EXCLUDED_SELECTOR);
  if (!excluded) return false;
  // Handle inside the excluded element (a grip button) means the grip: it drags.
  return !(handle && excluded.contains(handle));
}
