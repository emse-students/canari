/**
 * THE MODERATOR'S REPLAY (owner, 2026-11-17): a won game is played back from its seed and its timed
 * moves. Pinned: the board the replay shows after n moves is the one the server replayed, going
 * backwards reaches the same state as going forwards WITHOUT generating the board again, and the
 * clock maps to the move count the way the scrubber needs.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { CHALLENGE, createBoard, revealCell, type MinesweeperBoard } from './game';
import { createReplay, type ReplaySource, type TimedMove } from './replay';

const seed = '8601e326fcef5ef936a1c69d6ab6ac41';
const [x, y] = [9, 16];

/** A winning log of generator 2's board: the first click, then every other safe cell, 40 ms apart. */
function winningMoves(): TimedMove[] {
  const board = createBoard(CHALLENGE, seed, 2);
  revealCell(board, x, y);
  const moves: TimedMove[] = [{ type: 'reveal', x, y, t: 0 }];
  board.cells.forEach((cell, i) => {
    if (!cell.mine) {
      moves.push({
        type: 'reveal',
        x: i % board.width,
        y: Math.floor(i / board.width),
        t: moves.length * 40,
      });
    }
  });
  return moves;
}

/** Everything a player can see of a board, comparable across two boards. */
const look = (b: MinesweeperBoard) => ({
  status: b.status,
  revealed: b.revealedCount,
  flags: b.flagCount,
  cells: b.cells.map((c) => `${c.state}:${c.mine ? 'm' : c.adjacent}`).join(','),
});

let source: ReplaySource;
beforeAll(() => {
  source = { seed, generatorVersion: 2, config: CHALLENGE, moves: winningMoves() };
}, 60_000);

describe('createReplay', () => {
  it('starts from an untouched board and ends on the win', () => {
    const replay = createReplay(source);
    expect(replay.moveCount).toBe(source.moves.length);
    expect(replay.boardAfter(0).minesPlaced).toBe(false);
    expect(replay.boardAfter(replay.moveCount).status).toBe('won');
  }, 60_000);

  it('shows after n moves what a straight play of n moves shows', () => {
    const replay = createReplay(source);
    const straight = createBoard(CHALLENGE, seed, 2);
    const checkpoints = new Set([1, 2, 5, 40]);
    source.moves.slice(0, 40).forEach((m, i) => {
      revealCell(straight, m.x, m.y);
      if (checkpoints.has(i + 1)) expect(look(replay.boardAfter(i + 1))).toEqual(look(straight));
    });
  }, 60_000);

  it('reaches the same state going backwards as going forwards, without generating again', () => {
    const replay = createReplay(source);
    const forward = look(replay.boardAfter(25));
    const report = replay.boardAfter(25).generationReport;
    replay.boardAfter(replay.moveCount);
    const back = replay.boardAfter(25);
    expect(look(back)).toEqual(forward);
    // The same report object: a regenerated board would carry a new one.
    expect(back.generationReport).toBe(report);
    expect(replay.boardAfter(0).minesPlaced).toBe(false);
    expect(look(replay.boardAfter(25))).toEqual(forward);
  }, 60_000);

  it('plays a flag as a flag, and a second flag as taking it off', () => {
    const flagged: ReplaySource = {
      ...source,
      moves: [
        source.moves[0],
        { type: 'flag', x: 0, y: 0, t: 100 },
        { type: 'flag', x: 0, y: 0, t: 200 },
      ],
    };
    const replay = createReplay(flagged);
    expect(replay.boardAfter(2).cells[0].state).toBe('flagged');
    expect(replay.boardAfter(3).cells[0].state).toBe('hidden');
  }, 60_000);

  it('clamps a count outside the log instead of running off it', () => {
    const replay = createReplay(source);
    expect(replay.boardAfter(-4).minesPlaced).toBe(false);
    expect(replay.boardAfter(10 ** 9).status).toBe('won');
  }, 60_000);
});

describe('movesAt', () => {
  const replay = () =>
    createReplay({
      ...source,
      moves: [0, 300, 300, 900].map((t, i) => ({ type: 'reveal', x: i, y: 0, t })),
    });

  it.each([
    [-1, 0],
    [0, 1],
    [299, 1],
    [300, 3],
    [899, 3],
    [900, 4],
    [10_000, 4],
  ])('at %i ms, %i moves have been made', (ms, count) => {
    expect(replay().movesAt(ms)).toBe(count);
  });
});
