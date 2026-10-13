import { Log } from '$lib/utils/Log';

/**
 * A HOLD, AND THE CLICK THAT ENDS IT - the one primitive behind every "press and keep the finger
 * down" in the app that is not a message bubble: the "who reacted" list (`reactorsTrigger`) and the
 * community rail's menu ("Marquer tout comme lu", 2026-10-13).
 *
 * Extracted from `reactorsTrigger` rather than written a second time, because the two halves that
 * make a hold safe are easy to get wrong separately:
 *
 * - **the click that ends a hold is swallowed**, in the capture phase on the node, so the element's
 *   own `onclick` (a Svelte delegated handler, reached only by bubbling) never runs for it: a hold
 *   asks, it does not activate. That covers the browser's click AND the synthetic one
 *   `svelte-dnd-action` dispatches on `touchend` for a zone that prevented the `touchstart` (the
 *   community rail, which has no touch delay) - both are dispatched at the node or inside it.
 * - **the native long-press menu is refused** (`contextmenu` prevented), or it would cover the
 *   panel the hold just opened. A `contextmenu` that is NOT a touch hold - a right click, the Menu
 *   key, Shift+F10 - is handed to `onContextMenu` when the caller wants one: Discord's right click.
 *
 * The verdict is the pointer's own travel, never a second clock: a press that moves past `slopPx`
 * is a scroll or a drag and is forgotten. A caller whose node is also a drag source declines the
 * hold from `onHold` when the drag has started (the drag's own `consider` event says so), which is
 * a fact, not a race against the drag library's threshold.
 */

/** Hold time that turns a press into a hold. */
export const LONG_PRESS_MS = 450;
/** Pointer travel past which the press is a scroll or a drag, not a hold. */
export const LONG_PRESS_SLOP_PX = 10;

export interface LongPressParams {
  /**
   * The press was held still for {@link LONG_PRESS_MS}. Returns `false` when the caller declined it
   * (a drag took the press): the click that ends the press is then left alone.
   */
  onHold: (anchor: HTMLElement) => boolean | void;
  /**
   * A context menu asked for by something other than a touch hold: a right click, the Menu key.
   * Absent, the native menu is simply refused.
   */
  onContextMenu?: (anchor: HTMLElement) => void;
  /**
   * Pointer types that may hold. Absent, every one - a mouse included, which is what the reaction
   * badges want. The community rail leaves the mouse out: a mouse has the right click, and its main
   * button held on a rail icon is the start of a drag.
   */
  pointerTypes?: readonly string[];
  /** Pointer travel that cancels the hold. Defaults to {@link LONG_PRESS_SLOP_PX}. */
  slopPx?: number;
}

/**
 * Wires a hold on `node`. Returns the Svelte action object; `update` swaps the parameters without
 * re-wiring, so a caller's closures can follow its props.
 */
export function longPress(node: HTMLElement, initial: LongPressParams) {
  let params = initial;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let origin: { x: number; y: number } | null = null;
  /** True from the moment a hold opened something until the click that ends it is swallowed. */
  let held = false;
  /** True while a press that is not a mouse is down: its `contextmenu` is the hold's, not a request. */
  let touchDown = false;

  function cancel() {
    if (timer) clearTimeout(timer);
    timer = null;
    origin = null;
  }

  const onDown = (e: PointerEvent) => {
    // Recorded BEFORE the right-click return: a touch whose release never reached this node (a drag
    // that carried it away) would otherwise leave `touchDown` set, and the next right click would be
    // taken for that touch's own `contextmenu` and open nothing.
    touchDown = e.pointerType !== 'mouse';
    // A mouse holds with its main button only; a right click is the context menu's.
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    held = false;
    cancel();
    if (params.pointerTypes && !params.pointerTypes.includes(e.pointerType)) return;
    origin = { x: e.clientX, y: e.clientY };
    timer = setTimeout(() => {
      timer = null;
      origin = null;
      held = params.onHold(node) !== false;
      Log.d('longPress', `hold ${held ? 'taken' : 'declined'}`);
    }, LONG_PRESS_MS);
  };
  const onMove = (e: PointerEvent) => {
    if (!origin) return;
    const slop = params.slopPx ?? LONG_PRESS_SLOP_PX;
    if (Math.hypot(e.clientX - origin.x, e.clientY - origin.y) > slop) cancel();
  };
  const onEnd = () => {
    cancel();
    touchDown = false;
  };
  const onClickCapture = (e: Event) => {
    if (!held) return;
    held = false;
    e.stopPropagation();
  };
  const onContextMenu = (e: Event) => {
    e.preventDefault();
    // A touch hold raises its own `contextmenu` on some engines (Android Chrome): the timer answers
    // that press, and opening twice would toggle the panel shut.
    if (touchDown || held) return;
    params.onContextMenu?.(node);
  };

  node.addEventListener('pointerdown', onDown);
  node.addEventListener('pointermove', onMove);
  node.addEventListener('pointerup', onEnd);
  node.addEventListener('pointercancel', onEnd);
  node.addEventListener('pointerleave', cancel);
  node.addEventListener('click', onClickCapture, true);
  node.addEventListener('contextmenu', onContextMenu);

  return {
    update(next: LongPressParams) {
      params = next;
    },
    destroy() {
      cancel();
      node.removeEventListener('pointerdown', onDown);
      node.removeEventListener('pointermove', onMove);
      node.removeEventListener('pointerup', onEnd);
      node.removeEventListener('pointercancel', onEnd);
      node.removeEventListener('pointerleave', cancel);
      node.removeEventListener('click', onClickCapture, true);
      node.removeEventListener('contextmenu', onContextMenu);
    },
  };
}
