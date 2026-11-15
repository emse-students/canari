import { Log } from '$lib/utils/Log';

/** The custom property the thread reserves under its last row (`.chat-messages-scroll`). */
export const COMPOSER_HEIGHT_PROPERTY = '--chat-composer-height';

/**
 * Publishes the composer footer's height WITHOUT ITS BOTTOM FLOOR as `--chat-composer-height`. The
 * thread's `padding-bottom` is that height plus the floor (`--chat-composer-floor`, the footer's own
 * `padding-bottom`) plus the keyboard's room - the room the last row (the typing bubble, while
 * somebody types) stands in (`app.css`, `.chat-messages-scroll`).
 *
 * **THE FLOOR IS LEFT TO CSS, BECAUSE IT MOVES WITH THE KEYBOARD AND THIS PUBLISHES A FRAME LATE.**
 * The floor is `max(0.75rem, var(--safe-area-inset-bottom))`, and the bottom safe area is pinned to 0
 * while a keyboard covers it (`keyboardSafeAreaBottomOverride`). Counted here, the footer shrank by
 * 12 px in the keyboard announcement's frame and the thread's padding followed one frame later: the
 * thread's bottom moved under the keyboard ride (Mi 9T, review of #3556, D2: scrollTop 4085 then
 * 4073). Composed in CSS, both change in the same style pass, and a keyboard move changes nothing
 * this publishes.
 *
 * **THE BOX OBSERVED IS THE `border-box`**, so a padding change is seen at all (a default
 * `ResizeObserver` watches the CONTENT box) - an inset arriving after mount once left the typing
 * bubble 4.5 px from the composer instead of 16 (user report, phone app, 2026-10-13). What is
 * published is `offsetHeight` less the computed `padding-bottom`, so a floor-only change publishes
 * the same value and writes nothing.
 *
 * Returns the teardown, which also cancels a pending publish and removes the property so a thread
 * with no composer reserves the stylesheet's own fallback.
 */
export function publishComposerHeight(
  footer: HTMLElement,
  root: HTMLElement = document.documentElement
): () => void {
  let published = '';
  const publish = () => {
    const floor = parseFloat(getComputedStyle(footer).paddingBottom) || 0;
    const value = `${Math.ceil(footer.offsetHeight - floor)}px`;
    if (value === published) return;
    Log.d('ChatComposer', `composer height ${published || 'unset'} -> ${value}`);
    published = value;
    root.style.setProperty(COMPOSER_HEIGHT_PROPERTY, value);
  };

  // A RESIZE IS PUBLISHED ON THE NEXT FRAME, NEVER INSIDE THE OBSERVER'S CALLBACK. The value is the
  // thread's `padding-bottom`, so writing it there resizes the scroller - a SHALLOWER node than the
  // footer, which the engine cannot deliver in the same pass: every growth (a wrapped line, an inset
  // arriving) raised "ResizeObserver loop completed with undelivered notifications" and delivered
  // the scroller's notification a frame later anyway. Published at the next frame's start, the
  // scroller resizes in an ordinary layout and is notified in that frame's own pass (measured in
  // Chrome: five inset changes, five loop errors synchronous, none deferred). What the reader sees
  // does not change - the pane's follow already landed one frame after the growth.
  let frame = 0;
  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      publish();
    });
  };

  publish();
  const observer = new ResizeObserver(schedule);
  observer.observe(footer, { box: 'border-box' });
  return () => {
    observer.disconnect();
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    root.style.removeProperty(COMPOSER_HEIGHT_PROPERTY);
  };
}
