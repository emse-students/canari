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
 * (a `MutationObserver` on `childList`), never by a clock. It only re-configures when the child
 * COUNT differs from the one last configured, so the library's own shadow element during a drag
 * (which keeps the count) is not an extra configure.
 */
export function dndzoneRendered<T extends Item>(
  node: HTMLElement,
  options: Options<T>
): ActionReturn<Options<T>, DndZoneAttributes<T>> {
  let latest = options;
  const inner = dndzone(node, options);
  let configuredCount = node.children.length;
  const observer = new MutationObserver(() => {
    if (node.children.length === configuredCount) return;
    configuredCount = node.children.length;
    inner?.update?.(latest);
  });
  observer.observe(node, { childList: true });
  return {
    update(next: Options<T>) {
      latest = next;
      configuredCount = node.children.length;
      inner?.update?.(next);
    },
    destroy() {
      observer.disconnect();
      inner?.destroy?.();
    },
  };
}
