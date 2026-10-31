import { globalSession as session } from '$lib/stores/globalChatSingleton.svelte';
import { connectivity } from '$lib/stores/connectivity.svelte';

/**
 * Whether the slow-link hint is on. Answers are arriving, slowly (`connectivity.slow`, derived from
 * observed latency, never a guess): the profile avatar in the header takes an amber ring. It is
 * never on while the offline banner is - a link that reaches nothing is not "slow" - and never
 * for a logged-out visitor. ONE derivation shared by the two headers (phone and desktop) and the
 * screen-reader announcer, so they cannot disagree.
 */
export const slowLink = {
  get active(): boolean {
    return (
      session.isLoggedIn &&
      !connectivity.isOffline &&
      !session.isOfflineSession &&
      connectivity.slow
    );
  },
};
