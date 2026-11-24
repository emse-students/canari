import { Log } from '$lib/utils/Log';
import type { ActionReturn } from 'svelte/action';
import { dndzone, type DndZoneAttributes, type Item, type Options } from 'svelte-dnd-action';

/**
 * `dndzone` for a zone whose children are rendered by Svelte, whichever order Svelte runs the
 * action and the `{#each}` in.
 *
 * The library wires its listeners onto the zone's CHILDREN, read when it configures: at the action's
 * start and on each `update`, and `update` fires only when the options change. Since Svelte 5.59
 * (the custom renderer rewrite) an action can start BEFORE its `{#each}` has rendered, so a zone
 * whose options never change was configured with no children and never touched a row: its touch
 * and mouse drags silently did nothing. (Seen as `Sidebar.tapClickCount`: the rail's avatar `touchstart`
 * was no longer prevented.) Older Svelte ran the action after the children, which hid it.
 *
 * The fix is to configure again whenever the zone's child list changes, driven by the DOM itself
 * (a `MutationObserver` on `childList`), never by a clock. It re-configures only when the child
 * LIST differs, element by element, from the one last configured: a keyed swap keeps the count but
 * brings a node the library never armed, while a mutation that leaves the same children (the
 * library's own shadow-element bookkeeping) is not an extra configure, so there is no loop.
 */
export function dndzoneRendered<T extends Item>(
  node: HTMLElement,
  options: Options<T>
): ActionReturn<Options<T>, DndZoneAttributes<T>> {
  let latest = options;
  const inner = dndzone(node, options);
  let configured = Array.from(node.children);
  const observer = new MutationObserver(() => {
    // A drag in progress is the library's own: it re-reads the rows through the items the page hands it.
    if (node.querySelector(':scope > [data-is-dnd-shadow-item-internal]')) return;
    const now = Array.from(node.children);
    if (now.length === configured.length && now.every((child, i) => child === configured[i]))
      return;
    Log.d(
      'dndzoneRendered',
      `child list changed (${configured.length} -> ${now.length}): configuring again`
    );
    configured = now;
    inner?.update?.(latest);
  });
  observer.observe(node, { childList: true });
  return {
    update(next: Options<T>) {
      latest = next;
      configured = Array.from(node.children);
      inner?.update?.(next);
    },
    destroy() {
      observer.disconnect();
      inner?.destroy?.();
    },
  };
}
