/** Chrome/WebView-specific audio processing flags (not in standard MediaTrackConstraints). */
type ChromeAudioConstraints = MediaTrackConstraints & {
  googEchoCancellation?: ConstrainBoolean;
  googNoiseSuppression?: ConstrainBoolean;
  googAutoGainControl?: ConstrainBoolean;
  googHighpassFilter?: ConstrainBoolean;
  googTypingNoiseDetection?: ConstrainBoolean;
};

/**
 * Builds getUserMedia audio constraints tuned for VoIP:
 * mono, 48 kHz, echo cancellation, noise suppression, and auto gain.
 */
export function buildCallAudioConstraints(): ChromeAudioConstraints {
  return {
    echoCancellation: { ideal: true },
    noiseSuppression: { ideal: true },
    autoGainControl: { ideal: true },
    channelCount: { ideal: 1 },
    sampleRate: { ideal: 48_000 },
    googEchoCancellation: { ideal: true },
    googNoiseSuppression: { ideal: true },
    googAutoGainControl: { ideal: true },
    googHighpassFilter: { ideal: true },
    googTypingNoiseDetection: { ideal: true },
  };
}

/** Opus max bitrate (bps) for voice-only vs video calls. */
const AUDIO_BITRATE_VOICE = 48_000;
const AUDIO_BITRATE_VIDEO = 64_000;

/**
 * Applies Opus encoding parameters on all audio senders (bitrate cap, mono preference).
 * Best-effort: ignored on browsers that do not expose encoding controls.
 */
export async function configureCallAudioSenders(
  pc: RTCPeerConnection,
  hasVideo: boolean
): Promise<void> {
  const maxBitrate = hasVideo ? AUDIO_BITRATE_VIDEO : AUDIO_BITRATE_VOICE;

  for (const sender of pc.getSenders()) {
    if (sender.track?.kind !== 'audio') continue;

    try {
      const params = sender.getParameters();
      if (!params.encodings?.length) {
        params.encodings = [{}];
      }
      for (const encoding of params.encodings) {
        encoding.maxBitrate = maxBitrate;
      }
      await sender.setParameters(params);
    } catch {
      // Some WebViews reject setParameters before negotiation completes.
    }
  }
}

/** Logs applied audio track settings after getUserMedia (debug). */
export function logCallAudioTrackSettings(stream: MediaStream, log: (msg: string) => void): void {
  const track = stream.getAudioTracks()[0];
  if (!track) return;

  const settings = track.getSettings();
  log(
    `[Call] micro: echo=${String(settings.echoCancellation)} ` +
      `noise=${String(settings.noiseSuppression)} agc=${String(settings.autoGainControl)} ` +
      `rate=${settings.sampleRate ?? '?'}Hz ch=${settings.channelCount ?? '?'}`
  );
}
