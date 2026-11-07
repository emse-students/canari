import { ECOSYSTEM_SITES } from '$lib/navigation/ecosystemSites';
import { Log } from '$lib/utils/Log';

/**
 * Where a profile photo is set: MiGallery's "mes photos" page (the gallery holds every Canari
 * profile photo, and has no narrower page for it). Derived from the launcher's one list of sibling
 * addresses, so the day MiGallery moves it is that line alone that changes.
 */
export const MIGALLERY_PROFILE_PHOTO_URL = `${
  ECOSYSTEM_SITES.find((site) => site.id === 'migallery')?.href ?? 'https://gallery.mitv.fr'
}/mes-photos`;

/** Opens {@link MIGALLERY_PROFILE_PHOTO_URL} the way every external link opens (OS browser on native). */
export async function openProfilePhotoPage(): Promise<void> {
  Log.i('profilePhoto', 'opening the MiGallery photo page');
  const { navigateExternal } = await import('$lib/utils/openExternal');
  await navigateExternal(MIGALLERY_PROFILE_PHOTO_URL);
}
