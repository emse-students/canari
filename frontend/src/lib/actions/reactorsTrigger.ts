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

/** Hold time that turns a press into a "who reacted" request. */
export const LONG_PRESS_MS = 450;
/** Rest time on a badge, with a mouse or the keyboard, that opens the list - not a click on the way. */
export const HOVER_INTENT_MS = 400;
/** Pointer travel past which the press is a scroll or a drag, not a hold. */
const LONG_PRESS_SLOP_PX = 10;

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
  let timer: ReturnType<typeof setTimeout> | null = null;
  let origin: { x: number; y: number } | null = null;
  let opened = false;
  let restTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while the list is open because of a rest (hover or focus), which leaving must close. */
  let restOpened = false;

  function cancel() {
    if (timer) clearTimeout(timer);
    timer = null;
    origin = null;
  }

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
  const onDown = (e: PointerEvent) => {
    // A mouse holds with its main button only; a right click is the context menu's.
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    cancel();
    // A press is a click or a hold, never a rest: it must not open the list under its own click.
    cancelRest();
    opened = false;
    origin = { x: e.clientX, y: e.clientY };
    timer = setTimeout(() => {
      timer = null;
      opened = true;
      params.open(node);
    }, LONG_PRESS_MS);
  };
  const onMove = (e: PointerEvent) => {
    if (!origin) return;
    if (Math.hypot(e.clientX - origin.x, e.clientY - origin.y) > LONG_PRESS_SLOP_PX) cancel();
  };
  const onLeave = () => {
    cancel();
    endRest();
  };
  const onClickCapture = (e: Event) => {
    if (!opened) return;
    opened = false;
    e.stopPropagation();
  };
  // The native long-press menu would cover the list it just opened.
  const onContextMenu = (e: Event) => e.preventDefault();

  node.addEventListener('pointerenter', onEnter);
  node.addEventListener('focusin', onFocusIn);
  node.addEventListener('focusout', endRest);
  node.addEventListener('pointerdown', onDown);
  node.addEventListener('pointermove', onMove);
  node.addEventListener('pointerup', cancel);
  node.addEventListener('pointercancel', cancel);
  node.addEventListener('pointerleave', onLeave);
  node.addEventListener('click', onClickCapture, true);
  node.addEventListener('contextmenu', onContextMenu);

  return {
    update(next: ReactorsTriggerParams) {
      params = next;
    },
    destroy() {
      cancel();
      cancelRest();
      node.removeEventListener('pointerenter', onEnter);
      node.removeEventListener('focusin', onFocusIn);
      node.removeEventListener('focusout', endRest);
      node.removeEventListener('pointerdown', onDown);
      node.removeEventListener('pointermove', onMove);
      node.removeEventListener('pointerup', cancel);
      node.removeEventListener('pointercancel', cancel);
      node.removeEventListener('pointerleave', onLeave);
      node.removeEventListener('click', onClickCapture, true);
      node.removeEventListener('contextmenu', onContextMenu);
    },
  };
}
