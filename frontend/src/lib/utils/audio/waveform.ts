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
  const rms: number[] = Array.from({ length: bucketCount }, () => 0);
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

/** A bar and the space after it, in CSS pixels. 3px of bar reads as a waveform; 8px reads as a pill. */
export const BAR_PITCH_PX = 5;
/** Below this the strip is not a waveform any more, it is decoration. */
const MIN_BARS = 8;
/** Above this the bars are thinner than a hairline and the extra detail is invisible. */
const MAX_BARS = 64;

/**
 * How many bars fit in `stripWidth`.
 *
 * THE COUNT IS DERIVED FROM THE WIDTH, AND A FIXED COUNT WAS MEASURABLY WRONG AT BOTH ENDS. The
 * first version drew 40 bars whatever the space, and on 2026-09-09, rendered against the app's own
 * compiled stylesheet:
 *
 * - in a 520px bubble the bars came out **7.6px wide**, so the strip read as a row of fat pills,
 *   and the resting state - every bar at its floor - read as a dotted line rather than a thin one;
 *   and
 * - in the narrowest bubble the component allows (`min-w-[200px]`) the strip got 62px, the bars hit
 *   their 2px minimum, and the last one landed **31px outside the panel**. Forty bars at 2px with
 *   2px gaps have a 158px hard floor, so any thread narrower than that overflowed - which on a
 *   360px phone is an ordinary bubble, not an edge case.
 *
 * Deriving it keeps the bar the width it should be at every size and makes the overflow
 * unrepresentable, at the cost of a shorter recording being drawn with fewer bars in a narrow
 * bubble than in a wide one. That is a real loss and it is the smaller one: the same width always
 * gives the same count, so nothing is non-deterministic - the drawing simply has the resolution the
 * space affords.
 */
export function barCountForWidth(stripWidth: number): number {
  if (!Number.isFinite(stripWidth) || stripWidth <= 0) return MIN_BARS;
  return Math.min(MAX_BARS, Math.max(MIN_BARS, Math.floor(stripWidth / BAR_PITCH_PX)));
}

/**
 * Reduces a peak array to `count` bars.
 *
 * **The MAX over each slice, not the mean.** The peaks are already an RMS reduction of the samples;
 * averaging them a second time at a low bar count flattens the silhouette until a quiet passage and
 * a loud one look alike, which is the one thing the strip exists to distinguish. Taking the loudest
 * of the peaks in a slice keeps the shape and only loses detail inside it.
 *
 * Separate from {@link computeWaveformPeaks} so the expensive reduction runs ONCE per recording and
 * this cheap one runs on every resize.
 */
export function resampleBars(peaks: readonly number[], count: number): number[] {
  if (!Number.isInteger(count) || count <= 0) return [];
  if (peaks.length === 0) return [];
  if (peaks.length === count) return [...peaks];

  const perBar = peaks.length / count;
  return Array.from({ length: count }, (_, bar) => {
    const from = Math.floor(bar * perBar);
    const to = Math.max(from + 1, Math.floor((bar + 1) * perBar));
    let loudest = 0;
    for (let i = from; i < to && i < peaks.length; i++) {
      if (peaks[i] > loudest) loudest = peaks[i];
    }
    return loudest;
  });
}
