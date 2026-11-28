import {
  createBoard,
  revealCell,
  toggleFlag,
  type GeneratorVersion,
  type MinesweeperBoard,
  type MinesweeperConfig,
  type MinesweeperMove,
} from './game';

/**
 * One dig or flag with the moment the player made it: `t` is milliseconds from the first dig (which
 * is 0). The client records it, the server checks that the log ends where the game did and keeps it
 * with the score, and a moderator's replay plays it back (docs/wiki/frontend/modules/minesweeper.md,
 * "The replay").
 */
export type TimedMove = MinesweeperMove & { t: number };

/** What a moderator's replay needs to rebuild a game: the board's recipe and the timed moves. */
export interface ReplaySource {
  seed: string;
  generatorVersion: GeneratorVersion;
  config: MinesweeperConfig;
  moves: ReadonlyArray<TimedMove>;
}

/** A game that can be shown at any move, forwards or backwards. */
export interface Replay {
  readonly moveCount: number;
  /**
   * The board after the first `count` moves (0 is the untouched board). The SAME object is returned
   * and advanced by later calls: read it, never keep it.
   */
  boardAfter(count: number): MinesweeperBoard;
  /** How many moves were made at or before `ms` into the game. */
  movesAt(ms: number): number;
}

/** A copy of a board whose mines are already placed: the rng is only used by generation. */
function cloneBoard(board: MinesweeperBoard): MinesweeperBoard {
  return { ...board, cells: board.cells.map((cell) => ({ ...cell })), rng: null };
}

/**
 * Builds the replay of a game. THE BOARD IS REGENERATED, never stored: the same `(seed, generator,
 * first dig)` the server replayed. Generation is the expensive part (it runs when the first move is
 * applied), so the board right after it is kept, and going backwards restarts from that copy and
 * replays the few moves between - not from a new generation.
 */
export function createReplay(source: ReplaySource): Replay {
  const { moves } = source;
  const blank = () => createBoard(source.config, source.seed, source.generatorVersion);
  let current = blank();
  let applied = 0;
  /** The board right after the first move, once generated. */
  let afterFirst: MinesweeperBoard | null = null;

  function apply(move: TimedMove): void {
    if (move.type === 'reveal') revealCell(current, move.x, move.y);
    else toggleFlag(current, move.x, move.y);
  }

  return {
    moveCount: moves.length,

    boardAfter(count: number): MinesweeperBoard {
      const target = Math.min(Math.max(Math.trunc(count), 0), moves.length);
      if (target < applied) {
        // Backwards: restart from the cheapest copy, never regenerate.
        current = target >= 1 && afterFirst ? cloneBoard(afterFirst) : blank();
        applied = target >= 1 && afterFirst ? 1 : 0;
      }
      while (applied < target) {
        apply(moves[applied]);
        applied++;
        if (applied === 1) afterFirst = cloneBoard(current);
      }
      return current;
    },

    movesAt(ms: number): number {
      // The last index whose time is not after `ms`: times never decrease, so a binary search.
      let low = 0;
      let high = moves.length;
      while (low < high) {
        const mid = (low + high) >> 1;
        if (moves[mid].t <= ms) low = mid + 1;
        else high = mid;
      }
      return low;
    },
  };
}

/**
 * The smallest and largest cell, in CSS px, a replay draws. THE MINIMUM IS A FLOOR, NOT A TARGET: it
 * was 14 and a 18 x 32 board on an iPhone 12 (a stage of ~476 pt under the chrome) needs 13, so the
 * clamp drew 14 and cut the last row (read 2026-11-27, 1.8.3-alpha.1). The glyphs scale with the cell
 * ({@link replayGlyphSizes}) so a small cell stays readable; only a stage smaller than the floor allows
 * (a window of a few hundred px) still scrolls.
 */
export const REPLAY_CELL_MIN_PX = 8;
export const REPLAY_CELL_MAX_PX = 44;

/**
 * The cell size, in whole CSS px, at which a `cols` x `rows` board fits the space it is given - so the
 * WHOLE grid is on screen at once, as large as the screen allows, instead of a fixed size that scrolls
 * on a phone. `gapPx` is the space between two cells. Clamped to a readable range.
 */
export function fitCellSize(
  widthPx: number,
  heightPx: number,
  cols: number,
  rows: number,
  gapPx = 1
): number {
  if (cols <= 0 || rows <= 0) return REPLAY_CELL_MIN_PX;
  const byWidth = (widthPx - gapPx * (cols - 1)) / cols;
  const byHeight = (heightPx - gapPx * (rows - 1)) / rows;
  const fit = Math.floor(Math.min(byWidth, byHeight));
  return Math.min(Math.max(fit, REPLAY_CELL_MIN_PX), REPLAY_CELL_MAX_PX);
}

/**
 * The digit and the flag/mine icon sizes, in CSS px, a cell of `cellPx` draws: the game's own 12 px
 * digit and 14 px icon at their full size, scaled down with a cell too small to hold them, so a fitted
 * replay stays readable down to {@link REPLAY_CELL_MIN_PX}.
 */
export function replayGlyphSizes(cellPx: number): { digitPx: number; iconPx: number } {
  return {
    digitPx: Math.min(12, Math.floor(cellPx * 0.7)),
    iconPx: Math.min(14, Math.floor(cellPx * 0.8)),
  };
}
