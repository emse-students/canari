import { listPosts, type PostFeed } from '$lib/posts/api';
import type { PageLoad } from './$types';

export const load: PageLoad = ({ url }) => {
  const feedRaw = url.searchParams.get('feed');
  const feed = (
    ['all', 'followed', 'custom'].includes(feedRaw || '') ? feedRaw : 'all'
  ) as PostFeed;
  const promoStr = url.searchParams.get('promo');
  const promoParsed = promoStr !== null && promoStr !== '' ? parseInt(promoStr, 10) : undefined;
  const promo = promoParsed !== undefined && Number.isFinite(promoParsed) ? promoParsed : undefined;
  const formation = url.searchParams.get('formation')?.trim() || undefined;

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
