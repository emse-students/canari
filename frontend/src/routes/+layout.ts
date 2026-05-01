// Tauri doesn't have a Node.js server to do proper SSR
// so we use adapter-static with a fallback to index.html to put the site in SPA mode
// See: https://svelte.dev/docs/kit/single-page-apps

import type { LoadEvent } from '@sveltejs/kit';
import { currentUserId, userExists } from '$lib/stores/user';
import { goto } from '$app/navigation';
import { resolveActivePlaceId } from '$lib/navigation/places';
// See: https://v2.tauri.app/start/frontend/sveltekit/ for more info
export const ssr = false;

export const load = async (event: LoadEvent) => {
  // Get user ID from store, and check if it exists on the server.

  const isAuthRoute =
    event.url.pathname.startsWith('/login') || event.url.pathname.startsWith('/auth');

  const activePlaceId = resolveActivePlaceId(event.url.pathname);
  if (typeof window === 'undefined') return;
  if (isAuthRoute) return;

  const userId = currentUserId();
  if (userId) {
    const exists = await userExists(userId);
    if (!exists) {
      return goto(`/login?returnTo=${encodeURIComponent(activePlaceId)}`, {
        replaceState: true,
      }).catch(() => {});
    }
  } else {
    return goto(`/login?returnTo=${encodeURIComponent(activePlaceId)}`, {
      replaceState: true,
    }).catch(() => {});
  }
};
