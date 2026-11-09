import { dropEffectFor } from '$lib/utils/composerTransfer';
import { handleComposerDrop, type ComposerDropHandlers } from '$lib/utils/composerDrop';

/** Options of the `composerDropZone` action. */
export interface ComposerDropZoneOptions extends ComposerDropHandlers {
  /** Called with true while a drag carrying something droppable is over the zone, false when it ends. */
  onActiveChange?: (active: boolean) => void;
  /** Disables the zone (a phone has no pointer drag). */
  disabled?: boolean;
}

/** A drag of a file, an image or a URL; a text-selection drag is the editor's own business. */
function isDroppable(dt: DataTransfer | null): boolean {
  const types = Array.from(dt?.types ?? []);
  return types.includes('Files') || types.includes('text/uri-list') || types.includes('text/html');
}

/**
 * Svelte action: makes `node` ONE drop zone for everything inside it (padding, media strip and
 * toolbar as much as the editor), and reports a drop state for the caller to draw.
 *
 * - `dragover` is prevented on the whole subtree: a browser fires `drop` only on an element that
 *   cancelled `dragover`, and elsewhere a dropped file is OPENED in the window, leaving the app.
 * - the announced effect follows the source's `effectAllowed` (`dropEffectFor`): forcing `copy` on a
 *   `move`-only image drag from a web page made the browser refuse the drop outright.
 * - the state is counted on `dragenter`/`dragleave` (children fire them too) and closed at the
 *   WINDOW on `drop` (capture), `dragend` and a `dragleave` with nowhere next, since an editor stops
 *   its own drop and a cancelled drag ends wherever the pointer was
 *   (`ChatComposer.dragBadge.svelte.test.ts`).
 * - the editor inside handles and STOPS its own drop, so a drop is attached once, never twice.
 */
export function composerDropZone(node: HTMLElement, initial: ComposerDropZoneOptions) {
  let options = initial;
  let depth = 0;
  let active = false;

  const setActive = (next: boolean) => {
    if (next === active) return;
    active = next;
    options.onActiveChange?.(next);
  };
  const end = () => {
    depth = 0;
    setActive(false);
  };

  const onEnter = (event: DragEvent) => {
    if (options.disabled || !isDroppable(event.dataTransfer)) return;
    depth++;
    setActive(true);
  };
  const onOver = (event: DragEvent) => {
    if (options.disabled || !isDroppable(event.dataTransfer)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = dropEffectFor(event.dataTransfer);
    setActive(true);
  };
  const onLeave = (event: DragEvent) => {
    if (options.disabled) return;
    depth = Math.max(0, depth - 1);
    const next = event.relatedTarget as Node | null;
    if (depth === 0 || (next && !node.contains(next))) end();
  };
  const onDrop = (event: DragEvent) => {
    if (options.disabled) return;
    end();
    if (!isDroppable(event.dataTransfer)) return;
    event.preventDefault();
    handleComposerDrop(event.dataTransfer, options);
  };
  const onWindowLeave = (event: DragEvent) => {
    if (event.relatedTarget === null) end();
  };

  node.addEventListener('dragenter', onEnter);
  node.addEventListener('dragover', onOver);
  node.addEventListener('dragleave', onLeave);
  node.addEventListener('drop', onDrop);
  window.addEventListener('drop', end, true);
  window.addEventListener('dragend', end);
  window.addEventListener('dragleave', onWindowLeave);

  return {
    update(next: ComposerDropZoneOptions) {
      options = next;
      if (next.disabled) end();
    },
    destroy() {
      node.removeEventListener('dragenter', onEnter);
      node.removeEventListener('dragover', onOver);
      node.removeEventListener('dragleave', onLeave);
      node.removeEventListener('drop', onDrop);
      window.removeEventListener('drop', end, true);
      window.removeEventListener('dragend', end);
      window.removeEventListener('dragleave', onWindowLeave);
    },
  };
}
