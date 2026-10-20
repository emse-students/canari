import { describe, expect, it } from 'vitest';
import {
  VP8_INTER_FRAME_CLEAR_BYTES,
  VP8_KEY_FRAME_CLEAR_BYTES,
  clearHeaderBytes,
  isCallVideoCodec,
  isVp8KeyFrame,
  vp8CodecPreferences,
} from './callVideoFrame';

/**
 * The clear prefix of an encrypted video frame and the codec a call is held to. The rig measured
 * WHY (calls.md, "Video, measured"): a VP8 frame encrypted whole decodes with ~500 key frames in 34 s
 * (the depacketiser reads a random P bit), and an H.264 one does not decode at all.
 */
describe('isVp8KeyFrame', () => {
  it('reads the P bit of the first byte: 0 is a key frame', () => {
    expect(isVp8KeyFrame(Uint8Array.from([0x10]))).toBe(true);
    expect(isVp8KeyFrame(Uint8Array.from([0x31]))).toBe(false);
    expect(isVp8KeyFrame(new Uint8Array(0))).toBe(false);
  });
});

describe('clearHeaderBytes', () => {
  const key = Uint8Array.from({ length: 40 }, (_, i) => (i === 0 ? 0x10 : 1));
  const inter = Uint8Array.from({ length: 40 }, (_, i) => (i === 0 ? 0x31 : 1));

  it('is 10 bytes for a VP8 key frame and 3 for an interframe', () => {
    expect(clearHeaderBytes('video', 'video/VP8', key)).toBe(VP8_KEY_FRAME_CLEAR_BYTES);
    expect(clearHeaderBytes('video', 'video/VP8', inter)).toBe(VP8_INTER_FRAME_CLEAR_BYTES);
  });

  it('is 0 for audio, whatever its bytes: the audio layout every build has sent', () => {
    expect(clearHeaderBytes('audio', 'audio/opus', key)).toBe(0);
  });

  it('is 0 for another video codec: encrypted whole, never framed as VP8', () => {
    expect(clearHeaderBytes('video', 'video/H264', key)).toBe(0);
  });

  it('FAILS CLOSED on an engine that names no codec: encrypted whole, never split on a guess', () => {
    expect(clearHeaderBytes('video', undefined, key)).toBe(0);
  });

  it('is not bounded by a short payload: the sender drops a frame shorter than its header', () => {
    expect(clearHeaderBytes('video', 'video/VP8', Uint8Array.from([0x10, 0, 0]))).toBe(10);
  });
});

describe('isCallVideoCodec', () => {
  it('is VP8 in any case, and never an engine that names no codec', () => {
    expect(isCallVideoCodec('video/VP8')).toBe(true);
    expect(isCallVideoCodec('video/vp8')).toBe(true);
    expect(isCallVideoCodec(undefined)).toBe(false);
    expect(isCallVideoCodec('video/H264')).toBe(false);
    expect(isCallVideoCodec('video/VP9')).toBe(false);
  });
});

describe('vp8CodecPreferences', () => {
  it('keeps VP8 and RTX in the engine order, and drops H.264, RED and ULPFEC', () => {
    const codecs = [
      { mimeType: 'video/H264' },
      { mimeType: 'video/VP8' },
      { mimeType: 'video/rtx' },
      { mimeType: 'video/red' },
      { mimeType: 'video/ulpfec' },
    ];
    expect(vp8CodecPreferences(codecs).map((c) => c.mimeType)).toEqual(['video/VP8', 'video/rtx']);
  });

  it('is empty on an engine without VP8: the caller refuses video', () => {
    expect(vp8CodecPreferences([{ mimeType: 'video/H264' }, { mimeType: 'video/rtx' }])).toEqual(
      []
    );
  });
});
