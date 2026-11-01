/**
 * THE LENS LAST USED, ONE MEMORY FOR EVERY CAMERA OF THE APP (owner, 2026-11-01).
 *
 * The chat camera, the CanaReels tab, the new-post camera and the live all run on `CameraSession`,
 * so one key read when a session is built and written when the member flips the lens is the whole
 * mechanism. The choice belongs to the DEVICE, never to an account (a phone's lens is a fact about
 * the phone), so it is not an `ACCOUNT_KEY` and a sign-out leaves it alone.
 *
 * AN ABSENT VALUE IS THE FIRST RUN, not a fault: it reads as the front lens (the selfie is a reel's
 * usual first shot, user 2026-10-02) at debug level. A value that is PRESENT and unreadable - storage
 * throwing, or a string that is no lens - is a defect to read, so it warns.
 */
import type { CameraFacing } from '$lib/utils/cameraFacing';

/** The `localStorage` key of the remembered lens. */
export const CAMERA_LENS_KEY = 'canari_camera_lens';

/** The lens a camera opens on when nothing usable is remembered. */
export const DEFAULT_LENS: CameraFacing = 'user';

/** The remembered lens; the front one when none is stored or the store cannot be trusted. */
export function recallLens(): CameraFacing {
  try {
    const stored = localStorage.getItem(CAMERA_LENS_KEY);
    if (stored === null) {
      console.debug('[camera-lens] nothing remembered - opening on the front lens');
      return DEFAULT_LENS;
    }
    if (stored === 'user' || stored === 'environment') {
      console.debug(`[camera-lens] remembered ${stored}`);
      return stored;
    }
    console.warn(
      `[camera-lens] the stored lens "${stored}" is not a lens - opening on the front lens`
    );
    return DEFAULT_LENS;
  } catch (err) {
    console.warn('[camera-lens] the remembered lens could not be read - front lens', err);
    return DEFAULT_LENS;
  }
}

/** Remembers `facing` for every camera; a store that refuses costs the memory only, and says so. */
export function rememberLens(facing: CameraFacing): void {
  try {
    localStorage.setItem(CAMERA_LENS_KEY, facing);
    console.debug(`[camera-lens] remembered ${facing}`);
  } catch (err) {
    console.warn(
      `[camera-lens] ${facing} could not be remembered - the next camera forgets it`,
      err
    );
  }
}
