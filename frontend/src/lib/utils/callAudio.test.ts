import { describe, expect, it } from 'vitest';
import { buildCallAudioConstraints } from './callAudio';

describe('buildCallAudioConstraints', () => {
  it('enables echo cancellation, noise suppression, and AGC', () => {
    const c = buildCallAudioConstraints();
    expect(c.echoCancellation).toEqual({ ideal: true });
    expect(c.noiseSuppression).toEqual({ ideal: true });
    expect(c.autoGainControl).toEqual({ ideal: true });
    expect(c.channelCount).toEqual({ ideal: 1 });
    expect(c.sampleRate).toEqual({ ideal: 48_000 });
  });

  it('requests Chrome-specific processing flags when available', () => {
    const c = buildCallAudioConstraints();
    expect(c.googNoiseSuppression).toEqual({ ideal: true });
    expect(c.googEchoCancellation).toEqual({ ideal: true });
  });
});
