import { MAX_SCALE, fitScaleCap } from './view';
import {
  CHALLENGE,
  LATEST_GENERATOR_VERSION,
  type GeneratorVersion,
  type MinesweeperConfig,
} from './game';

/**
 * The levels of an UNRANKED game (owner, 2026-11-25: *"le demineur est vraiment super dur, la barriere
 * a l'entree est terrifiante ... sans remettre en cause le niveau du classe"*).
 *
 * Expert IS the ranked board - same size, same generator - so a player who trained on it meets
 * nothing new in a ranked game. The two smaller levels use generator 1: it stops at the FIRST layout
 * its solver clears, so the board is guess-free with simple deductions, where generator 2 climbs to a
 * reasoning score on purpose. Both generators are called as they are; nothing here changes either.
 * A casual game is never submitted, so its generator choice is the client's alone.
 */
export type MinesweeperLevel = 'beginner' | 'intermediate' | 'expert';

/** In the order the picker cycles through them, easiest first. */
export const LEVELS: readonly MinesweeperLevel[] = ['beginner', 'intermediate', 'expert'];

export interface LevelSpec {
  config: MinesweeperConfig;
  generator: GeneratorVersion;
}

/** The board each level plays on. The ranked game always plays `expert`'s board. */
export const LEVEL_SPECS: Readonly<Record<MinesweeperLevel, LevelSpec>> = {
  beginner: { config: { width: 9, height: 9, mineCount: 10 }, generator: 1 },
  intermediate: { config: { width: 16, height: 16, mineCount: 40 }, generator: 1 },
  expert: { config: CHALLENGE, generator: LATEST_GENERATOR_VERSION },
};

export const LEVEL_STORAGE_KEY = 'canari.minesweeper.level';
/** The ranked / unranked choice, stored by the modal; read here only to pick the default level. */
const UNRANKED_STORAGE_KEY = 'canari.minesweeper.unranked';

/** The next level of the picker's cycle, back to the first after the last. */
export function nextLevel(level: MinesweeperLevel): MinesweeperLevel {
  return LEVELS[(LEVELS.indexOf(level) + 1) % LEVELS.length];
}

/**
 * The stored level, validated. With none stored, a player who already played on this device (a
 * stored ranked / unranked choice) keeps the board they knew, `expert`; a newcomer starts on
 * `beginner`. A value that is not a level is logged and read as none.
 */
export function loadMinesweeperLevel(): MinesweeperLevel {
  if (typeof localStorage === 'undefined') return 'beginner';
  try {
    const stored = localStorage.getItem(LEVEL_STORAGE_KEY);
    if (stored !== null) {
      if (LEVELS.includes(stored as MinesweeperLevel)) return stored as MinesweeperLevel;
      console.warn('[minesweeper] stored level unreadable, using the default', { stored });
    }
    // Answered ONCE and stored: asked again on a later open, the question would read the ranked / Libre
    // choice this very session wrote, and a newcomer's Debutant would turn into Expert.
    const playedBefore = localStorage.getItem(UNRANKED_STORAGE_KEY) !== null;
    const resolved: MinesweeperLevel = playedBefore ? 'expert' : 'beginner';
    console.debug('[minesweeper] no stored level, resolved once', { playedBefore, resolved });
    saveMinesweeperLevel(resolved);
    return resolved;
  } catch (err) {
    console.warn('[minesweeper] could not read the stored level, using the default', err);
    return 'beginner';
  }
}

/**
 * The highest scale the fit may use for a board of `config` drawn `boardWidthPx` wide. The small
 * levels are capped so their cells stay a thumb's size ({@link fitScaleCap}); the ranked board
 * (Expert) is NOT, so it fits exactly as it always did, on every screen.
 */
export function levelFitCap(config: MinesweeperConfig, boardWidthPx: number): number {
  const expert = LEVEL_SPECS.expert.config;
  const isExpert =
    config.width === expert.width &&
    config.height === expert.height &&
    config.mineCount === expert.mineCount;
  return isExpert ? MAX_SCALE : fitScaleCap(boardWidthPx, config.width);
}

/** Persists the level; a storage that refuses is logged, never fatal. */
export function saveMinesweeperLevel(level: MinesweeperLevel): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(LEVEL_STORAGE_KEY, level);
  } catch (err) {
    console.warn('[minesweeper] could not store the level', err);
  }
}
