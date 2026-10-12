// Tauri doesn't have a Node.js server to do proper SSR
// so we use adapter-static with a fallback to index.html to put the site in SPA mode
// See: https://svelte.dev/docs/kit/single-page-apps

import type { LoadEvent } from '@sveltejs/kit';
import { currentUserId } from '$lib/stores/user';
import { checkSessionUserInBackground } from '$lib/utils/sessionProfileCheck';
import { refresh } from '$lib/stores/auth';
import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { internalPath, isSignedOutPath, loginReturningTo } from '$lib/utils/internalPath';
import { globalSession } from '$lib/stores/globalChatSingleton.svelte';
// See: https://v2.tauri.app/start/frontend/sveltekit/ for more info
export const ssr = false;

export const load = async (event: LoadEvent) => {
  // Get user ID from local store and validate it against the server.

  // `/f/` is a PUBLIC form's guest page: answered without an account, so a visitor with no
  // session must reach it rather than be sent to the login screen.
  const isAuthRoute = isSignedOutPath(event.url.pathname);

  if (typeof window === 'undefined') return;
  if (isAuthRoute) return;

  // MLS session already active - no need to re-verify the profile on every navigation.
  if (globalSession.isLoggedIn) return;

  let userId = currentUserId();
  if (!userId) {
    // userId may be null while the HTTP session (refresh cookie) is still valid - a first
    // launch after OIDC, or a store cleared by the system.
    // Attempt a silent refresh - _doRefresh restores userId from the JWT sub claim.
    try {
      // `event.fetch`, so SvelteKit does not warn on every navigation - see `refresh`.
      await refresh(event.fetch);
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
        resolve(
          internalPath(loginReturningTo(event.url.pathname, event.url.search, window.location.hash))
        ),
        { replaceState: true }
      ).catch(() => {});
    }
  }

  // Skip when MLS login is in progress to avoid racing with the biometric/PIN flow.
  if (globalSession.isLoginInProgress) return;

  // THE PROFILE CHECK NEVER HOLDS THE NAVIGATION (WP-NAV-1). It decides one thing - "redirect to
  // login on a confirmed 404, survive everything else" - and nothing it learns is needed to draw the
  // page, so it runs beside it. Awaited here it put a profile round trip (20 s deadline) in front of
  // EVERY navigation while the session was not yet unlocked, which on a weak link is the whole
  // cold-start window.
  void checkSessionUserInBackground(userId, () =>
    goto(
      resolve(
        internalPath(loginReturningTo(event.url.pathname, event.url.search, window.location.hash))
      ),
      { replaceState: true }
    )
  );
};
