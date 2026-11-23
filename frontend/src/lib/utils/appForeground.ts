/**
 * Whether the app is actually on the user's screen - the question `document.visibilityState` cannot
 * answer on native mobile.
 *
 * MEASURED ON DEVICE 2026-09-05 (Mi 9T, Android 16). A backgrounded Tauri app reports
 * `{visibilityState: "visible", hidden: false, hasFocus: true}` - byte for byte what it reports in
 * the foreground - while its JS keeps running (a 1.5 s timer fired in 1507 ms). It is not a missing
 * lifecycle call either: `WryActivity.onPause` already calls `mWebView.onPause()`, and
 * `WebView.onPause()` simply does not drive the Page Visibility API.
 *
 * So every "is the user looking at this" decision is wrong on a phone, in the direction that says
 * yes. The one that cost something is the notification: a backgrounded phone keeps its WebSocket,
 * receives the message and ACKs it, so the server sends no push and the FCM handler never runs -
 * and the web layer, which would have raised it, saw a visible focused document and stayed quiet.
 *
 * `MainActivity.isInForeground` is the honest statement of the fact, maintained across
 * `onResume`/`onPause`, and the activity pushes it into the page as `window.__canariForeground`
 * plus a `canari:foreground` event. THE iOS SHELL SPEAKS THE SAME CONTRACT since 2026-11-02
 * (`canari_ios.mm`, `CanariPublishForeground`, on `didEnterBackground` / `willEnterForeground`):
 * without it this answered `true` on an iPhone for ever, and a frame processed in the seconds before
 * suspension counted as read on arrival. `appForeground.contract.test.ts` holds the two shells to it.
 *
 * ON WEB AND DESKTOP THIS IS `true` AND MEANS NOTHING. They have a working visibility API and
 * callers keep using it; the default is the quiet one - an app believed to be on screen raises no notification, which
 * is the behaviour every non-mobile runtime already has from its own checks.
 */

/** The global the Android activity writes on every foreground transition. */
const FLAG = '__canariForeground';

/** The event it dispatches at the same moment, for callers that want the transition itself. */
export const APP_FOREGROUND_EVENT = 'canari:foreground';

/**
 * True when the app is on screen, as stated by the platform rather than inferred from the document.
 *
 * READ, NEVER CACHED. A cached copy would need a listener mounted before the first transition, and a
 * page loaded while the app is already backgrounded has none - it would start life believing it is
 * in the foreground and stay wrong until the next resume. The global is always current because the
 * activity writes it on every transition and once more the moment the WebView exists.
 *
 * Returns `true` when the global is absent, which is every runtime that does not set it.
 */
export function isAppInForeground(): boolean {
  if (typeof window === 'undefined') return true;
  const value = (window as unknown as Record<string, unknown>)[FLAG];
  return typeof value === 'boolean' ? value : true;
}

/**
 * Calls `onChange` whenever the app moves between foreground and background.
 *
 * `opening` is the app link the shell says THIS resume opens (a tapped notification), carried by the
 * event itself so the page knows it before anything reacts to the edge (`resumeOpening.svelte.ts`);
 * `null` for a plain resume, a background edge, or a shell that sends none.
 *
 * Returns the unsubscribe. No-op off the platforms that emit it, which is what makes it safe to
 * register unconditionally rather than behind a runtime check at every call site.
 */
export function onAppForegroundChange(
  onChange: (foreground: boolean, opening: string | null) => void
): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<{ foreground?: unknown; opening?: unknown }>).detail;
    if (typeof detail?.foreground !== 'boolean') return;
    const opening =
      detail.foreground && typeof detail.opening === 'string' && detail.opening
        ? detail.opening
        : null;
    onChange(detail.foreground, opening);
  };
  window.addEventListener(APP_FOREGROUND_EVENT, handler);
  return () => window.removeEventListener(APP_FOREGROUND_EVENT, handler);
}

/** The global the iOS shell writes on every edge of the ACTIVE pair (`CanariPublishActive`). */
const ACTIVE_FLAG = '__canariActive';

/** The event it dispatches at the same moment. */
export const APP_ACTIVE_EVENT = 'canari:active';

/**
 * True unless the shell says the app has stopped being ACTIVE - on iOS from `willResignActive` (the
 * home gesture, the app switcher, Notification Center or Control Center pulled over the app) until
 * `didBecomeActive`. READ, NEVER CACHED, for the reason {@link isAppInForeground} gives.
 *
 * A SEPARATE FACT FROM THE FOREGROUND, ON PURPOSE. The foreground is the background/foreground pair,
 * which the resume work keys on and which a Face ID sheet must not move. But the reader stops looking
 * at the app when it stops being active, and on an iPhone `didEnterBackground` came 8 s and more
 * after that, with the socket still open (`1.8.0-alpha.1`, dev logs): every frame of that window was
 * ACKed - so the server owed no push - and judged seen, so nothing announced it. Android writes no
 * such flag: its `onPause` already ends the foreground, so `true` there loses nothing.
 */
export function isAppActive(): boolean {
  if (typeof window === 'undefined') return true;
  const value = (window as unknown as Record<string, unknown>)[ACTIVE_FLAG];
  return typeof value === 'boolean' ? value : true;
}

/**
 * Calls `onChange(active)` on every edge of the active pair the shell publishes. No-op where no
 * shell publishes it. Returns the unsubscribe.
 */
export function onAppActiveChange(onChange: (active: boolean) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<{ active?: unknown }>).detail;
    if (typeof detail?.active !== 'boolean') return;
    onChange(detail.active);
  };
  window.addEventListener(APP_ACTIVE_EVENT, handler);
  return () => window.removeEventListener(APP_ACTIVE_EVENT, handler);
}

/**
 * Whether the native app is IN FRONT OF THE READER: in the foreground AND active. The one question
 * behind "did the reader see this arrival" and "is this conversation being read" on a phone
 * (`arrivalRuntime.ts`); every other consumer keeps the foreground alone.
 */
export function isAppInFront(): boolean {
  return isAppInForeground() && isAppActive();
}

/**
 * True when the app is on screen by EVERY signal the runtime gives: the native foreground flag (the
 * only one Android tells the truth through) and the page's own visibility (the only one web and
 * desktop have). Either one saying "off screen" is enough.
 */
export function isAppOnScreen(): boolean {
  if (typeof document === 'undefined') return true;
  return isAppInForeground() && document.visibilityState !== 'hidden';
}

/**
 * Calls `onChange(onScreen)` on every transition either signal reports - `visibilitychange` on web,
 * desktop and iOS, `canari:foreground` on Android (where the visibility API never changes) and iOS. ONE
 * subscription for the question "did the app just leave the screen", so a caller cannot listen to
 * the half that lies on its platform. Returns the unsubscribe.
 */
export function onAppScreenChange(onChange: (onScreen: boolean) => void): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  // ONE EDGE PER TRANSITION. On iOS both signals speak - the shell's `canari:foreground` and the
  // WebView's own `visibilitychange` - so a single trip to the background arrived twice. Reported
  // only when the combined answer CHANGES, so no listener has to be idempotent against the pair.
  let last = isAppOnScreen();
  const report = (onScreen: boolean) => {
    if (onScreen === last) return;
    last = onScreen;
    onChange(onScreen);
  };
  const onVisibility = () => report(isAppOnScreen());
  document.addEventListener('visibilitychange', onVisibility);
  // The event's own value, not a re-read of the flag: it is the transition being announced.
  const offForeground = onAppForegroundChange((foreground) =>
    report(foreground && document.visibilityState !== 'hidden')
  );
  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    offForeground();
  };
}
