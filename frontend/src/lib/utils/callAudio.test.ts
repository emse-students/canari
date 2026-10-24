import { buildCallAudioConstraints, configureCallAudioSenders } from './callAudio';

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

describe('configureCallAudioSenders', () => {
  const pcWith = (setParameters: () => Promise<void>) =>
    ({
      signalingState: 'stable',
      getSenders: () => [
        { track: { kind: 'audio' }, getParameters: () => ({ encodings: [{}] }), setParameters },
      ],
    }) as unknown as RTCPeerConnection;

  it('caps the audio bitrate and logs nothing when the engine accepts', async () => {
    const setParameters = vi.fn(async () => {});
    const log = vi.fn();
    await configureCallAudioSenders(pcWith(setParameters), false, log);
    expect(setParameters).toHaveBeenCalledWith({ encodings: [{ maxBitrate: 48_000 }] });
    expect(log).not.toHaveBeenCalled();
  });

  it('LOGS a refused setParameters rather than swallowing it', async () => {
    const log = vi.fn();
    await configureCallAudioSenders(
      pcWith(async () => {
        throw new Error('InvalidStateError');
      }),
      true,
      log
    );
    expect(log).toHaveBeenCalledWith(
      '[Call] audio sender setParameters refused (maxBitrate=64000, signaling=stable): Error: InvalidStateError - engine default kept'
    );
  });
});
