/**
 * THE LIVE VIEWER'S BUFFER POLICY: how far behind its newest buffered media the player sits, and
 * what a `waiting` from the `<video>` means. Pure - no timer, no DOM: the caller reads its monotonic
 * clock and hands the reading in, so the policy is tested with numbers alone.
 *
 * WHY IT EXISTS (L-F1, read on dev 2026-10-26, docs/wiki/frontend/modules/live.md "The buffer
 * policy"). Two defects made a viewer freeze every ~4 s behind an Android broadcaster:
 *
 * 1. The target was a constant (one segment, 2 s), but the Mi 9T's recorder hands its 2 s fragments
 *    over IN PAIRS every 4 s (seals 4-15 ms apart, on every chunk of the reading). A viewer 2 s behind
 *    a source that delivers every 4 s runs dry for ~2 s per period, whatever the network.
 * 2. The player's own seek fires `waiting` (the engine drops its ready state while it seeks), and
 *    that was read as a stall: `stalled at 7.99` logged in the SAME millisecond as `seek ... at 9.99`
 *    (exactly end - 2 s). The latched stall made the next delivery seek again, whose `waiting` latched
 *    again - a seek at every delivery, for as long as the live lasted.
 *
 * THE POLICY. The target is the longest wall-clock gap between two deliveries the viewer has seen
 * (the last {@link LIVE_PLAYER_CADENCE_WINDOW} of them), never below
 * {@link LIVE_PLAYER_MIN_TARGET_BUFFER_MS}: the buffer must outlast the longest wait for the next
 * media, and that wait is the producer's cadence as THIS viewer receives it (pairs, poll, fetch).
 * A gap longer than any seen costs at most one stall - the stall IS the measurement - and the
 * re-anchor that follows uses the grown target. A gap that is an outage, not a cadence (a catch-up
 * jump, a retried poll, a quiet broadcaster) is never recorded: {@link LiveBufferPolicy.interrupt}.
 */

import {
  LIVE_PLAYER_CADENCE_WINDOW,
  LIVE_PLAYER_DRIFT_SLACK_MS,
  LIVE_PLAYER_MIN_TARGET_BUFFER_MS,
} from './constants';

/** The `buffered` ranges of a source buffer, as MSE gives them. */
export interface LiveTimeRanges {
  readonly length: number;
  start(index: number): number;
  end(index: number): number;
}

/**
 * What a `waiting` of the `<video>` means, decided once from facts the engine holds:
 * - `seeking`: the engine is completing a seek (`video.seeking`) - its own wait, NOT a stall;
 * - `time-gap`: media is buffered past a hole ahead (a camera re-acquired, its timestamps moved
 *   forward) - no engine plays across it, so the player seeks to `to`;
 * - `starved`: nothing playable ahead - the next delivery came later than the buffer lasted.
 */
export type LiveWait = { kind: 'seeking' } | { kind: 'time-gap'; to: number } | { kind: 'starved' };

/** How much media must lie ahead, in seconds, before a wait at a range's end is read as a hole. */
const GAP_AHEAD_S = 0.5;

/** Classifies a `waiting` - see {@link LiveWait}. */
export function classifyLiveWait(
  seeking: boolean,
  position: number,
  ranges: LiveTimeRanges | null
): LiveWait {
  if (seeking) return { kind: 'seeking' };
  if (ranges && ranges.length > 0) {
    const last = ranges.length - 1;
    const start = ranges.start(last);
    if (ranges.end(last) > position + GAP_AHEAD_S && start > position) {
      return { kind: 'time-gap', to: start };
    }
  }
  return { kind: 'starved' };
}

/** Why the next delivery's gap must not be read as the producer's cadence. */
export type LiveCadenceBreak =
  /** The viewer jumped to the newest segment: the gap was a backlog, not a cadence. */
  | 'catch-up'
  /** A step failed and is retried: the gap is the viewer's own outage. */
  | 'retry'
  /** The server says the broadcaster stored nothing for a while: its absence, not its cadence. */
  | 'broadcaster-quiet';

/** What one delivery did to the policy. */
export interface LiveDelivery {
  /** The wall-clock gap since the previous delivery, in ms; null when none is to be measured. */
  gapMs: number | null;
  /** The target after this delivery, in ms. */
  targetMs: number;
  /** Whether this delivery raised the target. */
  grew: boolean;
}

/** One per run of a viewer: reset at every (re)start. */
export class LiveBufferPolicy {
  private readonly gaps: number[] = [];
  private lastDeliveryAt: number | null = null;

  constructor(
    private readonly window: number = LIVE_PLAYER_CADENCE_WINDOW,
    private readonly floorMs: number = LIVE_PLAYER_MIN_TARGET_BUFFER_MS
  ) {
    if (!Number.isInteger(window) || window < 1) {
      throw new RangeError(`live buffer policy: window ${window} is not a positive integer`);
    }
  }

  /** How far behind the newest buffered media the player aims to sit, in ms. */
  get targetMs(): number {
    return this.gaps.reduce((a, b) => Math.max(a, b), this.floorMs);
  }

  /** Past this many ms behind the newest buffered media, the player seeks back to the target. */
  get maxBehindMs(): number {
    return this.targetMs + LIVE_PLAYER_DRIFT_SLACK_MS;
  }

  /**
   * Media was appended at `nowMs` (the caller's monotonic clock). The first delivery after a reset
   * or an {@link interrupt} only anchors the next measurement.
   */
  delivered(nowMs: number): LiveDelivery {
    const before = this.targetMs;
    const previous = this.lastDeliveryAt;
    this.lastDeliveryAt = nowMs;
    if (previous === null) return { gapMs: null, targetMs: before, grew: false };
    const gap = Math.max(0, nowMs - previous);
    this.gaps.push(gap);
    if (this.gaps.length > this.window) this.gaps.shift();
    const after = this.targetMs;
    return { gapMs: gap, targetMs: after, grew: after > before };
  }

  /** The gap running now is not a cadence ({@link LiveCadenceBreak}): it will not be recorded. */
  interrupt(_why: LiveCadenceBreak): void {
    this.lastDeliveryAt = null;
  }

  /** Forgets every gap: a new run measures its own producer. */
  reset(): void {
    this.gaps.length = 0;
    this.lastDeliveryAt = null;
  }
}
