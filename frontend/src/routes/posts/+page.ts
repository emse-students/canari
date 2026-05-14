import { listPosts, type PostFeed } from '$lib/posts/api';
import type { PageLoad } from './$types';
import { fetchMyProfile, isGlobalAdmin } from '$lib/stores/user';
import { goto } from '$app/navigation';

export const load: PageLoad = async ({ url }) => {
  const feedRaw = url.searchParams.get('feed');
  const feed = (
    ['all', 'followed', 'custom'].includes(feedRaw || '') ? feedRaw : 'followed'
  ) as PostFeed;
  const promoStr = url.searchParams.get('promo');
  const promoParsed = promoStr !== null && promoStr !== '' ? parseInt(promoStr, 10) : undefined;
  const promo = promoParsed !== undefined && Number.isFinite(promoParsed) ? promoParsed : undefined;
  const formation = url.searchParams.get('formation')?.trim() || undefined;

  if (!isGlobalAdmin()) {
    try {
      const profile = await fetchMyProfile();
      if (profile.formation !== 'ICM') {
        return goto('/chat', { replaceState: true }).catch(() => {});
      }
    } catch {
      return goto('/chat', { replaceState: true }).catch(() => {});
    }
  }

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
