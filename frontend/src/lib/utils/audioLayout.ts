/**
 * THE CHANNEL LAYOUT A MICROPHONE TRACK CAME BACK WITH, decided from `getSettings().channelCount`.
 *
 * A reel or a live is recorded by `MediaRecorder` with as many channels as the track has. A phone
 * microphone captured WITHOUT voice processing (`REEL_AUDIO_CONSTRAINTS`) can come back as a
 * two-channel track whose second channel is empty, and the recorder then writes a STEREO file with
 * a silent side: the sound plays out of one ear or one speaker only. A one-channel track is played
 * on both sides by every player, so the capture ASKS for one channel (`channelCount: { ideal: 1 }`)
 * and reads back what it got here, once per capture.
 */

/** The layout of a captured audio track. `unknown` when the engine reports no channel count. */
export type AudioLayout = 'mono' | 'stereo' | 'multichannel' | 'unknown';

/** Names the layout for a reported channel count. */
export function audioLayoutOf(channelCount: number | undefined): AudioLayout {
  if (typeof channelCount !== 'number' || !Number.isFinite(channelCount) || channelCount < 1) {
    return 'unknown';
  }
  if (channelCount === 1) return 'mono';
  return channelCount === 2 ? 'stereo' : 'multichannel';
}

/**
 * The ONE info line a capture writes about its audio: the channels asked for against the channels
 * granted. A `stereo` answer to a mono request is the case to read on a bench phone (a track whose
 * second channel may be silent), so it is called out in the line itself.
 */
export function describeAudioLayout(
  tag: string,
  settings: Pick<MediaTrackSettings, 'channelCount' | 'sampleRate'> | undefined
): string {
  const layout = audioLayoutOf(settings?.channelCount);
  const note = layout === 'mono' ? '' : ' - asked for mono, a silent side is possible';
  return (
    `[${tag}] audio layout: ${layout} (ch=${settings?.channelCount ?? '?'}, ` +
    `rate=${settings?.sampleRate ?? '?'}Hz)${note}`
  );
}

/** Logs {@link describeAudioLayout} for the first audio track of `stream`, nothing when it has none. */
export function logCaptureAudioLayout(tag: string, stream: MediaStream): void {
  const track = stream.getAudioTracks?.()[0];
  if (!track) return;
  console.info(describeAudioLayout(tag, track.getSettings?.()));
}
