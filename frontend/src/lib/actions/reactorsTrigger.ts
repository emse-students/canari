/**
 * The gesture on a reaction badge, shared by the posts feed and the chat - Discord's (user,
 * 2026-10-01): A TAP REACTS, A HOLD SHOWS WHO REACTED. For every pointer, a mouse included.
 *
 * The badge used to open its "who reacted" list on HOVER for a mouse, so the list opened on the way
 * to every click and a reader reacting and a reader asking "who" did the same thing - *"on reagit et
 * on regarde qui a reagi avec la meme action, ca cree des problemes"*. A hold is the one gesture a
 * tap can never become by accident, and it reads the same under a finger and a mouse.
 */

/** Hold time that turns a press into a "who reacted" request. */
export const LONG_PRESS_MS = 450;
/** Pointer travel past which the press is a scroll or a drag, not a hold. */
const LONG_PRESS_SLOP_PX = 10;

export interface ReactorsTriggerParams {
  /** Open the "who reacted" list for this badge. */
  open: (anchor: HTMLElement) => void;
}

/**
 * Wires the hold on a badge. The click that ends a hold is swallowed in the capture phase, so the
 * badge's own toggle never runs for it: a hold asks, it does not react.
 */
export function reactorsTrigger(node: HTMLElement, initial: ReactorsTriggerParams) {
  let params = initial;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let origin: { x: number; y: number } | null = null;
  let opened = false;

  function cancel() {
    if (timer) clearTimeout(timer);
    timer = null;
    origin = null;
  }

  const onDown = (e: PointerEvent) => {
    // A mouse holds with its main button only; a right click is the context menu's.
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    cancel();
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
  const onClickCapture = (e: Event) => {
    if (!opened) return;
    opened = false;
    e.stopPropagation();
  };
  // The native long-press menu would cover the list it just opened.
  const onContextMenu = (e: Event) => e.preventDefault();

  node.addEventListener('pointerdown', onDown);
  node.addEventListener('pointermove', onMove);
  node.addEventListener('pointerup', cancel);
  node.addEventListener('pointercancel', cancel);
  node.addEventListener('pointerleave', cancel);
  node.addEventListener('click', onClickCapture, true);
  node.addEventListener('contextmenu', onContextMenu);

  return {
    update(next: ReactorsTriggerParams) {
      params = next;
    },
    destroy() {
      cancel();
      node.removeEventListener('pointerdown', onDown);
      node.removeEventListener('pointermove', onMove);
      node.removeEventListener('pointerup', cancel);
      node.removeEventListener('pointercancel', cancel);
      node.removeEventListener('pointerleave', cancel);
      node.removeEventListener('click', onClickCapture, true);
      node.removeEventListener('contextmenu', onContextMenu);
    },
  };
}
