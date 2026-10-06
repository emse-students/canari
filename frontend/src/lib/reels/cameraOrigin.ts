import { CAMERA_PLACE } from '$lib/navigation/places';

/** Where a camera opened from nowhere inside the app (a cold link) goes back to: the feed. */
export const CAMERA_DEFAULT_ORIGIN = '/posts';

/**
 * The tab the camera was opened from, read from the navigation that opened it.
 *
 * WHY IT IS REMEMBERED INSTEAD OF STEPPED BACK TO: closing used `history.back()`, whose target is
 * whatever entry happens to sit below the camera - overlay entries a swipe drained leave ghosts,
 * and a Back-driven take leaves its own - so on the Mi 9T (2026-10-06) leaving the camera landed on
 * the Dashboard rather than on the tab the member had come from. The origin is a fact of the
 * navigation that opened the camera, so it is carried from there.
 *
 * @param from The previous location SvelteKit reports, or null/undefined on a first page.
 * @returns A path inside the app, never the camera itself.
 */
export function cameraOriginFrom(from: URL | null | undefined): string {
  if (!from) return CAMERA_DEFAULT_ORIGIN;
  const path = from.pathname;
  if (path === CAMERA_PLACE.href || path.startsWith(`${CAMERA_PLACE.href}/`)) {
    return CAMERA_DEFAULT_ORIGIN;
  }
  return `${path}${from.search}`;
}
