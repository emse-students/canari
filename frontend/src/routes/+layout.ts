// Tauri doesn't have a Node.js server to do proper SSR
// so we use adapter-static with a fallback to index.html to put the site in SPA mode
// See: https://svelte.dev/docs/kit/single-page-apps

import type { LoadEvent } from '@sveltejs/kit';
import { currentUserId, fetchUserProfile } from '$lib/stores/user';
import { goto } from '$app/navigation';
import { resolveActivePlaceId } from '$lib/navigation/places';
// See: https://v2.tauri.app/start/frontend/sveltekit/ for more info
export const ssr = false;

export const load = async (event: LoadEvent) => {
  // Get user ID from local store and validate it against the server.

  const isAuthRoute =
    event.url.pathname.startsWith('/login') || event.url.pathname.startsWith('/auth');

  const activePlaceId = resolveActivePlaceId(event.url.pathname);
  if (typeof window === 'undefined') return;
  if (isAuthRoute) return;

  const userId = currentUserId();
  if (!userId) {
    return goto(`/login?returnTo=${encodeURIComponent(activePlaceId)}`, {
      replaceState: true,
    }).catch(() => {});
  }

  // Keep the strict "unknown user => login" behavior, but avoid false redirects
  // on transient mobile startup/network errors: redirect only on confirmed 404.
  try {
    await fetchUserProfile(userId);
  } catch (error) {
    const message = String(error);
    if (message.includes('(404)')) {
      return goto(`/login?returnTo=${encodeURIComponent(activePlaceId)}`, {
        replaceState: true,
      }).catch(() => {});
    }
  }
};
