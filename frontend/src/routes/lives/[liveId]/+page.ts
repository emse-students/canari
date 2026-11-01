import type { SeoMeta } from '$lib/seo/types';
import type { PageLoad } from './$types';

/** Behind sign-in and `ssr = false` (root layout): no crawler reads it, the path is all there is. */
export const load: PageLoad = ({ params }) => {
  const seo: SeoMeta = {
    title: 'Live',
    description: 'Un live sur Canari.',
    path: `/lives/${params.liveId}`,
  };
  return { seo };
};
