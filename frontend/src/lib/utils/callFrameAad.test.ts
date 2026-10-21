import { describe, expect, it } from 'vitest';
import { callMediaKind, frameAad } from './callFrameAad';

describe('frameAad', () => {
  it('is `canari-call-v2|audio` for an audio frame (no clear header)', () => {
    expect(new TextDecoder().decode(frameAad('audio', new Uint8Array(0)))).toBe(
      'canari-call-v2|audio'
    );
  });

  it('is `canari-call-v2|video` followed by the clear VP8 header for a video frame', () => {
    const aad = frameAad('video', Uint8Array.from([0x31, 0x01, 0x00]));
    expect(Array.from(aad)).toEqual([
      ...new TextEncoder().encode('canari-call-v2|video'),
      0x31,
      0x01,
      0x00,
    ]);
  });

  it('differs between the two kinds for the same header', () => {
    const header = Uint8Array.from([1, 2, 3]);
    expect(frameAad('audio', header)).not.toEqual(frameAad('video', header));
  });
});

describe('callMediaKind', () => {
  it('keeps audio and video, and refuses anything else', () => {
    expect(callMediaKind('audio')).toBe('audio');
    expect(callMediaKind('video')).toBe('video');
    expect(callMediaKind('unknown')).toBeNull();
    expect(callMediaKind(undefined)).toBeNull();
  });
});
