/**
 * MINESWEEPER MOVE TIMINGS (owner, 2026-11-17): every dig and flag carries the moment it was made, and
 * the log must end where the game did.
 *
 * What these cases are built to catch: a log whose clock does not start at the first dig, one that
 * runs backwards, and one whose last move is not the claimed game length - each of which is no record
 * of one play of one game, and would make the replay a moderator watches meaningless.
 */
import { timingsFault, type TimedMove } from './minesweeper.timings';

const at = (...times: number[]): TimedMove[] =>
  times.map((t, i) => ({ type: i % 2 === 0 ? 'reveal' : 'flag', x: i, y: 0, t }));

describe('timingsFault', () => {
  it('accepts a log that starts at 0, only moves forward and ends at the claimed length', () => {
    expect(timingsFault(at(0, 400, 1_250, 9_000), 9_000)).toBeNull();
  });

  it('accepts two moves in the same millisecond: a double event is not a fault', () => {
    expect(timingsFault(at(0, 500, 500, 900), 900)).toBeNull();
  });

  it('accepts a game of one move: the first dig can be the whole win', () => {
    expect(timingsFault(at(0), 0)).toBeNull();
  });

  it.each([
    ['an empty log', [], 0],
    ['a first move after the clock started', [10, 500, 900], 900],
  ])('refuses %s as timings_start', (_name, times, claimed) => {
    expect(timingsFault(at(...times), claimed)).toBe('timings_start');
  });

  it('refuses a move that precedes the one before it as timings_order', () => {
    expect(timingsFault(at(0, 900, 400, 1_000), 1_000)).toBe('timings_order');
  });

  it.each([
    ['shorter than the game', 5_000],
    ['longer than the game', 9_500],
  ])('refuses a log that ends %s as timings_length', (_name, claimed) => {
    expect(timingsFault(at(0, 400, 9_000), claimed)).toBe('timings_length');
  });
});
