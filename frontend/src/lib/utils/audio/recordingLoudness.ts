/**
 * A VOICE NOTE'S SOUND, MEASURED AT SEND (owner, 2026-11-12): the same BS.1770 measurement a video
 * gets (`loudnessMeter.ts`, `MediaRef.loudness`, `MediaMsg.loudness`), so every reader's player
 * brings a whispered note and a shouted one toward one loudness through the one playback law
 * (`loudnessPlayback.ts`).
 *
 * THE METER IS THE VIDEO'S, NOT A SECOND ONE: this file only DECODES the recording and hands its
 * planes to {@link LoudnessMeter}. The decode is the one the voice player already makes for its
 * waveform (`VoiceMessagePlayer.decodeSource`): an `OfflineAudioContext`, because measuring needs no
 * speaker and a realtime context would open a platform output stream (`utils/toneOutput.ts`).
 */

import { Log } from '$lib/utils/Log';
import { LoudnessMeter, type MediaLoudness } from '$lib/video/loudnessMeter';

/** The part of an `AudioBuffer` the measurement reads. */
export interface DecodedAudio {
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  readonly length: number;
  getChannelData(channel: number): Float32Array;
}

/** Decodes a recording's bytes to planar samples (an `AudioBuffer`), or throws. */
export type AudioDecoder = (bytes: ArrayBuffer) => Promise<DecodedAudio>;

/**
 * The sample rate the decode is asked for. `decodeAudioData` resamples to its context's rate; the
 * K-weighting filters are derived for whatever rate they are given, so the choice only has to be
 * one every engine decodes to.
 */
const DECODE_SAMPLE_RATE = 48_000;

/** The measurement of decoded samples: null for silence or nothing (see `LoudnessMeter.result`). */
export function loudnessOfDecodedAudio(decoded: DecodedAudio): MediaLoudness | null {
  if (decoded.numberOfChannels < 1 || decoded.length < 1) return null;
  const meter = new LoudnessMeter(decoded.sampleRate, decoded.numberOfChannels);
  const planes = Array.from({ length: decoded.numberOfChannels }, (_, c) =>
    decoded.getChannelData(c)
  );
  meter.push(planes, decoded.length);
  return meter.result();
}

/** The engine's own decoder, through an offline context (no speaker opened). */
const engineDecoder: AudioDecoder | null =
  typeof OfflineAudioContext === 'undefined'
    ? null
    : (bytes) => new OfflineAudioContext(1, 1, DECODE_SAMPLE_RATE).decodeAudioData(bytes);

/**
 * Measures a recording's integrated loudness and sample peak, or `null` where it cannot be decoded
 * here or holds only silence. NEVER A REFUSAL: a note this cannot measure is sent unmeasured, and
 * plays exactly as every note before this did.
 */
export async function measureRecordingLoudness(
  recording: Blob,
  decode: AudioDecoder | null = engineDecoder
): Promise<MediaLoudness | null> {
  Log.d('LOUDNESS', `measuring a recording of ${recording.size} bytes (${recording.type})`);
  if (!decode) {
    console.warn('[LOUDNESS] no OfflineAudioContext - the voice note is sent unmeasured');
    return null;
  }
  try {
    const decoded = await decode(await recording.arrayBuffer());
    const loudness = loudnessOfDecodedAudio(decoded);
    Log.d(
      'LOUDNESS',
      loudness
        ? `voice note measured: ${loudness.integratedLufs.toFixed(1)} LUFS, peak ${loudness.samplePeakDbfs.toFixed(1)} dBFS`
        : 'voice note measured as silence: sent unmeasured'
    );
    return loudness;
  } catch (e) {
    // A CAPABILITY OR A DAMAGED RECORDING, AND THE TWO ARE NOT ONE SILENCE: the line carries the
    // type, which separates "this engine cannot decode that container" from a corrupt blob.
    console.warn(
      `[LOUDNESS] the recording (${recording.type || 'no type'}) could not be decoded - the voice note is sent unmeasured:`,
      e
    );
    return null;
  }
}
