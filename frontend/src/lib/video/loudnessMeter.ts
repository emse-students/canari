/**
 * THE INTEGRATED LOUDNESS OF A VIDEO'S SOUND, MEASURED ON THE AUTHOR'S DEVICE (owner, 2026-11-11:
 * *some videos are loud, others very quiet* - measure at send, apply at playback, like YouTube and
 * Spotify).
 *
 * The server holds ciphertext and can measure nothing, so the device that prepares the video
 * (`prepareVideoForUpload`) runs this meter over the decoded samples and the result travels in the
 * media's encrypted metadata (`MediaRef.loudness`). The file itself is never altered: a player
 * applies the gain (`loudnessPlayback.ts`).
 *
 * THE ALGORITHM IS ITU-R BS.1770-4 / EBU R128, no variant:
 *
 * - K-weighting: a high shelf (+4 dB above ~1.7 kHz, the head's effect) then a high-pass (~38 Hz),
 *   two biquads whose coefficients are DERIVED for the stream's sample rate (libebur128's method,
 *   which reproduces the standard's 48 kHz table exactly);
 * - 400 ms blocks overlapping by 75 % (a 100 ms hop), each block's loudness
 *   `-0.691 + 10 log10(sum_c G_c * meanSquare_c)`, with G = 1 for L, R, C and 1.41 for the
 *   surrounds, the LFE left out;
 * - an ABSOLUTE gate at -70 LUFS, then a RELATIVE gate 10 LU under the loudness of the blocks the
 *   first gate kept; the integrated loudness is that of the blocks both gates kept.
 *
 * Silence (no block over -70 LUFS) has NO loudness: the result is `null`, never a number a player
 * would read as "very quiet, raise it".
 *
 * The SAMPLE peak rides along (the largest absolute sample, before the filter): it costs one
 * comparison a sample, and it is what lets a player raise a quiet video without clipping. A TRUE
 * peak (4x oversampled) would cost a resampler per channel; the player keeps 1 dB of headroom under
 * the sample peak instead (`loudnessPlayback.ts`).
 */

/** What the author's device measured, in the media's encrypted metadata (`MediaRef.loudness`). */
export interface MediaLoudness {
  /** The programme's integrated loudness, LUFS (BS.1770-4, gated). Always below 0 in practice. */
  integratedLufs: number;
  /** The largest absolute decoded sample, dBFS (0 = full scale; a decoder may overshoot past 0). */
  samplePeakDbfs: number;
}

/** BS.1770's absolute gate. */
export const ABSOLUTE_GATE_LUFS = -70;
/** BS.1770's relative gate, under the absolute-gated loudness. */
export const RELATIVE_GATE_LU = -10;
/** A gating block's length. */
const BLOCK_SECONDS = 0.4;
/** The hop between blocks (75 % overlap): a block is FOUR consecutive hops. */
const HOP_SECONDS = 0.1;
const HOPS_PER_BLOCK = Math.round(BLOCK_SECONDS / HOP_SECONDS);

/** One biquad's coefficients, normalised so a0 = 1. */
interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/**
 * The two K-weighting stages for `sampleRate`, derived as libebur128 derives them: from the analog
 * prototype's corner, gain and Q through the bilinear transform. At 48 kHz this is the standard's own
 * table (stage 1: b = 1.53512485958697, -2.69169618940638, 1.19839281085285; a = -1.69065929318241,
 * 0.73248077421585; stage 2: b = 1, -2, 1; a = -1.99004745483398, 0.99007225036621).
 */
export function kWeightingFilters(sampleRate: number): [Biquad, Biquad] {
  // Stage 1, the head's high shelf.
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / sampleRate);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf: Biquad = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  // Stage 2, the RLB high-pass.
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / sampleRate);
  a0 = 1 + K / Q + K * K;
  const highPass: Biquad = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  return [shelf, highPass];
}

/**
 * Each channel's weight G_c. Mono and stereo weigh 1 per channel; a 5.1 stream in its usual order
 * (L, R, C, LFE, Ls, Rs) leaves the LFE out and weighs the surrounds 1.41. Any other count weighs
 * every channel 1 - a phone records mono or stereo.
 */
export function channelWeights(channelCount: number): number[] {
  if (channelCount === 6) return [1, 1, 1, 0, 1.41, 1.41];
  return Array.from({ length: channelCount }, () => 1);
}

/**
 * A streaming BS.1770 meter: push planar float samples as they are decoded, read the result once.
 * Memory is one number per 100 ms hop (900 for a 90 s reel), never the samples.
 */
export class LoudnessMeter {
  readonly sampleRate: number;
  readonly channelCount: number;
  readonly #hopFrames: number;
  readonly #weights: number[];
  readonly #shelf: Biquad;
  readonly #highPass: Biquad;
  /** Per channel: the shelf's and the high-pass's two state words (direct form II transposed). */
  readonly #state: Float64Array;
  /** Per channel: the sum of squares of the K-weighted samples in the hop being filled. */
  readonly #hopSums: Float64Array;
  #hopFill = 0;
  /** Each completed hop's weighted sum of squares, `sum_c G_c * sum(x^2)`. */
  readonly #hops: number[] = [];
  #peak = 0;

  constructor(sampleRate: number, channelCount: number) {
    if (!(sampleRate > 0) || !(channelCount > 0)) {
      throw new RangeError(`loudness meter: ${sampleRate} Hz, ${channelCount} channel(s)`);
    }
    this.sampleRate = sampleRate;
    this.channelCount = channelCount;
    this.#hopFrames = Math.round(sampleRate * HOP_SECONDS);
    this.#weights = channelWeights(channelCount);
    [this.#shelf, this.#highPass] = kWeightingFilters(sampleRate);
    this.#state = new Float64Array(channelCount * 4);
    this.#hopSums = new Float64Array(channelCount);
  }

  /**
   * Feeds `frames` frames, one `Float32Array` per channel (planar), each holding at least `frames`
   * samples. Hops complete as they fill; a hop is never split across calls' semantics.
   */
  push(planes: readonly Float32Array[], frames: number): void {
    if (planes.length !== this.channelCount) {
      throw new RangeError(
        `loudness meter: ${planes.length} plane(s) for ${this.channelCount} channel(s)`
      );
    }
    const s1 = this.#shelf;
    const s2 = this.#highPass;
    let done = 0;
    while (done < frames) {
      const take = Math.min(frames - done, this.#hopFrames - this.#hopFill);
      for (let c = 0; c < this.channelCount; c++) {
        const x = planes[c];
        const st = c * 4;
        let z1 = this.#state[st];
        let z2 = this.#state[st + 1];
        let w1 = this.#state[st + 2];
        let w2 = this.#state[st + 3];
        let sum = 0;
        let peak = this.#peak;
        for (let i = done; i < done + take; i++) {
          const v = x[i];
          const a = v < 0 ? -v : v;
          if (a > peak) peak = a;
          // Stage 1 (shelf), then stage 2 (high-pass), direct form II transposed.
          const y1 = s1.b0 * v + z1;
          z1 = s1.b1 * v - s1.a1 * y1 + z2;
          z2 = s1.b2 * v - s1.a2 * y1;
          const y2 = s2.b0 * y1 + w1;
          w1 = s2.b1 * y1 - s2.a1 * y2 + w2;
          w2 = s2.b2 * y1 - s2.a2 * y2;
          sum += y2 * y2;
        }
        this.#peak = peak;
        this.#state[st] = z1;
        this.#state[st + 1] = z2;
        this.#state[st + 2] = w1;
        this.#state[st + 3] = w2;
        this.#hopSums[c] += sum;
      }
      done += take;
      this.#hopFill += take;
      if (this.#hopFill === this.#hopFrames) {
        let weighted = 0;
        for (let c = 0; c < this.channelCount; c++) {
          weighted += this.#weights[c] * this.#hopSums[c];
          this.#hopSums[c] = 0;
        }
        this.#hops.push(weighted);
        this.#hopFill = 0;
      }
    }
  }

  /**
   * The integrated loudness and sample peak of everything pushed, or `null` when nothing is left
   * after the gates: silence, or less than one 400 ms block. A partial last hop is not a block and
   * is left out, as the standard leaves it.
   */
  result(): MediaLoudness | null {
    const blockFrames = this.#hopFrames * HOPS_PER_BLOCK;
    const blocks: number[] = [];
    for (let j = 0; j + HOPS_PER_BLOCK <= this.#hops.length; j++) {
      let sum = 0;
      for (let k = 0; k < HOPS_PER_BLOCK; k++) sum += this.#hops[j + k];
      blocks.push(sum / blockFrames);
    }
    const absolute = blocks.filter((z) => blockLoudness(z) > ABSOLUTE_GATE_LUFS);
    if (absolute.length === 0) return null;
    const relativeGate = blockLoudness(mean(absolute)) + RELATIVE_GATE_LU;
    const kept = absolute.filter((z) => blockLoudness(z) > relativeGate);
    if (kept.length === 0) return null;
    return {
      integratedLufs: blockLoudness(mean(kept)),
      samplePeakDbfs: this.#peak > 0 ? 20 * Math.log10(this.#peak) : -Infinity,
    };
  }
}

/** A block's (or a set's mean) loudness from its weighted mean square. */
function blockLoudness(weightedMeanSquare: number): number {
  return weightedMeanSquare > 0 ? -0.691 + 10 * Math.log10(weightedMeanSquare) : -Infinity;
}

function mean(values: number[]): number {
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** The loudest a real programme measures: a full-scale signal sits near 0 LUFS. */
export const MAX_PLAUSIBLE_LUFS = 0;

/**
 * How far UNDER its loudness a sample peak may sit. A peak is never below the signal's RMS, and
 * K-weighting adds at most a few dB; a measurement whose peak is lower than this is not one a signal
 * makes - a crafted entry claiming a very loud, very low-peaked video to be muted by the gain.
 */
export const MAX_PEAK_BELOW_LOUDNESS_DB = 3;

/**
 * Whether `value` is a measurement a reader may apply: two finite numbers in the ranges a real
 * signal gives - a loudness between the absolute gate and {@link MAX_PLAUSIBLE_LUFS}, and a peak not
 * more than {@link MAX_PEAK_BELOW_LOUDNESS_DB} under it. The values come from ANOTHER device, so a
 * crafted one must not be able to silence a video: what fails this plays as it is - the metadata is
 * decoration, never a reason to refuse a video.
 */
export function isMediaLoudness(value: unknown): value is MediaLoudness {
  if (typeof value !== 'object' || value === null) return false;
  const { integratedLufs, samplePeakDbfs } = value as Record<string, unknown>;
  return (
    typeof integratedLufs === 'number' &&
    Number.isFinite(integratedLufs) &&
    integratedLufs > ABSOLUTE_GATE_LUFS &&
    integratedLufs <= MAX_PLAUSIBLE_LUFS &&
    typeof samplePeakDbfs === 'number' &&
    Number.isFinite(samplePeakDbfs) &&
    samplePeakDbfs < 30 &&
    samplePeakDbfs >= integratedLufs - MAX_PEAK_BELOW_LOUDNESS_DB
  );
}
