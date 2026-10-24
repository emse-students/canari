/**
 * The camera of a 1:1 call: what is captured, how fast it is sent, and which codec carries it.
 * Shared by `CallService` and the desktop rig (`tools/call-audio-fidelity`), which IMPORTS these
 * rather than copying them, so the rig measures the app's own numbers.
 */
import { vp8CodecPreferences } from './callVideoFrame';
import type { CallVideoRung } from './callVideoQuality';

/** Which camera of a phone: the screen side (`user`) or the back (`environment`). */
export type CameraFacing = 'user' | 'environment';

/**
 * The capture constraints of the call camera: 1280x720 at up to 30 frames a second, the TOP rung
 * of the quality ladder (`utils/callVideoQuality.ts`); every lower rung is this capture scaled down
 * by the sender (`scaleResolutionDownBy`), so a drop or a climb never reopens the camera.
 * `facingMode` is IDEAL for the first capture (a desktop webcam has no facing) and EXACT for a
 * switch, where getting the same camera back would be a switch that silently did nothing.
 *
 * Size is IDEAL only, never `max`: both bench phones deliver the camera PORTRAIT (720x1280), and a
 * `max` written for landscape may be applied to the rotated dimensions - the engine then refuses
 * or falls to a smaller preset and the "720p" rung is never 720p (review of #2173). The reel
 * camera asks the same way. The size actually captured is logged at the camera's opening.
 */
export function callVideoConstraints(facing: CameraFacing, exact = false): MediaTrackConstraints {
  return {
    facingMode: exact ? { exact: facing } : { ideal: facing },
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30, max: 30 },
  };
}

/**
 * Puts a video sender on one rung of the ladder (resolution scale, frame rate, bitrate ceiling).
 * The encodings belong to the SENDER, so they survive a `replaceTrack` (camera switch, off/on).
 * Returns `false` when the engine refuses `setParameters`, logged at ERROR: the sender then keeps
 * what it had, and the caller stops moving it (`CallService`) - there is no other way to set it.
 */
export async function applyCallVideoRung(
  sender: RTCRtpSender,
  rung: CallVideoRung,
  log: (msg: string) => void
): Promise<boolean> {
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    params.encodings[0].maxBitrate = rung.maxBitrate;
    params.encodings[0].maxFramerate = rung.maxFramerate;
    params.encodings[0].scaleResolutionDownBy = rung.scaleResolutionDownBy;
    await sender.setParameters(params);
    log(
      `[Call] video sender on ${rung.name} (scale ${rung.scaleResolutionDownBy}, ${rung.maxFramerate} fps, max ${rung.maxBitrate / 1000} kbps)`
    );
    return true;
  } catch (e) {
    log(`[Call] ERROR video sender setParameters(${rung.name}) refused: ${String(e)}`);
    return false;
  }
}

/** The engine's video codecs, or `null` when it cannot list them. */
function videoCapabilities(): RTCRtpCodec[] | null {
  if (typeof RTCRtpReceiver === 'undefined' || !RTCRtpReceiver.getCapabilities) return null;
  return RTCRtpReceiver.getCapabilities('video')?.codecs ?? null;
}

/**
 * Whether this engine can hold a call's video to VP8 (`preferVp8` would succeed): it lists VP8 and
 * has `setCodecPreferences`. Asked BEFORE the camera is opened, so a camera that could not be sent
 * correctly is never captured.
 */
export function canHoldVideoToVp8(): boolean {
  const caps = videoCapabilities();
  return (
    !!caps &&
    vp8CodecPreferences(caps).length > 0 &&
    typeof RTCRtpTransceiver !== 'undefined' &&
    typeof RTCRtpTransceiver.prototype.setCodecPreferences === 'function'
  );
}

/**
 * Restricts a video transceiver to VP8 (`vp8CodecPreferences`) - the only video codec whose frames
 * the E2E transform frames correctly (`utils/callVideoFrame.ts`). Applied on EVERY video
 * transceiver of the call, the camera's and the one the peer's offer created, so whichever side
 * offers or answers, the negotiated codec is VP8. Returns `false`, logged at ERROR, when the
 * engine cannot do it: the caller then refuses to send video, never sends a codec it cannot
 * encrypt properly.
 */
export function preferVp8(transceiver: RTCRtpTransceiver, log: (msg: string) => void): boolean {
  const caps = videoCapabilities();
  const prefs = caps ? vp8CodecPreferences(caps) : [];
  if (prefs.length === 0 || typeof transceiver.setCodecPreferences !== 'function') {
    log(
      `[Call] ERROR video codec VP8 cannot be required on this engine (${caps ? `${caps.length} video codec(s), no VP8` : 'no codec list'}${typeof transceiver.setCodecPreferences === 'function' ? '' : ', no setCodecPreferences'}) - this side sends no video`
    );
    return false;
  }
  try {
    transceiver.setCodecPreferences(prefs);
    return true;
  } catch (e) {
    log(`[Call] ERROR setCodecPreferences(VP8) refused: ${String(e)} - this side sends no video`);
    return false;
  }
}
