/**
 * THE ONE `facingMode` CONSTRAINT of every camera the app opens (call, reel, post, live).
 *
 * A desktop webcam reports NO facing, so an EXACT facing can never be met there: Chrome rejects it
 * with `OverconstrainedError` and the camera never opens (found on dev by the cross-client rig, the
 * live composer). IDEAL always opens something. EXACT is kept for the cases where getting the other
 * camera than the one asked for would be a defect: an explicit lens switch, and a phone's first
 * capture (WKWebView answered the BACK lens to an ideal `user`, alpha.4 reading 2026-10-06).
 */
import { isCoarsePointerDevice } from './pointerDevice';

/** Which camera of a phone: the screen side (`user`) or the back (`environment`). */
export type CameraFacing = 'user' | 'environment';

/** The `facingMode` constraint: `exact` or `ideal`, never a bare value. */
export function facingConstraint(
  facing: CameraFacing,
  exact: boolean
): { exact: CameraFacing } | { ideal: CameraFacing } {
  return exact ? { exact: facing } : { ideal: facing };
}

/**
 * Whether a reel or live camera asks its lens EXACTLY: on an explicit switch, and on a phone (a
 * coarse primary pointer - the devices that HAVE a front and a back lens). A desktop's first capture
 * is ideal, since its webcam has no facing to match.
 */
export function lensIsExact(switching: boolean): boolean {
  return switching || isCoarsePointerDevice();
}
