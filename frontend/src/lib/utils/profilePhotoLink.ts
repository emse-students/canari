import { ECOSYSTEM_SITES } from '$lib/navigation/ecosystemSites';
import { Log } from '$lib/utils/Log';
import { isTauriRuntime } from '$lib/utils/tauriRuntime';

/**
 * Where a profile photo is set: MiGallery's "mes photos" page (the gallery holds every Canari
 * profile photo, and has no narrower page for it). Derived from the launcher's one list of sibling
 * addresses, so the day MiGallery moves it is that line alone that changes.
 */
export const MIGALLERY_PROFILE_PHOTO_URL = `${
  ECOSYSTEM_SITES.find((site) => site.id === 'migallery')?.href ?? 'https://gallery.mitv.fr'
}/mes-photos`;

/**
 * Opens {@link MIGALLERY_PROFILE_PHOTO_URL} WITHOUT leaving Canari: the system browser in the apps,
 * a NEW TAB on the web (`navigateExternal` would replace the Canari tab). On the web `window.open`
 * is called synchronously, in the click's own task, so the browser's popup rule - which wants a
 * user gesture - is met; nothing is awaited before it. A `null` answer is a popup blocker refusing
 * anyway, and is logged. A rejected open (the Tauri opener) is logged, never thrown into the click.
 */
export function openProfilePhotoPage(): void {
  Log.i('profilePhoto', 'opening the MiGallery photo page');
  if (isTauriRuntime()) {
    void import('@tauri-apps/plugin-opener')
      .then(({ openUrl }) => openUrl(MIGALLERY_PROFILE_PHOTO_URL))
      .catch((e) => console.warn('[profilePhoto] the MiGallery photo page could not be opened', e));
    return;
  }
  const opened = window.open(MIGALLERY_PROFILE_PHOTO_URL, '_blank', 'noopener');
  if (!opened) {
    // `noopener` makes `window.open` answer null even on success in some browsers, so a null is a
    // hint, not proof: logged at debug level rather than accused.
    Log.d('profilePhoto', 'window.open answered null - blocked by a popup rule, or noopener');
  }
}
