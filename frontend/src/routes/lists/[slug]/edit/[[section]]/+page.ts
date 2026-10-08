import { redirect } from '@sveltejs/kit';
import {
  LIST_EDIT_SECTIONS,
  editSectionHref,
  parseEditSection,
} from '$lib/associations/editSections';
import type { PageLoad } from './$types';

/**
 * A list's management area is a hub of three sections, each a route segment. A segment that is not
 * one of them (including an association-only key such as `payments`) lands on the hub; whether the
 * reader may open a known one is decided by the page once the roster is loaded.
 */
export const load: PageLoad = ({ params }) => {
  const slug = decodeURIComponent(params.slug ?? '');
  const section = parseEditSection(params.section);
  if (params.section && (!section || !LIST_EDIT_SECTIONS.includes(section))) {
    redirect(307, editSectionHref(slug, null, '/lists'));
  }
  return {};
};
