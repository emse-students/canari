/**
 * WHAT THE LINK DELIVERS, MEASURED FROM THE RANGED MEDIA READS THEMSELVES (slow-link chantier,
 * gap 6, #3333): each read reports its bytes and the seconds from the moment the request gate
 * GRANTED its slot to its last byte (`httpRangeSource`), so the time spent queued is never counted
 * as the link's.
 *
 * Two readers of the SAME samples: a segmented stream keeps its own meter (its hold compares the
 * link to ITS media), and every sample also lands in {@link sessionLinkRate}, which the reel
 * viewer's look-ahead reads to decide how many pages it fetches ahead (`reels/reelAhead.ts`).
 * There is one measure, never a second probe.
 */

/** Weight of the newest read in the smoothed rate. */
export const RATE_SMOOTHING = 0.5;

/** A read shorter than this says nothing about the link (a short closing segment, a tiny file). */
export const MIN_MEASURED_BYTES = 64 * 1024;

/** A smoothed bytes-per-second over the reads it was told about. */
export class LinkRateMeter {
  #rate: number | null = null;

  /** One answered read: `bytes` in `seconds` (slot granted to last byte). */
  observe(bytes: number, seconds: number): void {
    if (bytes < MIN_MEASURED_BYTES || seconds <= 0) return;
    const sample = bytes / seconds;
    this.#rate =
      this.#rate === null ? sample : RATE_SMOOTHING * sample + (1 - RATE_SMOOTHING) * this.#rate;
  }

  /** The smoothed rate, bytes per second - `null` before a read has been measured. */
  get bytesPerSecond(): number | null {
    return this.#rate;
  }

  /** Test seam: forgets every sample. */
  reset(): void {
    this.#rate = null;
  }
}

/** Every ranged media read of the session, whoever made it. */
export const sessionLinkRate = new LinkRateMeter();
