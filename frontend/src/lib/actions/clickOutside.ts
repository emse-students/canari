import { containsThroughPortals } from './portal';

/**
 * Svelte action that fires a callback whenever a click event occurs outside the attached element.
 *
 * **"OUTSIDE" MEANS OUTSIDE THE COMPONENT, NOT OUTSIDE THE SUBTREE**, and the two stopped being the
 * same thing the day a panel was portalled. `event.composedPath()` already crosses shadow roots; it
 * cannot cross a portal, because a portalled node genuinely is elsewhere in the document. A panel
 * written inside the guarded element and moved to `document.body` therefore made every click on its
 * own contents read as "outside", and the guard closed the thing the user was using.
 *
 * That was not hypothetical: it shipped. The message reaction picker was portalled on 2026-09-09 to
 * fix its position, which left it reachable only for whatever the first tap happened to land on -
 * its search field, its nine category tabs and its skin-tone selector all dismissed it instead of
 * acting, and picking an emoji worked only because the web component's own event fired on the same
 * click, a frame before the panel was torn down. `AdminNavGroup` had already met this and avoided
 * `clickOutside` entirely, explaining why in a comment; a rule known at one call site is a rule the
 * next call site breaks, so it lives in the mechanism now.
 */
export function clickOutside(
  node: HTMLElement,
  params: (() => void) | { enabled: boolean; callback: () => void }
) {
  let callback: () => void;
  let enabled = true;
  let isListening = false;

  const handleClick = (event: Event) => {
    if (!enabled || !node) return;
    const path = event.composedPath();
    if (path.includes(node)) return;
    const inside = path.some(
      (target) => target instanceof HTMLElement && containsThroughPortals(node, target)
    );
    if (inside) return;
    callback();
  };

  const updateState = (newParams: (() => void) | { enabled: boolean; callback: () => void }) => {
    if (typeof newParams === 'function') {
      callback = newParams;
      enabled = true;
    } else {
      callback = newParams.callback;
      enabled = newParams.enabled;
    }

    if (enabled && !isListening) {
      document.addEventListener('click', handleClick, true);
      isListening = true;
    } else if (!enabled && isListening) {
      document.removeEventListener('click', handleClick, true);
      isListening = false;
    }
  };

  updateState(params);

  return {
    update(newParams: (() => void) | { enabled: boolean; callback: () => void }) {
      updateState(newParams);
    },
    destroy() {
      if (isListening) {
        document.removeEventListener('click', handleClick, true);
      }
    },
  };
}
