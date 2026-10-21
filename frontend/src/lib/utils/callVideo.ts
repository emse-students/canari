/**
 * The camera of a 1:1 call: what is captured, how fast it is sent, and which codec carries it.
 * Shared by `CallService` and the desktop rig (`tools/call-audio-fidelity`), which IMPORTS these
 * rather than copying them, so the rig measures the app's own numbers.
 */
import { vp8CodecPreferences } from './callVideoFrame';

/** Which camera of a phone: the screen side (`user`) or the back (`environment`). */
export type CameraFacing = 'user' | 'environment';

/**
 * The capture constraints of the call camera. 640x480 at up to 30 frames a second: a phone screen
 * shows the other party full screen, and the bitrate below is the ceiling anyway. `facingMode` is
 * IDEAL for the first capture (a desktop webcam has no facing) and EXACT for a switch, where
 * getting the same camera back would be a switch that silently did nothing.
 */
export function callVideoConstraints(facing: CameraFacing, exact = false): MediaTrackConstraints {
  return {
    facingMode: exact ? { exact: facing } : { ideal: facing },
    width: { ideal: 640, max: 1280 },
    height: { ideal: 480, max: 720 },
    frameRate: { ideal: 30, max: 30 },
  };
}

/**
 * The video sender's bitrate ceiling (bps). A direct path rarely needs less, but a relayed call is
 * billed by Cloudflare TURN per byte and every byte crosses it twice; 700 kb/s keeps 640x480 VP8
 * sharp at 30 fps (measured in the rig, calls.md "Video, measured").
 */
export const CALL_VIDEO_MAX_BITRATE = 700_000;

/**
 * Caps a video sender (bitrate, frame rate). Best effort: an engine that refuses `setParameters`
 * keeps its own rate, and the refusal is LOGGED - a bitrate nobody can explain is the alternative.
 * The encodings belong to the SENDER, so they survive a `replaceTrack` (camera switch, off/on).
 */
export async function applyCallVideoSenderLimits(
  sender: RTCRtpSender,
  log: (msg: string) => void
): Promise<void> {
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    params.encodings[0].maxBitrate = CALL_VIDEO_MAX_BITRATE;
    params.encodings[0].maxFramerate = 30;
    await sender.setParameters(params);
    log(`[Call] video sender capped at ${CALL_VIDEO_MAX_BITRATE / 1000} kbps`);
  } catch (e) {
    log(`[Call] video sender setParameters refused: ${String(e)} - engine default kept`);
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
