/**
 * Remembers which launch URL a WebView session has already acted on.
 *
 * `getCurrent()` does not answer "was this app started by a deep link just now". It answers "what is
 * the last deep link this PROCESS was handed", and it keeps answering it for the life of the
 * process: the Rust plugin holds `currentUrl`, set once from the launch intent and updated only by
 * `onNewIntent`. A WebView reload does not reset any of that - but it does wipe every module-level
 * variable in this bundle, which is where the guard against replaying it used to live.
 *
 * So the guard was erased by exactly the event it existed to survive. Measured on the device
 * 2026-08-07: a WebView reloaded **fifteen minutes** after a notification launch re-ran
 * `checkCurrentUrl`, got the original launch URL back, and re-published `notifNav` - yanking the
 * user into that conversation, whose target had already been consumed a quarter of an hour earlier.
 * The reload paths that reach this in production are the MLS fatal-error banner, the
 * version-mismatch reload and tab-leadership demotion; none of them is meant to navigate anywhere.
 *
 * `sessionStorage` is not a convenience here, it is the correct lifetime: it survives a reload of
 * the same WebView and is empty in a new one, which is the same boundary as the plugin's
 * `currentUrl`. A process that really was cold-started by a new deep link therefore still processes
 * it, because its storage is empty too.
 */

const STORAGE_KEY = 'canari:deeplink:handled';

/**
 * `sessionStorage` throws rather than returning null when storage is denied (some privacy modes,
 * and any `file://`-like origin). Losing the persistence is acceptable - degrading to the old
 * in-memory behaviour - but throwing out of a deep-link handler is not.
 */
function safeSessionStorage(): Storage | null {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    // Touch it: the throw happens on ACCESS, not on the typeof.
    sessionStorage.getItem(STORAGE_KEY);
    return sessionStorage;
  } catch {
    return null;
  }
}

export interface DeepLinkClaims {
  /**
   * Claims `url` for this session. Returns `true` the first time it is seen and `false` for every
   * repeat, so the caller processes a launch URL exactly once however often it re-reads it.
   */
  claim(url: string): boolean;
  /** Forgets the claim. Exists for tests and for a deliberate re-arm; nothing in the app calls it. */
  reset(): void;
}

/**
 * Builds a claim store over `store`, falling back to memory when it is unavailable.
 *
 * The in-memory mirror is not redundant with the storage: it keeps the guard working when storage
 * is denied, and it makes a claim survive a `sessionStorage` write that silently fails on quota.
 */
export function createDeepLinkClaims(store: Storage | null = safeSessionStorage()): DeepLinkClaims {
  let memo: string | null = null;

  const read = (): string | null => {
    if (memo !== null) return memo;
    try {
      return store?.getItem(STORAGE_KEY) ?? null;
    } catch {
      return null;
    }
  };

  return {
    claim(url: string): boolean {
      if (read() === url) return false;
      memo = url;
      try {
        store?.setItem(STORAGE_KEY, url);
      } catch {
        // Memory-only from here; the guard still holds until the next reload.
      }
      return true;
    },
    reset(): void {
      memo = null;
      try {
        store?.removeItem(STORAGE_KEY);
      } catch {
        // Nothing to do - the memo is already cleared, which is the half that matters.
      }
    },
  };
}

/** The app-wide instance. One per WebView session, which is the boundary this guards. */
export const deepLinkClaims: DeepLinkClaims = createDeepLinkClaims();
