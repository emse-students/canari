// @vitest-environment happy-dom
/**
 * THE UNRANKED LEVELS (owner, 2026-11-25), BY GENERATION AND NOT BY SIZE: every level plays the ranked
 * board's size on generator 2 and differs only by the reasoning score the generator climbs to; Expert IS
 * the ranked board. Pinned: the specs, that each level's board has the ranked size and mines and names
 * its own target (fixed seeds, so the work is reproducible), that a higher level really is a harder
 * board, the picker's cycle, and the stored choice with its default.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHALLENGE,
  LATEST_GENERATOR_VERSION,
  V2_TARGET_SCORE,
  createBoard,
  revealCell,
} from './game';
import {
  LEVELS,
  LEVEL_SPECS,
  LEVEL_STORAGE_KEY,
  hasStoredMinesweeperMode,
  loadMinesweeperLevel,
  PLAY_MODES,
  loadMinesweeperUnranked,
  playModeOf,
  saveMinesweeperUnranked,
  saveMinesweeperLevel,
} from './levels';

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('LEVEL_SPECS', () => {
  it('plays every level on the ranked size and generator, and Expert on the ranked target', () => {
    for (const level of LEVELS) {
      expect(LEVEL_SPECS[level].config).toEqual(CHALLENGE);
      expect(LEVEL_SPECS[level].generator).toBe(LATEST_GENERATOR_VERSION);
    }
    expect(LEVEL_SPECS.expert.targetScore).toBe(V2_TARGET_SCORE);
  });

  it('asks a higher level for a higher target, easiest first', () => {
    const targets = LEVELS.map((level) => LEVEL_SPECS[level].targetScore);
    expect(targets).toEqual([...targets].sort((a, b) => a - b));
    expect(new Set(targets).size).toBe(LEVELS.length);
  });

  it('generates boards of the ranked size and mines, each naming its level target, harder upward', () => {
    const mean: Record<string, number> = {};
    for (const level of LEVELS) {
      const { config, generator, targetScore } = LEVEL_SPECS[level];
      let total = 0;
      for (let s = 0; s < 3; s++) {
        const board = createBoard(config, `${level}-fixture-${s}`, generator, targetScore);
        revealCell(board, Math.floor(config.width / 2), Math.floor(config.height / 2));
        expect(board.cells.filter((c) => c.mine)).toHaveLength(config.mineCount);
        expect(board.status).toBe('playing');
        const report = board.generationReport!;
        expect(report.targetScore).toBe(targetScore);
        // Guess-free is the generator's contract at every level, not a property of the hard ones.
        expect(report.fellBack).toBe(false);
        total += report.score;
      }
      mean[level] = total / 3;
    }
    expect(mean.beginner).toBeLessThan(mean.intermediate);
    expect(mean.intermediate).toBeLessThan(mean.expert);
    // Nine generations, three of them the ranked board's climb: seconds on a slow machine or a loaded
    // commit hook, so the budget is as generous as the other generation tests of this module.
  }, 60_000);
});

describe('the modes and their stored choices', () => {
  it('lists ONE choice of four: the ranked game, then the unranked levels, easiest first', () => {
    expect(PLAY_MODES).toEqual(['ranked', 'beginner', 'intermediate', 'expert']);
    expect(playModeOf(false, 'intermediate')).toBe('ranked');
    expect(playModeOf(true, 'intermediate')).toBe('intermediate');
  });

  it('plays a newcomer unranked, and keeps what a player chose, ranked included', () => {
    // No stored choice: the ranked board is the barrier to entry, so the newcomer starts in Entrainement.
    expect(loadMinesweeperUnranked()).toBe(true);
    expect(localStorage.getItem('canari.minesweeper.unranked')).toBeNull();
    saveMinesweeperUnranked(false);
    expect(loadMinesweeperUnranked()).toBe(false);
    saveMinesweeperUnranked(true);
    expect(loadMinesweeperUnranked()).toBe(true);
    expect(localStorage.getItem('canari.minesweeper.unranked')).toBe('1');
  });

  it('knows a first game from a later one: a mode is stored once chosen, and the default alone stores nothing', () => {
    expect(hasStoredMinesweeperMode()).toBe(false);
    // Reading the default answers and writes nothing, so the first game stays a first game until a choice.
    loadMinesweeperUnranked();
    expect(hasStoredMinesweeperMode()).toBe(false);
    saveMinesweeperUnranked(true);
    expect(hasStoredMinesweeperMode()).toBe(true);
    localStorage.clear();
    saveMinesweeperUnranked(false);
    expect(hasStoredMinesweeperMode()).toBe(true);
  });

  it('starts a newcomer on Debutant, and keeps Expert for a player who already chose a mode', () => {
    expect(loadMinesweeperLevel()).toBe('beginner');
    localStorage.clear();
    localStorage.setItem('canari.minesweeper.unranked', '0');
    expect(loadMinesweeperLevel()).toBe('expert');
  });

  it('answers the default once and stores it: a later mode choice cannot flip it', () => {
    expect(loadMinesweeperLevel()).toBe('beginner');
    expect(localStorage.getItem(LEVEL_STORAGE_KEY)).toBe('beginner');
    // The newcomer then switches to Libre, which writes the mode key the default reads.
    localStorage.setItem('canari.minesweeper.unranked', '1');
    expect(loadMinesweeperLevel()).toBe('beginner');
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
