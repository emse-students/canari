import { containsThroughPortals } from './portal';

export interface ClickOutsideOptions {
  enabled: boolean;
  callback: () => void;
  /**
   * The element that OPENS the guarded panel, if it is not inside it.
   *
   * A click landing here is never "outside" - see the race described on {@link clickOutside}.
   * Read through an accessor rather than passed by value, because the opener is commonly the badge
   * or button last hovered and changes while the panel stays mounted.
   */
  ignore?: () => HTMLElement | null;
}

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
 *
 * ## `ignore`, and why it is not a convenience
 *
 * A panel opened by HOVER and dismissed by this guard has a race the caller cannot win: on a touch
 * screen one gesture produces `mouseenter` and then `click`, so the very tap that opened the panel
 * is an outside click that closes it - or is not, depending on whether the panel had rendered by
 * then. **Whether a control works would depend on a frame**, which is the opposite of what the
 * dismissal is for. Naming the opener as `ignore` removes the race rather than timing around it:
 * a click that lands on it is a click on the thing the panel belongs to, so it is never "outside".
 */
export function clickOutside(node: HTMLElement, params: (() => void) | ClickOutsideOptions) {
  let callback: () => void;
  let enabled = true;
  let ignore: (() => HTMLElement | null) | undefined;
  let isListening = false;

  const handleClick = (event: Event) => {
    if (!enabled || !node) return;
    const path = event.composedPath();
    if (path.includes(node)) return;
    const opener = ignore?.();
    if (opener && path.includes(opener)) return;
    const inside = path.some(
      (target) => target instanceof HTMLElement && containsThroughPortals(node, target)
    );
    if (inside) return;
    callback();
  };

  const updateState = (newParams: (() => void) | ClickOutsideOptions) => {
    if (typeof newParams === 'function') {
      callback = newParams;
      enabled = true;
      ignore = undefined;
    } else {
      callback = newParams.callback;
      enabled = newParams.enabled;
      ignore = newParams.ignore;
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
    update(newParams: (() => void) | ClickOutsideOptions) {
      updateState(newParams);
    },
    destroy() {
      if (isListening) {
        document.removeEventListener('click', handleClick, true);
      }
    },
  };
}
