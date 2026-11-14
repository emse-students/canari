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
import { isCoarsePointerDevice } from '$lib/utils/pointerDevice';
import { isTauriRuntime } from '$lib/utils/tauriRuntime';
import { REEL_AUDIO_CONSTRAINTS } from '$lib/reels/framedCapture';
import { captureUserMedia } from '$lib/utils/audioSession';
import { logCaptureAudioLayout } from '$lib/utils/audioLayout';
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
 * `withMicrophone` false opens the lens alone: a desktop live's microphone is its own capture
 * ({@link openLiveMicrophone}), so a desktop with no webcam can still go live on its screen.
 *
 * @throws {CameraAccessError} for every refusal, with its fault.
 */
export async function openLiveCamera(
  facing: CameraFacing,
  switching = false,
  withMicrophone = true
): Promise<MediaStream> {
  const exact = lensIsExact(switching);
  console.debug(
    `[LIVE-CAM] opening ${facing} (${exact ? 'exact' : 'ideal'}${withMicrophone ? '' : ', no microphone'})`
  );
  const devices = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  if (!devices?.getUserMedia) {
    console.warn('[LIVE-CAM] navigator.mediaDevices.getUserMedia is absent');
    throw new CameraAccessError('unavailable', 'live camera: getUserMedia is not available');
  }
  try {
    const stream = await captureUserMedia(
      devices,
      {
        video: {
          facingMode: facingConstraint(facing, exact),
          width: { ideal: LIVE_CAPTURE_LONG_SIDE_PX },
          height: { ideal: LIVE_CAPTURE_SHORT_SIDE_PX },
          frameRate: { ideal: LIVE_CAPTURE_FPS },
        },
        audio: withMicrophone ? REEL_AUDIO_CONSTRAINTS : false,
      },
      'live-camera'
    );
    if (withMicrophone) logCaptureAudioLayout('LIVE-CAM', stream);
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
      // A hidden page, a missing user activation, a permission or a feature policy: the screen may
      // dim. Logged, never retried on a timer. The engine's refusal is written as TEXT, its message
      // included: passed as an object, the log keeps only a DOMException's class (`NotAllowedError`)
      // and loses the sentence that names WHICH of those gates refused - the one fact that decides
      // the fix (the iPhone refuses every video call, 2026-11-07).
      this.#refusedTicket = ticket;
      console.warn(
        `[${this.tag}] the screen lock was refused (${String(err)}) - the screen may dim`
      );
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

/**
 * Whether this browser broadcasts through the SCENES (owner, 2026-10-31 for the screen, 2026-11-14
 * for the scenes): the engine has `getDisplayMedia` and an `AudioContext` (the scenes' sound is
 * mixed, `liveAudioMixer.svelte.ts`), and the primary pointer is a mouse - phones and tablets keep
 * the camera recorded directly. **NEVER IN THE TAURI SHELL, EXPLICITLY**: its webviews have no
 * reliable screen picker (WebView2 and WebKitGTK each answer `getDisplayMedia` differently, or not
 * at all), and a desktop app that offers a button that may do nothing is worse than one that does
 * not offer it. The check is on the runtime, not on the pointer, because a Tauri desktop window has
 * a mouse.
 */
export function liveScenesAvailable(): boolean {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getDisplayMedia) return false;
  if (typeof AudioContext === 'undefined') return false;
  if (isTauriRuntime()) return false;
  return !isCoarsePointerDevice();
}

/**
 * Opens the MICROPHONE alone, for a desktop live whose picture is composed (`liveStudio.svelte.ts`):
 * the camera and the screen come and go with the scenes, the voice stays. Asked mono, as every
 * capture of a live or a reel is (`REEL_AUDIO_CONSTRAINTS`).
 *
 * @throws {CameraAccessError} for every refusal, with its fault (a refused microphone refuses the live).
 */
export async function openLiveMicrophone(): Promise<MediaStream> {
  console.debug('[LIVE-CAM] opening the microphone');
  const devices = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  if (!devices?.getUserMedia) {
    console.warn('[LIVE-CAM] navigator.mediaDevices.getUserMedia is absent');
    throw new CameraAccessError('unavailable', 'live microphone: getUserMedia is not available');
  }
  try {
    const stream = await captureUserMedia(devices, { audio: REEL_AUDIO_CONSTRAINTS }, 'live-mic');
    logCaptureAudioLayout('LIVE-CAM', stream);
    return stream;
  } catch (err) {
    const fault = classifyCameraError(err);
    console.warn(`[LIVE-CAM] the microphone answered ${fault}`, err);
    throw new CameraAccessError(fault, `live microphone: ${fault}`, { cause: err });
  }
}

/**
 * Opens the SCREEN for a desktop live: what the member picks (a screen, a window or a tab), at the
 * live's size where the browser can scale it, with the share's own sound when the picker offers one
 * and the member ticks it - `audio: true` only ASKS, so a share without sound is an answer, not a
 * failure. **CALL IT FROM A CLICK**: a browser opens the picker only on one. No microphone here: the
 * live's microphone is opened once for the whole live ({@link openLiveMicrophone}) and mixed with
 * this stream's sound (`liveAudioMixer.svelte.ts`).
 *
 * The size the share answers is NOT the live's: the compositor fits it into a fixed frame, so a
 * window resized mid-share changes nothing the recorder sees (`liveCompositor.ts`).
 *
 * @throws {CameraAccessError} `denied` when the picker is dismissed, `unavailable` when the engine
 * cannot share.
 */
export async function openLiveDisplay(): Promise<MediaStream> {
  console.debug('[LIVE-CAM] opening the screen picker');
  const devices = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  if (!devices?.getDisplayMedia) {
    console.warn('[LIVE-CAM] getDisplayMedia is absent');
    throw new CameraAccessError('unavailable', 'live screen: getDisplayMedia is not available');
  }
  try {
    const display = await devices.getDisplayMedia({
      video: {
        width: { ideal: LIVE_CAPTURE_LONG_SIDE_PX },
        height: { ideal: LIVE_CAPTURE_SHORT_SIDE_PX },
        frameRate: { ideal: LIVE_CAPTURE_FPS },
      },
      audio: true,
    });
    const settings = display.getVideoTracks()[0]?.getSettings?.();
    console.debug(
      `[LIVE-CAM] screen opened: ${settings?.width ?? '?'}x${settings?.height ?? '?'} @ ${settings?.frameRate ?? '?'}, ` +
        `${display.getAudioTracks().length > 0 ? "with the share's sound" : 'no sound of its own'}`
    );
    return display;
  } catch (err) {
    const fault = classifyCameraError(err);
    console.warn(`[LIVE-CAM] the screen picker answered ${fault}`, err);
    throw new CameraAccessError(fault, `live screen: ${fault}`, { cause: err });
  }
}
