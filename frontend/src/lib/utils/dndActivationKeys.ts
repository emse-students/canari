import { Log } from '$lib/utils/Log';

/**
 * Keeps Enter and Space ACTIVATING a row of a `svelte-dnd-action` zone whose rows are themselves
 * buttons.
 *
 * WHY. The library listens for `keydown` on every draggable of a zone where dragging is enabled and
 * treats Enter and Space as "start a keyboard drag": it calls `preventDefault()` and
 * `stopPropagation()`. When the draggable IS the button - the salon list, for whoever may reorder
 * it - the default it prevents is the button's own activation, so Enter on a focused salon row
 * opened nothing. The app reorders rows with Alt + arrows (`handleChannelKeydown`), never through
 * the library's keyboard drag, so the library has no claim on those two keys here.
 *
 * HOW. A capture-phase listener on the ZONE stops a bare Enter or Space aimed at one of its direct
 * children before it reaches the row's listeners, and does NOT prevent its default - the browser
 * then activates the button exactly as it would outside a zone. `setKeyboardDragTrigger` cannot do
 * this: it is global and always keeps one of the two keys.
 */
export function isRowActivationKey(e: KeyboardEvent, zone: Element): boolean {
  if (e.key !== 'Enter' && e.key !== ' ') return false;
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return false;
  const target = e.target;
  return target instanceof Element && target.parentElement === zone;
}

/** Svelte action: apply {@link isRowActivationKey} to a dnd zone. */
export function keepRowActivationKeys(zone: HTMLElement): { destroy: () => void } {
  const onKeydown = (e: KeyboardEvent) => {
    if (!isRowActivationKey(e, zone)) return;
    Log.d(
      'dndActivationKeys',
      `${e.key === ' ' ? 'Space' : 'Enter'} kept for the row's own activation`
    );
    e.stopPropagation();
  };
  zone.addEventListener('keydown', onKeydown, { capture: true });
  return {
    destroy: () => zone.removeEventListener('keydown', onKeydown, { capture: true }),
  };
}
