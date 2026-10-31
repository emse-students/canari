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

/**
 * Whether this browser can broadcast its SCREEN instead of the camera (owner, 2026-10-31): the
 * engine has `getDisplayMedia`, and the primary pointer is a mouse - phones and tablets keep the
 * camera. **NEVER IN THE TAURI SHELL, EXPLICITLY**: its webviews have no reliable screen picker
 * (WebView2 and WebKitGTK each answer `getDisplayMedia` differently, or not at all), and a desktop
 * app that offers a button that may do nothing is worse than one that does not offer it. The check
 * is on the runtime, not on the pointer, because a Tauri desktop window has a mouse.
 */
export function screenShareAvailable(): boolean {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getDisplayMedia) return false;
  if (isTauriRuntime()) return false;
  return !isCoarsePointerDevice();
}

/**
 * Mixes the microphone and the share's audio into ONE track through an `AudioContext`, or answers
 * `null` (and logs why) when the context cannot run - the caller then keeps the microphone alone.
 *
 * KNOWN LIMIT: the mixed track's `ended` event does NOT follow the microphone. A microphone that
 * dies mid-live (a USB headset pulled) leaves the mixed track alive and silent for the mic's half,
 * with the share's sound still in it - the recorder keeps recording, nothing ends, and the live goes
 * on with the share only. Wiring it would mean ending a live over a half of its audio that the
 * member has no way to restore from a click-less state; the live is not interrupted over it. Stopping
 * the mixed track stops every source and closes the context.
 */
async function mixAudio(
  mic: MediaStreamTrack,
  share: MediaStreamTrack,
  sources: MediaStreamTrack[]
): Promise<MediaStreamTrack | null> {
  let context: AudioContext | null = null;
  try {
    context = new AudioContext();
    await context.resume();
    if (context.state !== 'running') {
      console.warn(
        `[LIVE-CAM] the audio context is ${context.state} after resume - the microphone alone goes on air, without the share's sound`
      );
      void context.close();
      return null;
    }
    const destination = context.createMediaStreamDestination();
    context.createMediaStreamSource(new MediaStream([mic])).connect(destination);
    context.createMediaStreamSource(new MediaStream([share])).connect(destination);
    const track = destination.stream.getAudioTracks()[0];
    const stopMixed = track.stop.bind(track);
    const owned = context;
    track.stop = () => {
      stopMixed();
      for (const source of sources) source.stop();
      void owned.close();
    };
    console.debug("[LIVE-CAM] screen audio: the microphone mixed with the share's own audio");
    return track;
  } catch (err) {
    console.warn(
      "[LIVE-CAM] mixing the share's audio failed - the microphone alone goes on air",
      err
    );
    void context?.close();
    return null;
  }
}

/**
 * Opens the SCREEN for a live: the video of what the member picks (a screen, a window or a tab) at
 * the live's size, and ONE audio track that is the microphone, mixed with the share's own audio
 * (a tab's or the system's) when the browser offers one. The microphone is kept: a live has a
 * voice. `audio: true` on the share only ASKS - the picker shows its "share audio" choice where
 * the browser has one and the member decides, so a share without sound is an answer, not a failure.
 *
 * The mix lives in an `AudioContext`. Releasing the stream (`releaseCamera` stops every track)
 * stops the mixed track, whose `stop` is wrapped to close the context and stop the sources it
 * reads - nothing else would ever end them.
 *
 * @throws {CameraAccessError} `denied` when the picker is dismissed or the microphone refused (the
 * caller returns to the camera on a dismissed picker), `unavailable` when the engine cannot share.
 */
export async function openLiveScreen(): Promise<MediaStream> {
  console.debug('[LIVE-CAM] opening the screen');
  const devices = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  if (!devices?.getDisplayMedia || !devices.getUserMedia) {
    console.warn('[LIVE-CAM] getDisplayMedia is absent');
    throw new CameraAccessError('unavailable', 'live screen: getDisplayMedia is not available');
  }
  let display: MediaStream;
  try {
    display = await devices.getDisplayMedia({
      video: {
        width: { ideal: LIVE_CAPTURE_LONG_SIDE_PX },
        height: { ideal: LIVE_CAPTURE_SHORT_SIDE_PX },
        frameRate: { ideal: LIVE_CAPTURE_FPS },
      },
      audio: true,
    });
  } catch (err) {
    const fault = classifyCameraError(err);
    console.warn(`[LIVE-CAM] the screen picker answered ${fault}`, err);
    throw new CameraAccessError(fault, `live screen: ${fault}`, { cause: err });
  }
  let mic: MediaStream;
  try {
    mic = await devices.getUserMedia({ audio: REEL_AUDIO_CONSTRAINTS });
  } catch (err) {
    for (const track of display.getTracks()) track.stop();
    const fault = classifyCameraError(err);
    console.warn(`[LIVE-CAM] the microphone for the screen share answered ${fault}`, err);
    throw new CameraAccessError(fault, `live screen: microphone ${fault}`, { cause: err });
  }
  const video = display.getVideoTracks()[0];
  const shareAudio = display.getAudioTracks();
  const micTrack = mic.getAudioTracks()[0];
  const sources: MediaStreamTrack[] = micTrack ? [micTrack, ...shareAudio] : [...shareAudio];
  let audio: MediaStreamTrack | undefined = micTrack;
  if (micTrack && shareAudio.length > 0) {
    // The context is built AFTER two awaits (the picker, the microphone), so the browser may have
    // left it `suspended` (autoplay policy): a suspended context mixes NOTHING and the live would go
    // out silent. It is resumed, and a context that will not run is given up for the microphone alone.
    const mixed = await mixAudio(micTrack, shareAudio[0], sources);
    if (mixed) audio = mixed;
    else for (const track of shareAudio) track.stop();
  } else {
    console.debug(`[LIVE-CAM] screen audio: ${micTrack ? 'the microphone alone' : 'none'}`);
  }
  const settings = video?.getSettings?.();
  console.debug(
    `[LIVE-CAM] screen opened: ${settings?.width ?? '?'}x${settings?.height ?? '?'} @ ${settings?.frameRate ?? '?'}`
  );
  return new MediaStream([...(video ? [video] : []), ...(audio ? [audio] : [])]);
}
