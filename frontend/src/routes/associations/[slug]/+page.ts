import type { PageLoad } from './$types';
import type { SeoMeta } from '$lib/seo/types';

/** SEO for public association pages (content still loaded client-side). */
export const load: PageLoad = ({ params }) => {
  const slug = decodeURIComponent(params.slug ?? '').trim();
  const seo: SeoMeta = {
    title: slug || 'Association',
    description: slug
      ? `Association ${slug} sur Canari : actualités, agenda et vie associative EMSE.`
      : 'Association sur Canari.',
    path: `/associations/${params.slug}`,
  };
  return { seo };
};
