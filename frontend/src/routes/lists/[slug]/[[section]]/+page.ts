import { redirect } from '@sveltejs/kit';
import { publicRedirectTarget } from '$lib/associations/publicSections';
import type { PageLoad } from './$types';

/** Same legacy-link and unknown-segment redirects as an association's page; lists are never indexed. */
export const load: PageLoad = ({ params, url }) => {
  const slug = decodeURIComponent(params.slug ?? '').trim();
  const target = publicRedirectTarget('/lists', slug, params.section, url.searchParams);
  if (target) redirect(307, target);
  return {};
};
