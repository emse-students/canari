import { redirect } from '@sveltejs/kit';
import { parseSettingsSection, settingsSectionHref } from '$lib/settings/settingsSections';
import type { PageLoad } from './$types';

/** An unknown segment (a typo, a removed section) lands on the hub, never on a blank page. */
export const load: PageLoad = ({ params }) => {
  const section = parseSettingsSection(params.section);
  if (!section) redirect(307, settingsSectionHref());
  return { section };
};
