// @vitest-environment happy-dom
/**
 * THE UNRANKED LEVELS (owner, 2026-11-25): Debutant 9x9 / 10, Intermediaire 16x16 / 40 on generator 1
 * (guess-free, simple deductions), Expert the ranked board. Pinned: the specs, that each level's board
 * has its size and mines and is cleared by the solver from the first click (fixed seeds, so the work is
 * reproducible), the picker's cycle, and the stored choice with its default.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHALLENGE,
  LATEST_GENERATOR_VERSION,
  createBoard,
  isSolvableWithoutGuessing,
  revealCell,
} from './game';
import {
  LEVELS,
  LEVEL_SPECS,
  LEVEL_STORAGE_KEY,
  loadMinesweeperLevel,
  nextLevel,
  saveMinesweeperLevel,
} from './levels';

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('LEVEL_SPECS', () => {
  it('plays the two small levels on generator 1 and Expert on the ranked board', () => {
    expect(LEVEL_SPECS.beginner).toEqual({
      config: { width: 9, height: 9, mineCount: 10 },
      generator: 1,
    });
    expect(LEVEL_SPECS.intermediate).toEqual({
      config: { width: 16, height: 16, mineCount: 40 },
      generator: 1,
    });
    expect(LEVEL_SPECS.expert).toEqual({ config: CHALLENGE, generator: LATEST_GENERATOR_VERSION });
  });

  for (const level of ['beginner', 'intermediate'] as const) {
    it(`generates ${level} boards of the right size and mines, guess-free from the first click`, () => {
      const { config, generator } = LEVEL_SPECS[level];
      for (let s = 0; s < 8; s++) {
        const board = createBoard(config, `${level}-fixture-${s}`, generator);
        const x = Math.floor(config.width / 2);
        const y = Math.floor(config.height / 2);
        revealCell(board, x, y);
        expect(board.cells).toHaveLength(config.width * config.height);
        expect(board.cells.filter((c) => c.mine)).toHaveLength(config.mineCount);
        expect(board.status).toBe('playing');
        expect(isSolvableWithoutGuessing(board, y * config.width + x)).toBe(true);
      }
    });
  }
});

describe('the level picker and its stored choice', () => {
  it('cycles easiest first, back to the start after Expert', () => {
    expect(LEVELS.map(nextLevel)).toEqual(['intermediate', 'expert', 'beginner']);
  });

  it('starts a newcomer on Debutant, and keeps Expert for a player who already chose a mode', () => {
    expect(loadMinesweeperLevel()).toBe('beginner');
    localStorage.setItem('canari.minesweeper.unranked', '0');
    expect(loadMinesweeperLevel()).toBe('expert');
  });

  it('reads back what was stored, and logs a value that is not a level', () => {
    saveMinesweeperLevel('intermediate');
    expect(loadMinesweeperLevel()).toBe('intermediate');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem(LEVEL_STORAGE_KEY, 'nightmare');
    expect(loadMinesweeperLevel()).toBe('beginner');
    expect(warn).toHaveBeenCalledOnce();
  });
});
