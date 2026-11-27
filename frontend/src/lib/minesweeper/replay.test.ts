/**
 * THE MODERATOR'S REPLAY (owner, 2026-11-17): a won game is played back from its seed and its timed
 * moves. Pinned: the board the replay shows after n moves is the one the server replayed, going
 * backwards reaches the same state as going forwards WITHOUT generating the board again, and the
 * clock maps to the move count the way the scrubber needs.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { CHALLENGE, createBoard, revealCell, type MinesweeperBoard } from './game';
import {
  createReplay,
  fitCellSize,
  replayGlyphSizes,
  REPLAY_CELL_MAX_PX,
  REPLAY_CELL_MIN_PX,
  type ReplaySource,
  type TimedMove,
} from './replay';

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

describe('replayGlyphSizes', () => {
  it('keeps the full glyph sizes in a cell that holds them and scales them down in one that does not', () => {
    expect(replayGlyphSizes(44)).toEqual({ digitPx: 12, iconPx: 14 });
    const small = replayGlyphSizes(13);
    expect(small.digitPx).toBeLessThanOrEqual(13);
    expect(small.iconPx).toBeLessThanOrEqual(13);
    expect(replayGlyphSizes(REPLAY_CELL_MIN_PX).digitPx).toBeGreaterThan(0);
  });
});

describe('fitCellSize', () => {
  it('fits the whole board on a phone, limited by whichever side runs out first', () => {
    // 18 x 32 in 374 x 600: width allows 20 (374 - 17 gaps = 357 / 18 = 19.8), height 18 (600 - 31 = 569 / 32 = 17.8).
    expect(fitCellSize(374, 600, 18, 32)).toBe(17);
    // A wide, short area is limited by its height (800 - 31 gaps = 769 / 32 = 24); a tall, narrow one by its width.
    expect(fitCellSize(2000, 800, 18, 32)).toBe(24);
    expect(fitCellSize(300, 2000, 18, 32)).toBe(15);
  });

  it('never draws a cell larger than the readable maximum, however much room there is', () => {
    expect(fitCellSize(4000, 4000, 18, 32)).toBe(REPLAY_CELL_MAX_PX);
  });

  it('never draws one smaller than the minimum, even in a space too small to hold the board', () => {
    expect(fitCellSize(50, 50, 18, 32)).toBe(REPLAY_CELL_MIN_PX);
    expect(fitCellSize(100, 100, 0, 0)).toBe(REPLAY_CELL_MIN_PX);
  });

  it('fits the whole 18 x 32 board on an iPhone 12 stage, the last row included (read 2026-11-27)', () => {
    // Measured: a stage ~476 pt tall and 390 wide, 16 of it padding. The old floor of 14 drew a grid
    // of 479 pt in a 460 pt room.
    const size = fitCellSize(390 - 16, 476 - 16, 18, 32, 1);
    expect(size * 32 + 31).toBeLessThanOrEqual(476 - 16);
    expect(size * 18 + 17).toBeLessThanOrEqual(390 - 16);
    expect(size).toBe(13);
  });

  it('fits every board and room a floor-sized cell can hold, whole', () => {
    // Every room here holds the floor-sized grid, so each MUST fit whole.
    for (const [w, h, cols, rows] of [
      [374, 440, 18, 32],
      [300, 400, 18, 32],
      [374, 640, 9, 9],
      [250, 300, 18, 32],
    ] as const) {
      expect(REPLAY_CELL_MIN_PX * rows + (rows - 1)).toBeLessThanOrEqual(h);
      expect(REPLAY_CELL_MIN_PX * cols + (cols - 1)).toBeLessThanOrEqual(w);
      const size = fitCellSize(w, h, cols, rows, 1);
      expect(size * rows + (rows - 1)).toBeLessThanOrEqual(h);
      expect(size * cols + (cols - 1)).toBeLessThanOrEqual(w);
    }
  });

  it('counts the gaps between cells, so the grid is never wider than its space', () => {
    const size = fitCellSize(400, 4000, 10, 10, 2);
    expect(size * 10 + 2 * 9).toBeLessThanOrEqual(400);
  });
});
