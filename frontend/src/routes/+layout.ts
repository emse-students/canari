// Tauri doesn't have a Node.js server to do proper SSR
// so we use adapter-static with a fallback to index.html to put the site in SPA mode
// See: https://svelte.dev/docs/kit/single-page-apps

import type { LoadEvent } from '@sveltejs/kit';
import { currentUserId, fetchUserProfile, UserProfileFetchError } from '$lib/stores/user';
import { refresh } from '$lib/stores/auth';
import { goto } from '$app/navigation';
import { globalSession } from '$lib/stores/globalChatSingleton.svelte';
// See: https://v2.tauri.app/start/frontend/sveltekit/ for more info
export const ssr = false;

export const load = async (event: LoadEvent) => {
  // Get user ID from local store and validate it against the server.

  const isAuthRoute =
    event.url.pathname.startsWith('/login') ||
    event.url.pathname.startsWith('/auth') ||
    event.url.pathname.startsWith('/legal');

  if (typeof window === 'undefined') return;
  if (isAuthRoute) return;

  // MLS session already active - no need to re-verify the profile on every navigation.
  if (globalSession.isLoggedIn) return;

  let userId = currentUserId();
  if (!userId) {
    // userId may be transiently null if clearUserLocally() was called (e.g. after
    // an MLS login failure) while the HTTP session (refresh cookie) is still valid.
    // Attempt a silent refresh - _doRefresh restores userId from the JWT sub claim.
    try {
      await refresh();
      userId = currentUserId();
    } catch {
      // refresh failed - session truly expired
    }
    if (!userId) {
      // window.location.hash, not event.url.hash: SvelteKit throws on reading `.hash` off a
      // `load` event's URL (hash changes never re-run load, so it refuses to let one depend on
      // it) - and since that throw happens while building this very argument, it fires before
      // `goto()` is even called, well before the `.catch()` below could ever see it. Safe here
      // regardless, since this whole branch is already behind the `typeof window` guard above.
      return goto(
        `/login?returnTo=${encodeURIComponent(event.url.pathname + event.url.search + window.location.hash)}`,
        { replaceState: true }
      ).catch(() => {});
    }
  }

  // Keep the strict "unknown user => login" behavior, but avoid false redirects
  // on transient mobile startup/network errors: redirect only on confirmed 404.
  // Skip when MLS login is in progress to avoid racing with the biometric/PIN flow.
  if (globalSession.isLoginInProgress) return;

  try {
    await fetchUserProfile(userId);
  } catch (error) {
    // A status code is an ANSWER; a transport failure is not. Only a 404 - the server stating that
    // this user does not exist - may send the session to the login page, and it is read from the
    // typed error rather than parsed back out of its sentence.
    if (error instanceof UserProfileFetchError && error.status === 404) {
      return goto(
        `/login?returnTo=${encodeURIComponent(event.url.pathname + event.url.search + window.location.hash)}`,
        { replaceState: true }
      ).catch(() => {});
    }
    // Anything else is deliberately survived - a captive portal or a cold mobile start must not
    // log anyone out - but surviving it silently is how a permanently broken profile endpoint
    // looks exactly like a healthy one.
    console.warn(`[LAYOUT] Profile check did not answer, staying on the page: ${String(error)}`);
  }
};
