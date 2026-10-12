import { redirect } from '@sveltejs/kit';
import { parseProfileSection, profileSectionHref } from '$lib/profile/profileSections';
import type { PageLoad } from './$types';

/** An unknown segment (a typo, a removed section) lands on the hub, never on a blank page. */
export const load: PageLoad = ({ params }) => {
  const section = parseProfileSection(params.section);
  if (!section) redirect(307, profileSectionHref());
  return { section };
};
