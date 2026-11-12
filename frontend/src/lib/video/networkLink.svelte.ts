import { Log } from '$lib/utils/Log';

/**
 * THE LINK THIS DEVICE SAYS IT IS ON - the Network Information API's `navigator.connection.type`,
 * read live and followed through the connection's `change` event (review of #3329), so a template
 * that reads it redraws when the phone moves from Wi-Fi to mobile data. Only Chromium exposes the
 * type (the Android app, Chrome); iOS's WKWebView, Safari and Firefox do not, and there it is `null`.
 *
 * The read never writes state (a template may call it): the `change` listener bumps a counter the
 * read depends on, and the type itself is read from the engine each time.
 */
interface ConnectionLike extends EventTarget {
  type?: unknown;
}

/** Bumped by each `change` event: what makes a reader of {@link linkType} reactive. */
let changes = $state(0);
/** The connection objects already followed. */
const followed = new WeakSet<object>();

function connection(): ConnectionLike | null {
  if (typeof navigator === 'undefined') return null;
  return (navigator as Navigator & { connection?: ConnectionLike }).connection ?? null;
}

/** The current link type, or null where the engine reports none. */
export function linkType(): string | null {
  void changes;
  const c = connection();
  if (c && !followed.has(c) && typeof c.addEventListener === 'function') {
    followed.add(c);
    c.addEventListener('change', () => {
      Log.d(
        'VIDEO',
        `network link changed: now ${typeof c.type === 'string' ? c.type : 'unknown'}`
      );
      changes += 1;
    });
  }
  return typeof c?.type === 'string' ? c.type : null;
}
