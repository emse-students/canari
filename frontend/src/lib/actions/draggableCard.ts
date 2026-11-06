import { Log } from '$lib/utils/Log';
import { isDragExcludedTarget } from '$lib/utils/dragExclusion';

/**
 * Makes an element a native HTML5 `draggable` that never starts a drag from an editable or
 * interactive descendant (see {@link isDragExcludedTarget}).
 *
 * HOW. `draggable` is switched OFF at `pointerdown` when the press lands on an excluded target and
 * back ON when the gesture ends. Deciding at pointerdown is the only moment that works in every
 * engine: Chromium and WebKit pick the drag source from the press itself, and the touch long-press
 * that selects text in a field is arbitrated by the same attribute, so a card that is not draggable
 * for that press leaves selection, caret and native field behaviour alone. Keyboard reordering is
 * not a drag and is untouched.
 */
export function draggableCard(node: HTMLElement): { destroy: () => void } {
  node.setAttribute('draggable', 'true');

  const restore = () => {
    node.setAttribute('draggable', 'true');
    window.removeEventListener('pointerup', restore, true);
    window.removeEventListener('pointercancel', restore, true);
    window.removeEventListener('dragend', restore, true);
  };

  // Every press decides afresh: a press whose gesture end was swallowed (a context menu eats its
  // pointerup) cannot leave the card undraggable for the next one.
  const onPointerDown = (e: Event) => {
    if (!isDragExcludedTarget(e.target)) {
      restore();
      return;
    }
    const el = e.target as Element;
    Log.d('draggableCard', `drag disabled for this press: <${el.tagName?.toLowerCase()}>`);
    node.setAttribute('draggable', 'false');
    window.addEventListener('pointerup', restore, true);
    window.addEventListener('pointercancel', restore, true);
    window.addEventListener('dragend', restore, true);
  };

  node.addEventListener('pointerdown', onPointerDown, true);
  return {
    destroy: () => {
      node.removeEventListener('pointerdown', onPointerDown, true);
      restore();
    },
  };
}
