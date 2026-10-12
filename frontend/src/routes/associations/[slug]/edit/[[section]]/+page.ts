import { redirect } from '@sveltejs/kit';
import { editSectionHref, parseEditSection } from '$lib/associations/editSections';
import type { PageLoad } from './$types';

/**
 * Keeps every link written BEFORE sections became route segments working: the notification
 * deep links (`?section=republications`, `?section=payments`), the "create a form" return flow and
 * the post-creation landing all named a section in the query. They are redirected, replacing the
 * history entry, to the segment; an unknown name (query or segment) lands on the hub.
 *
 * The permission to open a known section is NOT decided here - the rights are only known once the
 * association and its roster are loaded, so the page asks `mayOpenEditSection` after that.
 */
export const load: PageLoad = ({ params, url }) => {
  const slug = decodeURIComponent(params.slug ?? '');
  const legacy = url.searchParams.get('section');
  if (legacy !== null) {
    redirect(307, editSectionHref(slug, parseEditSection(legacy)));
  }
  if (params.section && !parseEditSection(params.section)) {
    redirect(307, editSectionHref(slug));
  }
  return {};
};
