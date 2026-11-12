import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loudnessOfDecodedAudio,
  measureRecordingLoudness,
  type DecodedAudio,
} from './recordingLoudness';

/** A decoded recording: `seconds` of a 997 Hz sine at `amplitude`, on every channel. */
function sine(amplitude: number, seconds = 3, sampleRate = 48_000, channels = 1): DecodedAudio {
  const length = Math.round(seconds * sampleRate);
  const plane = new Float32Array(length);
  for (let i = 0; i < length; i++)
    plane[i] = amplitude * Math.sin((2 * Math.PI * 997 * i) / sampleRate);
  return {
    sampleRate,
    numberOfChannels: channels,
    length,
    getChannelData: () => plane,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('loudnessOfDecodedAudio', () => {
  it('measures a mono 997 Hz sine at -20 dBFS as -23 LUFS (BS.1770: full scale is -3.01)', () => {
    const loudness = loudnessOfDecodedAudio(sine(0.1))!;
    expect(loudness.integratedLufs).toBeCloseTo(-23.01, 1);
    expect(loudness.samplePeakDbfs).toBeCloseTo(-20, 1);
  });

  it('is null for silence and for an empty decode', () => {
    expect(loudnessOfDecodedAudio(sine(0))).toBeNull();
    expect(loudnessOfDecodedAudio(sine(0.1, 0))).toBeNull();
  });
});

describe('measureRecordingLoudness - the voice note is measured at send', () => {
  it('decodes the recording bytes and measures them with the one meter', async () => {
    const recording = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' });
    const decode = vi.fn(async (bytes: ArrayBuffer) => {
      expect(new Uint8Array(bytes)).toEqual(new Uint8Array([1, 2, 3]));
      return sine(0.1);
    });
    const loudness = await measureRecordingLoudness(recording, decode);
    expect(decode).toHaveBeenCalledOnce();
    expect(loudness!.integratedLufs).toBeCloseTo(-23.01, 1);
  });

  it('sends unmeasured, and says why, when the engine cannot decode the recording', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const recording = new Blob([new Uint8Array([9])], { type: 'audio/webm' });
    const loudness = await measureRecordingLoudness(recording, async () => {
      throw new DOMException('unsupported', 'EncodingError');
    });
    expect(loudness).toBeNull();
    expect(String(warn.mock.calls[0][0])).toContain('audio/webm');
  });

  it('sends unmeasured where there is no offline decoder at all', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await measureRecordingLoudness(new Blob([]), null)).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });
});
