import { openEcosystemSite } from '$lib/navigation/openEcosystemSite';

/**
 * Where a profile photo is set: MiGallery's "mes photos" page (the gallery holds every Canari
 * profile photo, and has no narrower page for it). A path on MiGallery, on the handoff allowlist of
 * `libs/contracts/ecosystem-sites.json`; the origin is the launcher's one list of addresses.
 */
export const MIGALLERY_PROFILE_PHOTO_DEST = '/mes-photos';

/**
 * Opens MiGallery's photo page WITHOUT leaving Canari, through the one opener
 * (`openEcosystemSite`): signed in when MiGallery's handoff is on, plainly otherwise; the system
 * browser in the apps, a NEW TAB on the web, opened in the click's own turn.
 */
export function openProfilePhotoPage(): void {
  openEcosystemSite('migallery', MIGALLERY_PROFILE_PHOTO_DEST);
}
