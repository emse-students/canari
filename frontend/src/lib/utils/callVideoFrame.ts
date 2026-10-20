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
 * (`vp8CodecPreferences`) on every engine in scope (Chromium, WebKit), and a frame naming any other
 * codec is encrypted WHOLE - it then cannot decode, and the worker says why - never sent in clear.
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

/**
 * Whether `mimeType` - the frame metadata's - is a codec whose frames this transform encrypts with
 * a clear header. FAIL CLOSED: an engine that names no codec is NOT read as VP8, so its frames are
 * encrypted whole and counted (`not-vp8`) - the clear split is taken only on the engine's word.
 * What keeps the call on VP8 is `vp8CodecPreferences` on every transceiver; this is the frame's
 * own check, and it never trusts a silence.
 */
export function isCallVideoCodec(mimeType: string | undefined): boolean {
  return mimeType !== undefined && mimeType.toLowerCase() === CALL_VIDEO_MIME_TYPE;
}

/**
 * How many leading bytes of `payload` stay in clear: 10 for a VP8 key frame, 3 for an interframe;
 * 0 for audio and for any video codec other than VP8 (encrypted whole). The SAME function runs on
 * both sides, on the clear first byte, so the two agree with no field. It is NOT bounded by the
 * payload: a frame shorter than its header cannot be split the same way on both sides, and the
 * sender drops it (`encryption.worker.ts`, `encryptFrame`).
 */
export function clearHeaderBytes(
  kind: 'audio' | 'video',
  mimeType: string | undefined,
  payload: Uint8Array
): number {
  if (kind !== 'video' || !isCallVideoCodec(mimeType)) return 0;
  return isVp8KeyFrame(payload) ? VP8_KEY_FRAME_CLEAR_BYTES : VP8_INTER_FRAME_CLEAR_BYTES;
}

/** The subset of `RTCRtpCodec` the preference filter reads. */
export interface CodecCapability {
  mimeType: string;
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
