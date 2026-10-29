/**
 * WHAT A BROADCAST ASKS OF THE PHONE besides the recorder: the camera at the live's size, a screen
 * that stays on, and the battery reading the pre-live screen warns on (WP-L5).
 *
 * Each is a fact read from the engine; an engine without the API is logged once and the broadcast
 * goes on without that one thing - there is no substitute path (no hidden video loop to keep the
 * screen on, no guessed battery).
 */

import { CameraAccessError, classifyCameraError, type CameraFacing } from '$lib/reels/cameraAccess';
import { facingConstraint, lensIsExact } from '$lib/utils/cameraFacing';
import { REEL_AUDIO_CONSTRAINTS } from '$lib/reels/framedCapture';
import {
  LIVE_BATTERY_WARN_LEVEL,
  LIVE_CAPTURE_FPS,
  LIVE_CAPTURE_LONG_SIDE_PX,
  LIVE_CAPTURE_SHORT_SIDE_PX,
} from './constants';

/**
 * Opens the camera AND the microphone for a live: a live has sound, so one request, as the reel
 * tab makes (a refused microphone refuses the live, said by the camera screen's `denied` text).
 *
 * 1280x720 asked as the bench asked it; both phones answer a portrait 720x1280 track (WP-L1). The
 * lens is asked as the reel camera asks it (`lensIsExact`): EXACT on a phone and on a switch, IDEAL on
 * a desktop's first capture, whose webcam has no facing for an exact one to match.
 *
 * @throws {CameraAccessError} for every refusal, with its fault.
 */
export async function openLiveCamera(
  facing: CameraFacing,
  switching = false
): Promise<MediaStream> {
  const exact = lensIsExact(switching);
  console.debug(`[LIVE-CAM] opening ${facing} (${exact ? 'exact' : 'ideal'})`);
  const devices = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  if (!devices?.getUserMedia) {
    console.warn('[LIVE-CAM] navigator.mediaDevices.getUserMedia is absent');
    throw new CameraAccessError('unavailable', 'live camera: getUserMedia is not available');
  }
  try {
    const stream = await devices.getUserMedia({
      video: {
        facingMode: facingConstraint(facing, exact),
        width: { ideal: LIVE_CAPTURE_LONG_SIDE_PX },
        height: { ideal: LIVE_CAPTURE_SHORT_SIDE_PX },
        frameRate: { ideal: LIVE_CAPTURE_FPS },
      },
      audio: REEL_AUDIO_CONSTRAINTS,
    });
    const settings = stream.getVideoTracks()[0]?.getSettings?.();
    console.debug(
      `[LIVE-CAM] opened ${facing}: ${settings?.width ?? '?'}x${settings?.height ?? '?'} @ ${settings?.frameRate ?? '?'}`
    );
    return stream;
  } catch (err) {
    const fault = classifyCameraError(err);
    console.warn(`[LIVE-CAM] refused (${fault})`, err);
    throw new CameraAccessError(fault, `live camera: ${fault}`, { cause: err });
  }
}

/** The part of `WakeLockSentinel` used here. */
interface Sentinel {
  release(): Promise<void>;
  readonly released?: boolean;
}

/** The part of `navigator.wakeLock` used here, injectable for tests. */
export interface WakeLockApi {
  request(type: 'screen'): Promise<Sentinel>;
}

/**
 * KEEPS THE SCREEN ON WHILE A LIVE IS ON AIR - or a video call is up (`tag` names whose lock it is
 * in the log: `LIVE-WAKE`, `CALL-WAKE`). The engine releases a screen lock by itself when the
 * page is hidden, so {@link hold} is called again on every return to the screen; holding twice is a
 * no-op while the first lock stands.
 *
 * EVERY REQUEST CARRIES A TICKET, bumped by every hold and every release: a sentinel that resolves
 * after a release, or after a newer hold, is given straight back - so hold -> release -> hold with
 * the first request still in flight can never leave an orphan lock nobody releases.
 */
export class ScreenWakeLock {
  #sentinel: Sentinel | null = null;
  #wanted = false;
  /** The newest hold or release; a request answered under an older one is stale. */
  #ticket = 0;
  /** The ticket of the newest request the browser refused; a lock answered later may stand. */
  #refusedTicket = -1;
  #warned = false;

  constructor(
    private readonly api: WakeLockApi | undefined = typeof navigator !== 'undefined'
      ? (navigator as Navigator & { wakeLock?: WakeLockApi }).wakeLock
      : undefined,
    private readonly tag = 'LIVE-WAKE'
  ) {}

  /** Asks for the screen to stay on (again after a background). */
  async hold(): Promise<void> {
    this.#wanted = true;
    if (!this.api) {
      if (!this.#warned) {
        this.#warned = true;
        console.warn(`[${this.tag}] no Screen Wake Lock API here - the screen may dim`);
      }
      return;
    }
    if (this.#sentinel && !this.#sentinel.released) return;
    const ticket = ++this.#ticket;
    try {
      const sentinel = await this.api.request('screen');
      const heldAlready = this.#sentinel !== null && !this.#sentinel.released;
      const newestRefused = this.#refusedTicket === this.#ticket;
      if (!this.#wanted || heldAlready || (ticket !== this.#ticket && !newestRefused)) {
        // Released, held by another request, or superseded by one still in flight: this one is
        // nobody's. Superseded by one that was REFUSED it is not stale: the only lock there is.
        console.debug(`[${this.tag}] a stale screen lock answered - given straight back`);
        await sentinel.release();
        return;
      }
      this.#sentinel = sentinel;
      console.debug(`[${this.tag}] screen held on`);
    } catch (err) {
      // A hidden page, or a policy: the screen may dim. Logged, never retried on a timer.
      this.#refusedTicket = ticket;
      console.warn(`[${this.tag}] the screen lock was refused`, err);
    }
  }

  /** Lets the screen sleep again. */
  release(): void {
    this.#wanted = false;
    ++this.#ticket;
    const sentinel = this.#sentinel;
    this.#sentinel = null;
    if (!sentinel || sentinel.released) return;
    sentinel.release().then(
      () => console.debug(`[${this.tag}] screen released`),
      (err: unknown) => console.warn(`[${this.tag}] releasing the screen lock failed`, err)
    );
  }
}

/** The part of the Battery API read here. */
interface BatteryReading {
  level: number;
  charging: boolean;
}

/**
 * The battery level (0..1), or null where the engine has no Battery API (WebKit) or it refused.
 * Read once, before the live: the warning is about whether to START, not a gauge.
 */
export async function readBatteryLevel(
  nav: { getBattery?: () => Promise<BatteryReading> } | undefined = typeof navigator !== 'undefined'
    ? (navigator as Navigator & { getBattery?: () => Promise<BatteryReading> })
    : undefined
): Promise<number | null> {
  if (typeof nav?.getBattery !== 'function') {
    console.debug('[LIVE-BATTERY] no Battery API here - no warning can be given');
    return null;
  }
  try {
    const battery = await nav.getBattery();
    console.debug(
      `[LIVE-BATTERY] ${Math.round(battery.level * 100)} %${battery.charging ? ', charging' : ''}`
    );
    return battery.level;
  } catch (err) {
    console.warn('[LIVE-BATTERY] the Battery API refused', err);
    return null;
  }
}

/**
 * Whether the pre-live screen warns: below {@link LIVE_BATTERY_WARN_LEVEL}, charging or not - the
 * bench drained 40 %/h on a charger.
 */
export function batteryWarrantsWarning(level: number | null): boolean {
  return level !== null && level < LIVE_BATTERY_WARN_LEVEL;
}
