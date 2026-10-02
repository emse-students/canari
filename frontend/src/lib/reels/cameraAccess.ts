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

/** Why the camera could not be opened. One code per cause the screen draws differently. */
export type CameraFault =
  /** The member (or a policy) refused: only the system settings can change it now. */
  | 'denied'
  /** No camera, no `mediaDevices` (an insecure origin), or none matching the request. */
  | 'unavailable'
  /** A camera exists and is allowed, but the OS could not start it (another app holds it). */
  | 'busy';

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

/** Which lens: the member's face, or the world. */
export type CameraFacing = 'user' | 'environment';

/**
 * The frame asked for. 1280x720 `ideal`, which both phones answer as a 720x1280 PORTRAIT track
 * (measured): 720p is what the upload is prepared to anyway (C3), so asking for more would only cost
 * the recorder memory and the encoder time.
 */
export const REEL_CAPTURE_IDEAL = { width: 1280, height: 720 } as const;

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
 * @throws {CameraAccessError} for every refusal, with its {@link CameraFault}.
 */
export async function openReelCamera(facing: CameraFacing): Promise<MediaStream> {
  console.debug(`[camera] opening ${facing}`);
  const devices = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  if (!devices?.getUserMedia) {
    // A fact before a request: an insecure origin or an engine with no capture at all.
    console.warn('[camera] navigator.mediaDevices.getUserMedia is absent');
    throw new CameraAccessError('unavailable', 'camera: getUserMedia is not available');
  }
  try {
    const stream = await devices.getUserMedia({
      video: {
        facingMode: facing,
        width: { ideal: REEL_CAPTURE_IDEAL.width },
        height: { ideal: REEL_CAPTURE_IDEAL.height },
      },
      audio: true,
    });
    const video = stream.getVideoTracks()[0];
    console.debug(`[camera] opened ${facing}: ${video?.label ?? 'no video track'}`);
    return stream;
  } catch (err) {
    const fault = classifyCameraError(err);
    console.warn(`[camera] refused (${fault})`, err);
    throw new CameraAccessError(fault, `camera: ${fault}`, { cause: err });
  }
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
