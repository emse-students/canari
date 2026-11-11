import { onAppScreenChange } from '$lib/utils/appForeground';
import { isAndroidTauriRuntime, isIosTauriRuntime } from '$lib/utils/appVersion';
import { Log } from '$lib/utils/Log';

/**
 * THE CAMERA IN FRONT, AS NATIVE SEES IT: the volume keys as its shutter, and which way the PHONE is
 * held while the screen itself stays upright (owner, 2026-11-11; docs/wiki/frontend/screen-orientation.md,
 * "The camera keeps its layout").
 *
 * The camera's layout is locked portrait, as the system camera apps: turning the phone moves no
 * control, each glyph turns in place to read upright, and the photo or take comes out the way the
 * phone was held. The SCREEN cannot say how the phone is held (it does not turn), so native reads the
 * accelerometer - Android `OrientationEventListener`, iOS `CMMotionManager`, both indifferent to the
 * rotation lock, as a camera must be - and tells the page the angle.
 *
 * ONE FLAG, OWNED BY THE MOUNTED CAMERA, AND NO CLOCK. A camera screen ARMS it while its preview is
 * live and in front ({@link useCameraHardware}); native then intercepts the volume keys (the system
 * volume does not move) and runs the sensor. The flag falls:
 * - when the screen's live preview ends or it unmounts (the `$effect`'s teardown, the only way down
 *   while the app is on screen);
 * - when the app leaves the screen: native clears it on its own (`onPause`, `didEnterBackground`), so
 *   no stale flag survives a trip to the background, and the page says `off` too; the return to the
 *   screen re-arms it only if a camera still holds it;
 * - at every page load ({@link initCameraHardware}): a reload with the camera open must not leave
 *   native swallowing the volume keys of a page that has no camera.
 *
 * Native speaks back through two window events: {@link CAMERA_KEY_EVENT} (`{phase}`, see {@link CameraKeyPhase};
 * one `down` per press - native drops the key's auto-repeat) and {@link DEVICE_ANGLE_EVENT}
 * (`{degrees}`, the phone's clockwise turn from upright, sent only when it moved). The web build has
 * neither: no volume key reaches a page, and a browser tab turns its own layout with the phone.
 */

/** The phone's turn, clockwise from upright, in quarter turns. */
export type Quadrant = 0 | 90 | 180 | 270;
/**
 * A volume key's press and release; `cancel` is a press the system interrupted (iOS's
 * `AVCaptureEventPhaseCancelled`), which is not a release - as a touch the system took.
 */
export type CameraKeyPhase = 'down' | 'up' | 'cancel';

/** Native -> page: a volume key went down or up while the camera was armed. */
export const CAMERA_KEY_EVENT = 'canari:camera-key';
/** Native -> page: the phone's clockwise angle from upright, in degrees. */
export const DEVICE_ANGLE_EVENT = 'canari:device-angle';

/**
 * How far past the diagonal the phone must go before the quadrant changes: a phone held near 45
 * degrees would otherwise flip the glyphs back and forth with every tremor of the hand.
 */
export const QUADRANT_HYSTERESIS_DEG = 15;

/** The shortest angle between two directions, 0 to 180. */
function circularDistance(a: number, b: number): number {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return d > 180 ? 360 - d : d;
}

/** `value` brought into [0, 360). */
function normalise(value: number): number {
  return ((value % 360) + 360) % 360;
}

/**
 * The quadrant the phone is held in, given its angle and the quadrant held so far: the current one is
 * kept until the phone is {@link QUADRANT_HYSTERESIS_DEG} past the diagonal, then the nearest wins.
 */
export function quadrantFor(angle: number, current: Quadrant | null): Quadrant {
  const a = normalise(angle);
  if (current !== null && circularDistance(a, current) <= 45 + QUADRANT_HYSTERESIS_DEG) {
    return current;
  }
  return ((Math.round(a / 90) % 4) * 90) as Quadrant;
}

/**
 * How far the CAPTURE must be turned, clockwise, to come out upright: the phone's turn, less what the
 * screen itself already turned. `deviceTurn` is native's clockwise angle (`null` where no sensor
 * speaks: the web, whose layout follows the phone); `screenAngle` is `screen.orientation.angle`, the
 * screen's counter-clockwise turn from the device's natural orientation - 0 on a phone locked
 * upright, and on a tablet that turned its layout it cancels the phone's turn exactly.
 */
export function captureTurn(deviceTurn: Quadrant | null, screenAngle: number): Quadrant {
  if (deviceTurn === null) return 0;
  return ((Math.round(normalise(deviceTurn + screenAngle) / 90) % 4) * 90) as Quadrant;
}

/**
 * The CSS rotation of a glyph that reads upright when the capture is turned by `turn`: the opposite
 * turn, taken the SHORT way from the angle drawn now (`previous`), so 270 -> 0 animates a quarter
 * turn forward and never three quarters back. The result is cumulative and may leave [0, 360).
 */
export function nextGlyphRotation(previous: number, turn: Quadrant): number {
  const delta = normalise(-turn - previous + 180) - 180;
  return previous + delta;
}

/** `window.canariCamera`, registered by `MainActivity.onWebViewCreate`. */
interface AndroidCameraBridge {
  set(state: string): void;
}

/** `webkit.messageHandlers.canariCamera`, registered by `canari_ios.mm`. */
interface IosCameraHandler {
  postMessage(state: string): void;
}

function androidBridge(): AndroidCameraBridge | undefined {
  return (window as Window & { canariCamera?: AndroidCameraBridge }).canariCamera;
}

function iosHandler(): IosCameraHandler | undefined {
  return (
    globalThis as unknown as {
      webkit?: { messageHandlers?: { canariCamera?: IosCameraHandler } };
    }
  ).webkit?.messageHandlers?.canariCamera;
}

/** One armed camera: who it is (for the log) and where its keys go. */
interface Holder {
  id: number;
  owner: string;
  onKey: (phase: CameraKeyPhase) => void;
}

const holders: Holder[] = [];
let nextHolderId = 1;
/** What native was last told; null until the page load's post, so the first always goes. */
let posted: boolean | null = null;
/** An absent bridge is said once per page, not once per camera. */
let absenceSaid = false;
/** The listeners on the window, attached while at least one camera holds the flag. */
let detach: (() => void) | null = null;

/** The phone's quadrant as native last reported it; `null` until a sensor speaks. Reactive. */
class DeviceTurn {
  quadrant = $state<Quadrant | null>(null);
}
export const deviceTurn = new DeviceTurn();

/** Hands `on` to native; false off the native app (nothing to tell, nothing logged). */
function sendToNative(on: boolean): boolean {
  const android = isAndroidTauriRuntime();
  if (!android && !isIosTauriRuntime()) return false;
  const state = on ? 'on' : 'off';
  try {
    if (android) {
      const bridge = androidBridge();
      if (bridge) {
        bridge.set(state);
        return true;
      }
    } else {
      const handler = iosHandler();
      if (handler) {
        handler.postMessage(state);
        return true;
      }
    }
  } catch (e) {
    console.error(`[CAMERA-HW] native refused ${state}:`, e);
    return true;
  }
  if (on && !absenceSaid) {
    absenceSaid = true;
    console.error(
      '[CAMERA-HW] the canariCamera bridge is absent from this build - no volume shutter, glyphs stay upright'
    );
  }
  return true;
}

/** Posts `on` when it differs from what native holds; one line per change, naming why. */
function apply(on: boolean, why: string): void {
  if (posted === on) return;
  posted = on;
  if (sendToNative(on)) Log.i('CAMERA-HW', `${on ? 'armed' : 'disarmed'} (${why})`);
}

function onKeyEvent(event: Event): void {
  const phase = (event as CustomEvent<{ phase?: unknown }>).detail?.phase;
  if (phase !== 'down' && phase !== 'up' && phase !== 'cancel') {
    console.warn('[CAMERA-HW] a camera key event with no phase - ignored');
    return;
  }
  const holder = holders.at(-1);
  if (!holder) {
    // Native was told `off` before this key; the event crossed it in flight.
    console.warn(`[CAMERA-HW] volume ${phase} with no camera armed - dropped`);
    return;
  }
  Log.d('CAMERA-HW', `volume ${phase} -> ${holder.owner}`);
  holder.onKey(phase);
}

function onAngleEvent(event: Event): void {
  const degrees = (event as CustomEvent<{ degrees?: unknown }>).detail?.degrees;
  if (typeof degrees !== 'number' || !Number.isFinite(degrees)) {
    console.warn('[CAMERA-HW] a device angle event with no degrees - ignored');
    return;
  }
  const next = quadrantFor(degrees, deviceTurn.quadrant);
  if (next === deviceTurn.quadrant) return;
  Log.d('CAMERA-HW', `the phone is held at ${next} (angle ${Math.round(degrees)})`);
  deviceTurn.quadrant = next;
}

function attach(): void {
  if (detach || typeof window === 'undefined') return;
  window.addEventListener(CAMERA_KEY_EVENT, onKeyEvent);
  window.addEventListener(DEVICE_ANGLE_EVENT, onAngleEvent);
  // Native clears the flag itself when the app leaves the screen; the return re-arms it while a
  // camera still holds it, and the departure says it from this side too.
  const offScreen = onAppScreenChange((onScreen) =>
    apply(onScreen && holders.length > 0, onScreen ? 'app back on screen' : 'app left the screen')
  );
  detach = () => {
    window.removeEventListener(CAMERA_KEY_EVENT, onKeyEvent);
    window.removeEventListener(DEVICE_ANGLE_EVENT, onAngleEvent);
    offScreen();
  };
}

/**
 * Arms the flag for `owner` until the returned release: the volume keys go to `onKey` (the newest
 * holder's, if two overlap) and {@link deviceTurn} follows the phone. The release is idempotent.
 */
export function holdCameraHardware(
  owner: string,
  onKey: (phase: CameraKeyPhase) => void
): () => void {
  const holder: Holder = { id: nextHolderId++, owner, onKey };
  holders.push(holder);
  attach();
  apply(true, `${owner} live`);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const index = holders.findIndex((h) => h.id === holder.id);
    if (index >= 0) holders.splice(index, 1);
    if (holders.length > 0) return;
    apply(false, `${owner} released`);
    detach?.();
    detach = null;
    // The next camera starts from upright until its own sensor reading, never from a stale turn.
    deviceTurn.quadrant = null;
  };
}

/**
 * A component's hold for as long as `active()` is true while it is mounted: armed when it turns
 * true, released when it turns false or the component unmounts. Call during initialisation.
 */
export function useCameraHardware(
  owner: string,
  active: () => boolean,
  onKey: (phase: CameraKeyPhase) => void
): void {
  $effect(() => {
    if (!active()) return;
    return holdCameraHardware(owner, (phase) => onKey(phase));
  });
}

/**
 * Called ONCE per page load, from the root layout: the flag lives in the native PROCESS, so a reload
 * while a camera was armed would leave native swallowing the volume keys. Posts what THIS page holds
 * (a child mounts before the layout, so a page that boots on a camera keeps it armed).
 */
export function initCameraHardware(): void {
  posted = null;
  apply(holders.length > 0, 'a page loaded');
}

/** Test seam: forgets every holder and what was posted. */
export function resetCameraHardwareForTest(): void {
  holders.length = 0;
  nextHolderId = 1;
  posted = null;
  absenceSaid = false;
  detach?.();
  detach = null;
  deviceTurn.quadrant = null;
}
