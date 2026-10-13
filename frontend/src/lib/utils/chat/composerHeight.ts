import { Log } from '$lib/utils/Log';

/** The custom property the thread reserves under its last row (`.chat-messages-scroll`). */
export const COMPOSER_HEIGHT_PROPERTY = '--chat-composer-height';

/**
 * Publishes the composer footer's height as `--chat-composer-height`, which IS the thread's
 * `padding-bottom` - the room the last row (the typing bubble, while somebody types) stands in.
 *
 * **THE BOX OBSERVED IS THE BOX PUBLISHED: `border-box`.** The height is `offsetHeight`, padding
 * included, and the footer's bottom padding is `max(0.75rem, var(--safe-area-inset-bottom))` - it
 * moves on its own when the platform's bottom inset changes (Android's navigation bar inset reaching
 * the WebView after the composer mounted, the keyboard's open/close, iOS's pinned inset). A default
 * `ResizeObserver` watches the CONTENT box, which a padding change does not touch, so the footer
 * grew by the inset and nothing republished: measured at 390 px with a 24 px inset arriving late,
 * footer 76 px against a published 64 px, and the typing bubble's 16 px clearance became 4.5 px -
 * with a 48 px inset (three-button navigation) the bubble goes UNDER the composer, keyboard closed
 * (user report, phone app, 2026-10-13).
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
    const value = `${Math.ceil(footer.offsetHeight)}px`;
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
