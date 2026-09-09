/**
 * The bar heights a voice message is drawn as.
 *
 * A recording used to render as a play button and a grey progress rail, which says nothing about
 * the thing it represents: two voice notes of the same length looked identical, and the only way to
 * find the sentence you wanted was to play the whole thing. Every messaging app in the reference
 * set draws the amplitude instead, so the shape of the speech - the pauses, the emphasis, where it
 * ends - is legible before a single byte is played.
 *
 * IT COSTS NOTHING EXTRA TO OBTAIN. `VoiceMessagePlayer` already runs `decodeAudioData` on the blob
 * because a `MediaRecorder` webm carries no duration in its header, so the decoded samples are
 * already in hand at the moment the peaks are wanted. Nothing is added to the wire format, nothing
 * is stored, and an old message drawn by a new client gets its waveform with no migration.
 */

/** RMS is used rather than the peak, and the difference is visible on speech. */
const SILENCE = 1e-6;

/**
 * Reduces raw PCM to `bucketCount` heights in 0..1, normalised so the loudest bucket reaches 1.
 *
 * **RMS per bucket, not the peak.** A peak-per-bucket waveform of speech is a solid block: a single
 * sample of a plosive or a click pins its whole bucket to full height, and at 40 buckets over a ten
 * second recording each one holds ~11 000 samples, so nearly every bucket contains one. RMS reads
 * as loudness, which is the thing the reader is actually looking at.
 *
 * **Normalised, and that is a deliberate loss.** After this the bars say nothing about absolute
 * volume - a whisper and a shout produce the same strip. That is the right trade for the job: the
 * strip exists to show WHERE the speech is, and recording levels vary so much between a phone held
 * at the mouth and a laptop across a desk that an absolute scale would leave half of all voice
 * notes as a flat line.
 *
 * @param samples One channel of decoded PCM, as `AudioBuffer.getChannelData` returns it.
 * @param bucketCount How many bars to draw. Fewer than one sample per bucket is not an error - a
 *        very short recording simply repeats what it has rather than drawing gaps.
 * @returns Exactly `bucketCount` values in 0..1, or an empty array when there is nothing to draw.
 */
export function computeWaveformPeaks(samples: ArrayLike<number>, bucketCount: number): number[] {
  if (!Number.isInteger(bucketCount) || bucketCount <= 0) return [];
  if (samples.length === 0) return [];

  const perBucket = samples.length / bucketCount;
  const rms: number[] = new Array<number>(bucketCount);
  let loudest = 0;

  for (let bucket = 0; bucket < bucketCount; bucket++) {
    // Bounds from the FRACTIONAL stride, so the last bucket cannot run past the end and buckets
    // cannot silently drop the remainder - `Math.floor(perBucket)` lost up to a bucket's worth of
    // samples off the tail, which is where a recording's last word lives.
    const from = Math.floor(bucket * perBucket);
    const to = Math.max(from + 1, Math.floor((bucket + 1) * perBucket));
    let sum = 0;
    let count = 0;
    for (let i = from; i < to && i < samples.length; i++) {
      const sample = samples[i];
      sum += sample * sample;
      count++;
    }
    const value = count > 0 ? Math.sqrt(sum / count) : 0;
    rms[bucket] = value;
    if (value > loudest) loudest = value;
  }

  // A recording of pure silence normalises to nothing rather than to a division by zero, and the
  // caller draws its own minimum height - the DATA says there is no sound, which is true.
  if (loudest <= SILENCE) return rms.map(() => 0);
  return rms.map((value) => value / loudest);
}

/**
 * Mixes an `AudioBuffer`'s channels down to one, so a stereo recording is not drawn from its left
 * side alone.
 *
 * Kept separate from {@link computeWaveformPeaks} so the reduction can be tested without a
 * `Web Audio` implementation, which `jsdom` does not have.
 */
export function mixToMono(buffer: {
  numberOfChannels: number;
  length: number;
  getChannelData: (channel: number) => Float32Array;
}): Float32Array {
  if (buffer.numberOfChannels <= 1) return buffer.getChannelData(0);
  const mixed = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < mixed.length; i++) mixed[i] += data[i] / buffer.numberOfChannels;
  }
  return mixed;
}
