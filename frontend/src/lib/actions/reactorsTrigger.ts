/**
 * The gesture that asks "who reacted?" on a reaction badge, shared by the posts feed and the chat.
 *
 * A MOUSE ASKS BY HOVERING, A FINGER BY HOLDING - and a plain tap only toggles the reaction. The
 * badges used to listen to `mouseenter`, which a touch screen synthesises after every tap, so one tap
 * both toggled the reaction and opened the list.
 */

/** Hold time that turns a touch into a "who reacted" request. */
export const LONG_PRESS_MS = 450;
/** Finger travel past which the touch is a scroll, not a press. */
const LONG_PRESS_SLOP_PX = 10;

export interface ReactorsTriggerParams {
  /** Open the panel for this badge. */
  open: (anchor: HTMLElement) => void;
  /** A pointer left the badge: schedule the panel's grace-period close. */
  leave: () => void;
}

/**
 * Wires hover (mouse) and long press (touch, pen) on a badge. The click that ends a long press is
 * swallowed in the capture phase so it never reaches the badge's own toggle handler.
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

  const onEnter = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') params.open(node);
  };
  const onLeave = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') params.leave();
  };
  const onDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') return;
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
  // The native long-press menu would cover the panel it just opened.
  const onContextMenu = (e: Event) => e.preventDefault();

  node.addEventListener('pointerenter', onEnter);
  node.addEventListener('pointerleave', onLeave);
  node.addEventListener('pointerdown', onDown);
  node.addEventListener('pointermove', onMove);
  node.addEventListener('pointerup', cancel);
  node.addEventListener('pointercancel', cancel);
  node.addEventListener('click', onClickCapture, true);
  node.addEventListener('contextmenu', onContextMenu);

  return {
    update(next: ReactorsTriggerParams) {
      params = next;
    },
    destroy() {
      cancel();
      node.removeEventListener('pointerenter', onEnter);
      node.removeEventListener('pointerleave', onLeave);
      node.removeEventListener('pointerdown', onDown);
      node.removeEventListener('pointermove', onMove);
      node.removeEventListener('pointerup', cancel);
      node.removeEventListener('pointercancel', cancel);
      node.removeEventListener('click', onClickCapture, true);
      node.removeEventListener('contextmenu', onContextMenu);
    },
  };
}
