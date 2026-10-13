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
 * Returns the teardown, which also removes the property so a thread with no composer reserves the
 * stylesheet's own fallback.
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

  publish();
  const observer = new ResizeObserver(publish);
  observer.observe(footer, { box: 'border-box' });
  return () => {
    observer.disconnect();
    root.style.removeProperty(COMPOSER_HEIGHT_PROPERTY);
  };
}
