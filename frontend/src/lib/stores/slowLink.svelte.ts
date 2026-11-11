import { globalSession as session } from '$lib/stores/globalChatSingleton.svelte';
import { connectivity } from '$lib/stores/connectivity.svelte';

/**
 * The ONE connection indicator, drawn as a ring around the header avatar (owner, 2026-11-11):
 * - `connected` (green): nothing is wrong;
 * - `slow` (amber): answers are arriving, slowly (`connectivity.slow`, derived from observed
 *   latency, never a guess);
 * - `offline` (grey): the transport reaches nothing (`connectivity.isOffline`);
 * - `reconnecting` (grey too): the link is back but an offline unlock is not promoted yet.
 * `null` for a logged-out visitor, who has no avatar and no connection to show.
 */
export type ConnectionState = 'connected' | 'slow' | 'offline' | 'reconnecting';

/** Pure derivation, exported for the tests; {@link connection} feeds it the live stores. */
export function deriveConnectionState(input: {
  isLoggedIn: boolean;
  isOffline: boolean;
  isOfflineSession: boolean;
  slow: boolean;
}): ConnectionState | null {
  if (!input.isLoggedIn) return null;
  if (input.isOffline) return 'offline';
  if (input.isOfflineSession) return 'reconnecting';
  return input.slow ? 'slow' : 'connected';
}

/**
 * ONE derivation shared by the two headers (phone and desktop) and the screen-reader announcer, so
 * they cannot disagree. It replaced the "Hors connexion" banner and the "Connecte" pill, which drew
 * the same facts and moved the page.
 */
export const connection = {
  get state(): ConnectionState | null {
    return deriveConnectionState({
      isLoggedIn: session.isLoggedIn,
      isOffline: connectivity.isOffline,
      isOfflineSession: session.isOfflineSession,
      slow: connectivity.slow,
    });
  },
};

/**
 * The ring's colour class for a state, written out per state because Tailwind scans source text:
 * green connected, amber slow, grey offline or reconnecting; transparent (with the old hover and
 * focus accent) for a logged-out visitor. Pure, so the mapping is a test.
 */
export function connectionRingClass(state: ConnectionState | null): string {
  switch (state) {
    case 'connected':
      return 'ring-green-ok';
    case 'slow':
      return 'ring-amber-warn';
    case 'offline':
    case 'reconnecting':
      return 'ring-text-muted';
    default:
      return 'hover:ring-accent-icon focus-visible:ring-accent-icon ring-transparent';
  }
}
