/**
 * The gesture on a reaction badge, shared by the posts feed and the chat - Discord's (user,
 * 2026-10-01): A TAP REACTS, A HOLD SHOWS WHO REACTED. For every pointer, a mouse included.
 *
 * The badge used to open its "who reacted" list on HOVER for a mouse, so the list opened on the way
 * to every click and a reader reacting and a reader asking "who" did the same thing - *"on reagit et
 * on regarde qui a reagi avec la meme action, ca cree des problemes"*. A hold is the one gesture a
 * tap can never become by accident, and it reads the same under a finger and a mouse.
 *
 * **A MOUSE ALSO HOVERS AGAIN SINCE 2026-10-05** (user, on desktop: the hold is not discoverable
 * with a pointer that has a hover). What made the 2026-10-01 hover wrong was the list opening on the
 * way to every click, so it opens only after `HOVER_INTENT_MS` of resting on the badge, closes the
 * moment the pointer leaves, and a mouse still holds. A touch screen has no hover and keeps the hold
 * alone; the keyboard reaches the same list through focus (`:focus-visible`).
 */

import { longPress, LONG_PRESS_MS } from './longPress';

/**
 * Hold time that turns a press into a "who reacted" request. The hold itself - its timer, its slop,
 * the click it swallows and the native menu it refuses - is the shared `longPress` primitive.
 */
export { LONG_PRESS_MS };
/** Rest time on a badge, with a mouse or the keyboard, that opens the list - not a click on the way. */
export const HOVER_INTENT_MS = 400;

export interface ReactorsTriggerParams {
  /** Open the "who reacted" list for this badge. */
  open: (anchor: HTMLElement) => void;
  /** Close the list again - the pointer left the badge, or focus did. */
  close: () => void;
}

/**
 * Wires the hold and the rest on a badge. The click that ends a hold is swallowed in the capture
 * phase, so the badge's own toggle never runs for it: a hold asks, it does not react.
 */
export function reactorsTrigger(node: HTMLElement, initial: ReactorsTriggerParams) {
  let params = initial;
  let restTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while the list is open because of a rest (hover or focus), which leaving must close. */
  let restOpened = false;

  // Every pointer holds, a mouse included (Discord's badge); the native menu is refused.
  const hold = longPress(node, { onHold: (anchor) => params.open(anchor) });

  function cancelRest() {
    if (restTimer) clearTimeout(restTimer);
    restTimer = null;
  }

  function armRest() {
    cancelRest();
    restTimer = setTimeout(() => {
      restTimer = null;
      restOpened = true;
      params.open(node);
    }, HOVER_INTENT_MS);
  }

  function endRest() {
    cancelRest();
    if (!restOpened) return;
    restOpened = false;
    params.close();
  }

  // Touch has no hover: its compatibility events would open the list on every tap.
  const onEnter = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') armRest();
  };
  const onFocusIn = () => {
    if (node.matches(':focus-visible')) armRest();
  };
  // A press is a click or a hold, never a rest: it must not open the list under its own click.
  const onDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    cancelRest();
  };

  node.addEventListener('pointerenter', onEnter);
  node.addEventListener('focusin', onFocusIn);
  node.addEventListener('focusout', endRest);
  node.addEventListener('pointerdown', onDown);
  node.addEventListener('pointerleave', endRest);

  return {
    update(next: ReactorsTriggerParams) {
      params = next;
    },
    destroy() {
      hold.destroy();
      cancelRest();
      node.removeEventListener('pointerenter', onEnter);
      node.removeEventListener('focusin', onFocusIn);
      node.removeEventListener('focusout', endRest);
      node.removeEventListener('pointerdown', onDown);
      node.removeEventListener('pointerleave', endRest);
    },
  };
}
