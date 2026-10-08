import { redirect } from '@sveltejs/kit';
import { publicRedirectTarget } from '$lib/associations/publicSections';
import type { PageLoad } from './$types';
import type { SeoMeta } from '$lib/seo/types';

/**
 * The hub (`/associations/<slug>`) is the ONE indexable page of an association. A section
 * (`/associations/<slug>/calendar`) is the same entity seen from inside: it stays out of the index
 * and out of the sitemap, so the section split creates no second page competing for the same query.
 *
 * Links written before sections became segments (`?section=calendar&fromPost=...`) are redirected
 * to the segment by `publicRedirectTarget`, an unknown segment to the hub.
 */
export const load: PageLoad = ({ params, url }) => {
  const slug = decodeURIComponent(params.slug ?? '').trim();
  const target = publicRedirectTarget('/associations', slug, params.section, url.searchParams);
  if (target) redirect(307, target);

  const seo: SeoMeta = {
    title: slug || 'Association',
    description: slug
      ? `Association ${slug} sur Canari : actualités, agenda et vie associative EMSE.`
      : 'Association sur Canari.',
    // A section is not the entity's page: never offered to a search engine, and its canonical is
    // its own address - the one the server answer carries (`resolveSeoForPath`).
    path: params.section
      ? `/associations/${params.slug}/${params.section}`
      : `/associations/${params.slug}`,
    ...(params.section ? { noindex: true } : {}),
  };
  return { seo };
};
