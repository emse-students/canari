import { describe, expect, it, vi } from 'vitest';
import { REEL_AUDIO_CONSTRAINTS } from '$lib/reels/framedCapture';
import { audioLayoutOf, describeAudioLayout, logCaptureAudioLayout } from './audioLayout';

describe('audioLayoutOf', () => {
  it('names the layout from the reported channel count', () => {
    expect(audioLayoutOf(1)).toBe('mono');
    expect(audioLayoutOf(2)).toBe('stereo');
    expect(audioLayoutOf(6)).toBe('multichannel');
    expect(audioLayoutOf(undefined)).toBe('unknown');
    expect(audioLayoutOf(0)).toBe('unknown');
  });
});

describe('describeAudioLayout', () => {
  it('is quiet about a mono track and accuses a stereo answer to a mono request', () => {
    expect(describeAudioLayout('LIVE-CAM', { channelCount: 1, sampleRate: 48000 })).toBe(
      '[LIVE-CAM] audio layout: mono (ch=1, rate=48000Hz)'
    );
    expect(describeAudioLayout('LIVE-CAM', { channelCount: 2 })).toContain('silent side');
  });
});

describe('logCaptureAudioLayout', () => {
  it('writes one info line for the first audio track', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const stream = {
      getAudioTracks: () => [{ getSettings: () => ({ channelCount: 1 }) }],
    } as unknown as MediaStream;
    logCaptureAudioLayout('reel-camera', stream);
    expect(info).toHaveBeenCalledTimes(1);
    info.mockRestore();
  });
});

describe('REEL_AUDIO_CONSTRAINTS', () => {
  it('asks for ONE channel, so a recording never carries a silent side', () => {
    expect(REEL_AUDIO_CONSTRAINTS.channelCount).toEqual({ ideal: 1 });
  });
});
