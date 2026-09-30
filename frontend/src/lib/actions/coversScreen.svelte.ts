import { SvelteSet } from 'svelte/reactivity';
import { Log } from '$lib/utils/Log';

/**
 * Which mounted surfaces cover the screen right now - a modal's backdrop, a sheet, a drawer's scrim,
 * a full-screen viewer.
 *
 * It exists for the iOS app's NATIVE tab bar. A web bar sits in the page's stacking order, so a
 * modal's `z-index` paints over it; a native `UITabBar` is drawn ABOVE the whole WebView, so no web
 * layer can ever cover it. It stayed on top of every modal - over the post composer it hid "Publier"
 * and the attachment row (measured on an iPhone 12, 2026-09-30) - and stayed tappable, so a tab could
 * navigate away from under an open dialog. The bar reads {@link screenCover} and hides while it is
 * non-empty.
 *
 * A SET OF NODES, NOT A COUNTER. A counter goes wrong for good the first time a release is missed or
 * doubled (a shell nested in another, an action destroyed twice); a node is either in the set or not,
 * so the state is always the list of what is really mounted. A `SvelteSet`, so the bar reacts to it.
 */
const covering = new SvelteSet<HTMLElement>();

/** `covered` is true while at least one surface covers the screen - reactive, read-only. */
export const screenCover = {
  get covered(): boolean {
    return covering.size > 0;
  },
};

function publish(): void {
  Log.d('coversScreen', `${covering.size} surface(s) cover the screen`);
}

/**
 * Svelte action for the element that covers the screen - put it on the backdrop, the layer that is
 * mounted exactly as long as the surface is open. `active` (default true) lets a component that is
 * sometimes inline and sometimes covering (a side panel that becomes a column on wide screens) say
 * which it is.
 */
export function coversScreen(node: HTMLElement, active: boolean = true) {
  const apply = (on: boolean): void => {
    if (on) covering.add(node);
    else covering.delete(node);
    publish();
  };
  apply(active);

  return {
    update(next: boolean) {
      apply(next);
    },
    destroy() {
      covering.delete(node);
      publish();
    },
  };
}
