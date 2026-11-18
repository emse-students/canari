import type { MinesweeperMove } from './engine/game';

/** One dig or flag with the moment it was made: `t` is ms from the first dig (which is 0). */
export type TimedMove = MinesweeperMove & { t: number };

/** Why a timed move log cannot be the record of the game it claims to be. */
export type TimingsFault = 'timings_start' | 'timings_order' | 'timings_length';

/**
 * Whether the timestamps of a move log describe ONE game of the claimed length.
 *
 * The clock starts at the first dig, so the first move is at 0; time only moves forward, so a move
 * never precedes the one before it; and the log ends with the winning move, so its last timestamp
 * IS the game length the client claims (the client sends exactly that, to the millisecond). A log
 * that fails any of the three was not produced by one play of one game: it is refused, and the
 * fault is named so the rejection can be told from a bad replay.
 *
 * Returns null when the log holds together. Says nothing about whether the pace is humanly
 * possible: that judgement is the moderator's, watching the replay.
 */
export function timingsFault(
  moves: ReadonlyArray<TimedMove>,
  claimedDurationMs: number
): TimingsFault | null {
  if (moves.length === 0 || moves[0].t !== 0) return 'timings_start';
  for (let i = 1; i < moves.length; i++) {
    if (moves[i].t < moves[i - 1].t) return 'timings_order';
  }
  if (moves[moves.length - 1].t !== claimedDurationMs) return 'timings_length';
  return null;
}
