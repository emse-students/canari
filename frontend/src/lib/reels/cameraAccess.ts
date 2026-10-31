/**
 * Opening the phone's camera for a CanaReel (R3, decision C5) - and the three ways it can be refused,
 * as TYPES classified where `getUserMedia` throws.
 *
 * READ ON BOTH PHONES BEFORE ANYTHING WAS BUILT ON IT (2026-10-01, docs/wiki/frontend/modules/reels.md):
 * - Mi 9T, Android 16, WebView 152: the WebView's `VIDEO_CAPTURE` request reaches Android's runtime
 *   prompt through `RustWebChromeClient.onPermissionRequest`; "Ne pas autoriser" rejects with
 *   `NotAllowedError`, and a grant answers a 720x1280 PORTRAIT track for `ideal` 1280x720.
 * - iPhone 12, WKWebView: the OS asks for the MICROPHONE first, then the camera, each with its
 *   `Info.plist` purpose string; a grant answers the same 720x1280 portrait track.
 * - On both, `navigator.permissions.query({ name: 'camera' })` answered `prompt` AFTER a refusal on
 *   Android, so it cannot predict anything: the outcome of the request is the only fact, and this
 *   module reads nothing else.
 *
 * NO SECOND PATH. A refused camera is a state the screen explains (`CameraScreen`), never a hand-off
 * to the system camera app - the capture screen is the app's own (R3).
 */
import { facingConstraint, lensIsExact, type CameraFacing } from '$lib/utils/cameraFacing';
import { REEL_AUDIO_CONSTRAINTS, cameraVideoConstraints } from './framedCapture';
import { REEL_FRAME_RATIO, containFrame } from './reelFrame';

/** Why the camera could not be opened. One code per cause the screen draws differently. */
export type CameraFault =
  /** The member (or a policy) refused: only the system settings can change it now. */
  | 'denied'
  /** No camera, no `mediaDevices` (an insecure origin), or none matching the request. */
  | 'unavailable'
  /** A camera exists and is allowed, but the OS could not start it (another app holds it). */
  | 'busy'
  /**
   * A LIVE lens ended under the preview: another app took it, or the permission was withdrawn. The
   * track's end does not say which, so this names only what is known.
   */
  | 'interrupted';

/** A camera that could not be opened, classified at the throw so no caller reads a message. */
export class CameraAccessError extends Error {
  constructor(
    readonly fault: CameraFault,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'CameraAccessError';
  }
}

export type { CameraFacing };

/**
 * Turns a `getUserMedia` rejection into a {@link CameraFault}.
 *
 * The names are the Media Capture spec's: `NotAllowedError` (and the older `SecurityError`) is a
 * refusal; `NotFoundError` and `OverconstrainedError` mean there is nothing to open; `NotReadableError`
 * and `AbortError` mean the hardware would not start, which on a phone is another app holding it.
 * Anything else is reported as `unavailable` WITH its name in the log - a new name is a fact to read,
 * not one to guess at.
 */
export function classifyCameraError(err: unknown): CameraFault {
  const name = err instanceof Error || err instanceof DOMException ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
    case 'PermissionDeniedError':
      return 'denied';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'busy';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'unavailable';
    default:
      console.warn(`[camera] unclassified getUserMedia rejection "${name}" - read as unavailable`);
      return 'unavailable';
  }
}

/**
 * Opens the camera AND the microphone for a reel.
 *
 * Audio is asked in the same request because a reel has sound and the recorder needs both tracks
 * from the start; on iOS that is two system questions, microphone first (measured).
 *
 * `withAudio: false` is the PHOTO-ONLY camera (a chat, D-camera 2026-10-11): it never asks for the
 * microphone, so a refused or absent one cannot block a photo. See {@link openPhotoCamera}.
 *
 * @throws {CameraAccessError} for every refusal, with its {@link CameraFault}.
 */
export async function openReelCamera(
  facing: CameraFacing,
  withAudio = true,
  switching = false
): Promise<MediaStream> {
  const exact = lensIsExact(switching);
  console.debug(
    `[camera] opening ${facing} (${exact ? 'exact' : 'ideal'})${withAudio ? '' : ' (no microphone)'}`
  );
  const devices = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  if (!devices?.getUserMedia) {
    // A fact before a request: an insecure origin or an engine with no capture at all.
    console.warn('[camera] navigator.mediaDevices.getUserMedia is absent');
    throw new CameraAccessError('unavailable', 'camera: getUserMedia is not available');
  }
  try {
    // THE FRAME ASKED FOR IS THE REEL FRAME'S, as large as the screen shows it, capped
    // (framedCapture.ts): the canonical 9:16 shown whole in the screen, so the recorded file has the
    // ratio every surface draws. Both phones answer a landscape request as a portrait track
    // (measured 2026-10-01).
    const shown = containFrame(
      { width: window.screen.width, height: window.screen.height },
      REEL_FRAME_RATIO
    );
    const wanted = cameraVideoConstraints(shown, window.devicePixelRatio || 1);
    const stream = await devices.getUserMedia({
      video: {
        // EXACT on a phone and on a switch (`lensIsExact`): an IDEAL was answered with the BACK lens by
        // WKWebView on an iPhone (alpha.4 reading, 2026-10-06). An unavailable lens is then an
        // OverconstrainedError, classified below and logged - never a silent switch to the other one.
        // IDEAL on a desktop's first capture: a webcam has no facing, so an exact one never opens.
        facingMode: facingConstraint(facing, exact),
        width: { ideal: wanted.width },
        height: { ideal: wanted.height },
        frameRate: { ideal: wanted.frameRate },
      },
      audio: withAudio ? REEL_AUDIO_CONSTRAINTS : false,
    });
    const video = stream.getVideoTracks()[0];
    const reported = video?.getSettings?.().facingMode;
    if (exact && reported && reported !== facing) {
      // The engine granted a lens other than the exact one asked for: a defect to read, not to absorb.
      console.error(`[camera] asked ${facing} exactly, the track reports ${reported}`);
    }
    console.debug(`[camera] opened ${facing}: ${video?.label ?? 'no video track'}`);
    return stream;
  } catch (err) {
    const fault = classifyCameraError(err);
    console.warn(`[camera] refused (${fault})`, err);
    throw new CameraAccessError(fault, `camera: ${fault}`, { cause: err });
  }
}

/** The opener of a PHOTO-ONLY camera: the lens alone, no microphone request. */
export const openPhotoCamera: (
  facing: CameraFacing,
  switching?: boolean
) => Promise<MediaStream> = (facing, switching) => openReelCamera(facing, false, switching);

/**
 * The opener of the NEW-POST camera: the lens and the microphone as TWO INDEPENDENT requests.
 *
 * WHY NOT ONE REQUEST, AS THE REEL TAB MAKES (PR #1859 review, 2026-10-15). One request is one
 * outcome: a refused or absent microphone rejected the whole of it, so the post camera took no PHOTO
 * either - and the system camera that used to cover a post's photo is gone (D-camera). A post photo
 * needs no microphone, so the lens is asked alone and its refusal is the camera's
 * ({@link CameraAccessError}); the microphone is then asked on its own, and ITS outcome is a fact
 * about the session, read by the capture screen from the stream (no audio track: photos only, said
 * to the member). Neither request is a retry of the other, and nothing is learnt by failing: each
 * answers the one question it asks. On iOS that is the same two system questions as the combined
 * request, camera first this time.
 *
 * ONE OPENER PER CAMERA SESSION, because it REMEMBERS a refused microphone: a lens flip reopens
 * through the same opener, and asking again after a refusal would put the question (or, once denied
 * for good, a silent failure) in front of every flip. The refusal is the answer for the session; the
 * next session asks again.
 *
 * The returned opener throws {@link CameraAccessError} when the LENS is refused - never for the
 * microphone.
 */
export function postCameraOpener(): (
  facing: CameraFacing,
  switching?: boolean
) => Promise<MediaStream> {
  let microphoneRefused: CameraFault | null = null;
  return async (facing, switching) => {
    const lens = await openReelCamera(facing, false, switching);
    if (microphoneRefused) {
      console.debug(
        `[camera] post camera: microphone already refused (${microphoneRefused}) this session - not asked again`
      );
      return lens;
    }
    try {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: REEL_AUDIO_CONSTRAINTS });
      console.debug('[camera] post camera: microphone granted - photos and videos');
      return new MediaStream([...lens.getVideoTracks(), ...mic.getAudioTracks()]);
    } catch (err) {
      microphoneRefused = classifyCameraError(err);
      console.warn(
        `[camera] post camera: microphone refused (${microphoneRefused}) - PHOTOS ONLY`,
        err
      );
      return lens;
    }
  };
}

/**
 * How many cameras this device has: its `videoinput` devices. READ AFTER A CAMERA IS OPEN - before
 * the grant a browser may list none, or hide the labels - and again on `devicechange`. THROWS when
 * the device list cannot be read; the caller decides (and logs) what a missing answer means.
 */
export async function countVideoInputs(): Promise<number> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'videoinput').length;
}

/** Hands the camera and the microphone back. Safe on a stream already stopped. */
export function releaseCamera(stream: MediaStream | null): void {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
  console.debug('[camera] released');
}

/**
 * Whether this track can light its torch - a CAPABILITY of the lens, read from the track itself.
 * Both back cameras answered `torch: true` and turned it on (measured); the Mi 9T's front camera
 * does not list `torch` at all, so the button is simply not drawn there.
 */
export function torchSupported(track: MediaStreamTrack | undefined): boolean {
  if (!track || typeof track.getCapabilities !== 'function') return false;
  const caps = track.getCapabilities() as MediaTrackCapabilities & { torch?: boolean };
  return caps.torch === true;
}

/** Turns the torch on or off. Rejects as the engine does; the caller logs and reports it. */
export async function setTorch(track: MediaStreamTrack, on: boolean): Promise<void> {
  console.debug(`[camera] torch ${on ? 'on' : 'off'}`);
  await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
}
