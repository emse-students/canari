import { describe, expect, it } from 'vitest';
import {
  VP8_INTER_FRAME_CLEAR_BYTES,
  VP8_KEY_FRAME_CLEAR_BYTES,
  clearHeaderBytes,
  framesAsVp8,
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
    expect(clearHeaderBytes('video', true, key)).toBe(VP8_KEY_FRAME_CLEAR_BYTES);
    expect(clearHeaderBytes('video', true, inter)).toBe(VP8_INTER_FRAME_CLEAR_BYTES);
  });

  it('is 0 for audio, whatever its bytes: the audio layout every build has sent', () => {
    expect(clearHeaderBytes('audio', true, key)).toBe(0);
  });

  it('is 0 for a video frame not framed as VP8: encrypted whole', () => {
    expect(clearHeaderBytes('video', false, key)).toBe(0);
  });

  it('is not bounded by a short payload: the sender drops a frame shorter than its header', () => {
    expect(clearHeaderBytes('video', true, Uint8Array.from([0x10, 0, 0]))).toBe(10);
  });
});

describe('framesAsVp8 - the transform codec decides, not the engine (2026-11-07)', () => {
  it('frames as VP8 on a VP8 transform whether the engine names VP8 (Chromium) or nothing (WebKit)', () => {
    expect(framesAsVp8('video/VP8', 'video/VP8')).toBe(true);
    expect(framesAsVp8('video/vp8', undefined)).toBe(true);
    expect(framesAsVp8('video/VP8', '')).toBe(true);
  });

  it('FAILS CLOSED on a transform whose codec is not known, whatever the frame says', () => {
    expect(framesAsVp8(undefined, 'video/VP8')).toBe(false);
    expect(framesAsVp8(undefined, undefined)).toBe(false);
    expect(framesAsVp8('video/H264', 'video/H264')).toBe(false);
  });

  it('FAILS CLOSED when the engine NAMES another codec than the transform: a negotiation gone wrong', () => {
    expect(framesAsVp8('video/VP8', 'video/H264')).toBe(false);
  });
});

describe('isCallVideoCodec', () => {
  it('is VP8 in any case, and never a missing name', () => {
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
