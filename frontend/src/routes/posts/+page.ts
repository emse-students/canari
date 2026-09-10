import { listPosts, DEFAULT_POST_FEED, parsePostFeed } from '$lib/posts/api';
import { settings } from '$lib/stores/settingsStore.svelte';
import type { PageLoad } from './$types';
import { redirectIfNotFeedAudience } from '$lib/posts/feedAudience';

export const load: PageLoad = async ({ url }) => {
  // THE URL WINS, THEN THE REMEMBERED TAB, THEN THE DEFAULT (user, 2026-09-10: *"L'onglet du fil
  // doit survivre a une autre session"*). The order is the whole design: a link someone was sent
  // names its own feed and must not be overridden by what this reader last looked at, while an
  // address bare of `?feed=` is a reader arriving at the page rather than at a post.
  //
  // Reading `localStorage` inside `load` is safe HERE and would not be in general: this route
  // tree is `ssr = false` (`routes/+layout.ts`), so `load` only ever runs in the browser and the
  // value is there synchronously - no hydration flash, and no first paint on the wrong tab.
  //
  // Both sources are strings from outside the program and are narrowed the same way.
  const feed =
    parsePostFeed(url.searchParams.get('feed')) ??
    parsePostFeed(settings.preferredPostFeed) ??
    DEFAULT_POST_FEED;
  const promoStr = url.searchParams.get('promo');
  const promoParsed = promoStr !== null && promoStr !== '' ? parseInt(promoStr, 10) : undefined;
  const promo = promoParsed !== undefined && Number.isFinite(promoParsed) ? promoParsed : undefined;
  const formation = url.searchParams.get('formation')?.trim() || undefined;

  if (await redirectIfNotFeedAudience()) return;

  return {
    posts: listPosts({
      limit: 20,
      feed,
      promo,
      formation,
    }),
    feedParams: { feed, promo, formation },
  };
};
