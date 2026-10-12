import { fetchUserProfile, UserProfileFetchError } from '$lib/stores/user';

/**
 * Asks the server whether the signed-in user still exists, WITHOUT holding anything up
 * (offline-and-weak-network, WP-NAV-1).
 *
 * The root layout used to AWAIT this on every navigation while the MLS session was not yet unlocked,
 * so on a weak link each tap waited for a profile round trip (20 s deadline) before the page
 * appeared - for a check whose only effect is "redirect to login on a confirmed 404". Nothing the
 * check learns is needed to render, so it runs beside the navigation: the page shows at once and, in
 * the one case where the answer is "this account does not exist", the redirect follows.
 *
 * A status code is an ANSWER and a transport failure is not: only a 404 (a typed
 * {@link UserProfileFetchError}) sends anyone to the login page; anything else is survived, and
 * logged, because a captive portal or a cold mobile start must not sign anyone out.
 *
 * @param userId        The id to validate.
 * @param redirectToLogin Called once, only for a confirmed 404.
 * @returns A promise that settles when the check has finished; callers do NOT await it.
 */
export function checkSessionUserInBackground(
  userId: string,
  redirectToLogin: () => Promise<unknown> | void
): Promise<void> {
  return fetchUserProfile(userId).then(
    () => undefined,
    async (error: unknown) => {
      if (error instanceof UserProfileFetchError && error.status === 404) {
        console.warn(
          `[LAYOUT] User ${userId.slice(0, 8)} does not exist (404) - to the login page`
        );
        await Promise.resolve(redirectToLogin()).catch(() => {});
        return;
      }
      console.warn(`[LAYOUT] Profile check did not answer, staying on the page: ${String(error)}`);
    }
  );
}
