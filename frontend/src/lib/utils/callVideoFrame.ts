/**
 * The bytes of an encoded VIDEO frame the E2E transform leaves in clear, and the codec a call's
 * video is bound to (2026-10-20).
 *
 * WHY a clear prefix at all: the receiver's RTP depacketiser runs BEFORE the receiver transform and
 * reads the VP8 payload header itself (RFC 6386 section 9.1): the P bit of the first byte decides
 * whether the frame is a key frame, and a key frame's bytes 3-9 carry the start code and the
 * dimensions. Encrypted, that byte is random - half the delta frames read as key frames and half
 * the key frames as deltas, which breaks the frame-reference chain the jitter buffer builds - so
 * every E2E design for VP8 (WebRTC's own e2ee sample, Cloudflare's Orange Meets) leaves 10 bytes of
 * a key frame and 3 of an interframe in clear. What they show: key or delta, the VP8 version,
 * show_frame, the first partition's size, and a key frame's width and height - never a pixel. The
 * prefix is bound to the ciphertext as AES-GCM additional data, so it cannot be altered unseen.
 *
 * WHY VP8 only: H.264's packetiser splits a frame on its Annex B start codes and reads each NAL
 * header; encrypted, neither exists, so an encrypted H.264 frame cannot even be packetised the way
 * the receiver expects. A clear-header scheme for H.264 would have to rewrite emulation-prevention
 * bytes inside the ciphertext. So the call's video m-lines are restricted to VP8
 * (`vp8CodecPreferences`) on every engine in scope (Chromium, WebKit), and a frame of a transform
 * not known to carry VP8, or naming another codec, is encrypted WHOLE (`framesAsVp8`) - it then
 * cannot decode, and the worker says why - never sent in clear.
 */

/** Clear bytes of a VP8 key frame: the 3-byte frame tag, the start code, width and height. */
export const VP8_KEY_FRAME_CLEAR_BYTES = 10;
/** Clear bytes of a VP8 interframe: the 3-byte frame tag. */
export const VP8_INTER_FRAME_CLEAR_BYTES = 3;

/** The one video codec a call's frames are encrypted for (see the module comment). */
export const CALL_VIDEO_MIME_TYPE = 'video/vp8';

/** RFC 6386 section 9.1: the P bit (bit 0 of the first byte) is 0 on a key frame. */
export function isVp8KeyFrame(payload: Uint8Array): boolean {
  return payload.byteLength > 0 && (payload[0] & 0x01) === 0;
}

/** Whether `mimeType` names VP8, the one codec a call's video frames are framed for. */
export function isCallVideoCodec(mimeType: string | undefined): boolean {
  return mimeType !== undefined && mimeType.toLowerCase() === CALL_VIDEO_MIME_TYPE;
}

/**
 * Whether a VIDEO frame is framed as VP8 (a clear header) - decided by the TRANSFORM's codec, never
 * by the engine's frame metadata alone (2026-11-07).
 *
 * WHY. The codec is KNOWN where the transform is made: `CallService` attaches a video transform only
 * on a transceiver it has just held to VP8 (`preferVp8`, `setCodecPreferences`), so nothing else can
 * be negotiated on it, and it passes that fact in the transform's options (`videoCodec`). The frame
 * metadata is an engine detail: Chromium names `video/VP8`, WebKit (iOS 1.6.5, measured in
 * production) names NOTHING (`mime=? pt=-1`). Deciding on the metadata framed the iPhone's frames
 * WHOLE and Chromium's SPLIT, so every video frame failed in both directions - a layout the two ends
 * computed differently from one and the same codec.
 *
 * FAIL CLOSED, both ways: a transform whose codec is not known to be VP8 frames whole (counted,
 * `not-vp8`), and so does a frame whose metadata NAMES another codec - the engine contradicting the
 * transceiver is a negotiation that went wrong, and its frames cannot decode anyway. A metadata that
 * names nothing (`undefined` or empty) is silence, not a contradiction: the transform's codec stands.
 * The SAME function runs on both sides with the same inputs, so the layout is identical on every
 * engine.
 */
export function framesAsVp8(
  transformCodec: string | undefined,
  frameMimeType: string | undefined
): boolean {
  if (!isCallVideoCodec(transformCodec)) return false;
  return !frameMimeType || isCallVideoCodec(frameMimeType);
}

/**
 * How many leading bytes of `payload` stay in clear: 10 for a VP8 key frame, 3 for an interframe;
 * 0 for audio and for a video frame not framed as VP8 (`framesAsVp8`, encrypted whole). The SAME
 * function runs on both sides, on the clear first byte, so the two agree with no field. It is NOT
 * bounded by the payload: a frame shorter than its header cannot be split the same way on both
 * sides, and the sender drops it (`encryption.worker.ts`, `encryptFrame`).
 */
export function clearHeaderBytes(
  kind: 'audio' | 'video',
  vp8: boolean,
  payload: Uint8Array
): number {
  if (kind !== 'video' || !vp8) return 0;
  return isVp8KeyFrame(payload) ? VP8_KEY_FRAME_CLEAR_BYTES : VP8_INTER_FRAME_CLEAR_BYTES;
}

/** The subset of `RTCRtpCodec` the preference filter reads. */
export interface CodecCapability {
  mimeType: string;
}

/**
 * The media codec a NEGOTIATED side carries, read from its `getParameters().codecs`: the first
 * entry that is not a wrapper (RTX, RED, ULPFEC carry no frame of their own). `undefined` while
 * nothing is negotiated on that side (an empty list).
 */
export function negotiatedMediaCodec(
  codecs: readonly CodecCapability[] | undefined
): string | undefined {
  return codecs?.find((c) => !/^video\/(rtx|red|ulpfec)$/i.test(c.mimeType))?.mimeType;
}

/**
 * The witness WebKit's frames cannot be (2026-11-07): WebKit's frame metadata names no codec, so
 * the worker's "the frame names another codec" check never fires there, and an engine that
 * ignored `setCodecPreferences` would send H.264 framed as VP8 unseen. So, once negotiation
 * settles, the codec each side actually NEGOTIATED is compared with the codec its transform was
 * told (`CallTransformOptions.videoCodec`). Returns the mismatch to report, or `null`. A report,
 * never a behaviour: the frames are framed as before.
 */
export function negotiatedCodecMismatch(
  heldCodec: string | undefined,
  negotiated: string | undefined
): string | null {
  if (!negotiated) return null;
  if (isCallVideoCodec(heldCodec) && isCallVideoCodec(negotiated)) return null;
  return `negotiated ${negotiated}, transform frames ${heldCodec ?? 'no codec (whole)'}`;
}

/**
 * The video codec list a call transceiver is restricted to (`setCodecPreferences`): VP8 and its
 * retransmission (RTX), in the engine's own order; RED and ULPFEC are left out (they wrap media
 * packets the transform never sees, and nothing needs them on a 1:1 call). Empty when the engine
 * cannot send or receive VP8 at all - the caller refuses video then.
 */
export function vp8CodecPreferences<T extends CodecCapability>(codecs: readonly T[]): T[] {
  const vp8 = codecs.filter((c) => c.mimeType.toLowerCase() === CALL_VIDEO_MIME_TYPE);
  if (vp8.length === 0) return [];
  return codecs.filter((c) => {
    const mime = c.mimeType.toLowerCase();
    return mime === CALL_VIDEO_MIME_TYPE || mime === 'video/rtx';
  });
}
