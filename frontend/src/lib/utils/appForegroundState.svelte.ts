import { isAppInForeground, onAppForegroundChange } from './appForeground';
import { Log } from './Log';

/**
 * Whether the app is in the foreground, as REACTIVE state: an `$effect` that reads `current` runs
 * again when the app moves between foreground and background.
 *
 * `isAppInForeground()` is the truth (`appForeground.ts`) but a plain global, and a global is not
 * something an effect can follow. The receipt effect of `MainChatPage` read it and returned while the
 * Android app was in the background; nothing ran it again when the app came back, so a message that
 * landed in the background in the conversation left open was never marked read - not on this phone's
 * badge, and the mark never being sent, not on any other device of the account (owner, 2026-11-02).
 *
 * Starts from the global, which the activity writes on every transition and once more the moment the
 * WebView exists, then follows the transition event it dispatches at the same instant. On every
 * runtime that writes neither, it is `true` and never changes - the document's own visibility and
 * focus decide there, as before.
 */
export function createAppForegroundState(
  hooks: {
    /**
     * Runs on each foreground edge BEFORE `current` changes, in the same dispatch, with the link the
     * resume opens (or `null`): whatever must be decided before an effect sees the app in front is
     * decided here.
     */
    onResume?: (opening: string | null) => void;
  } = {}
): { readonly current: boolean; destroy(): void } {
  let current = $state(isAppInForeground());
  const off = onAppForegroundChange((foreground, opening) => {
    if (foreground === current) return;
    Log.d(`[FOREGROUND] app ${foreground ? 'back in the foreground' : 'in the background'}`);
    if (foreground) hooks.onResume?.(opening);
    current = foreground;
  });
  return {
    get current() {
      return current;
    },
    destroy: off,
  };
}
