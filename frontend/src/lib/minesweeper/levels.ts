import {
  CHALLENGE,
  LATEST_GENERATOR_VERSION,
  V2_TARGET_SCORE,
  type GeneratorVersion,
  type MinesweeperConfig,
} from './game';

/**
 * The levels of an UNRANKED game (owner, 2026-11-25: *"le demineur est vraiment super dur, la barriere
 * a l'entree est terrifiante ... sans remettre en cause le niveau du classe"*).
 *
 * **A LEVEL IS A GENERATION, NOT A SIZE** (owner, 2026-11-25: *"priorise les difficultes par generation
 * et pas par taille"*): every level plays the ranked board's size and generator 2, and differs only by
 * the reasoning score that generator climbs to (`targetScore`). The player never sees the number. Expert
 * IS the ranked board - same size, same target - so a player who trained on it meets nothing new in a
 * ranked game. Beginner's target is 0: the generator stops at the first layout its solver clears, so
 * the board is guess-free with simple deductions; Intermediate asks for some subset and local
 * reasoning on top. Nothing here changes a published generator: the target is a parameter of the
 * board, and ranked never passes one. A casual game is never submitted, so its target is the client's.
 */
export type MinesweeperLevel = 'beginner' | 'intermediate' | 'expert';

/** In the order the picker cycles through them, easiest first. */
export const LEVELS: readonly MinesweeperLevel[] = ['beginner', 'intermediate', 'expert'];

export interface LevelSpec {
  config: MinesweeperConfig;
  generator: GeneratorVersion;
  /** The reasoning score generator 2 climbs to (see `V2_SCORE_WEIGHTS` in the engine). */
  targetScore: number;
}

/** The board each level plays on. The ranked game always plays `expert`'s board. */
export const LEVEL_SPECS: Readonly<Record<MinesweeperLevel, LevelSpec>> = {
  beginner: { config: CHALLENGE, generator: LATEST_GENERATOR_VERSION, targetScore: 0 },
  intermediate: { config: CHALLENGE, generator: LATEST_GENERATOR_VERSION, targetScore: 30 },
  expert: { config: CHALLENGE, generator: LATEST_GENERATOR_VERSION, targetScore: V2_TARGET_SCORE },
};

export const LEVEL_STORAGE_KEY = 'canari.minesweeper.level';
/** The ranked / unranked choice, `'1'` for unranked: its presence also says a player chose on this device. */
const UNRANKED_STORAGE_KEY = 'canari.minesweeper.unranked';

/**
 * WHAT A PLAYER PICKS BEFORE A GAME, in ONE list (owner, 2026-11-26: the Classe / Libre toggle and the level
 * chip were two controls for what is one choice): the ranked game, or an unranked one at a level.
 */
export type PlayMode = 'ranked' | MinesweeperLevel;

/** In the order the mode sheet lists them: the ranked game, then the unranked levels, easiest first. */
export const PLAY_MODES: readonly PlayMode[] = ['ranked', ...LEVELS];

/** The mode a stored pair of choices amounts to: ranked, or the unranked level. */
export function playModeOf(unranked: boolean, level: MinesweeperLevel): PlayMode {
  return unranked ? level : 'ranked';
}

/**
 * Whether the next game is unranked. A stored choice wins, always; with none, a NEWCOMER plays unranked
 * (owner, 2026-11-25: the ranked board, 150 mines at a reasoning score of 60, is a barrier to entry), and
 * ranked is one pick away in the mode sheet. Not stored here: the first pick the player makes writes it.
 */
export function loadMinesweeperUnranked(): boolean {
  if (typeof localStorage === 'undefined') return true;
  try {
    const stored = localStorage.getItem(UNRANKED_STORAGE_KEY);
    return stored === null ? true : stored === '1';
  } catch (err) {
    console.warn('[minesweeper] could not read the stored mode, playing unranked', err);
    return true;
  }
}

/** Persists the ranked / unranked choice; a storage that refuses is logged, never fatal. */
export function saveMinesweeperUnranked(unranked: boolean): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(UNRANKED_STORAGE_KEY, unranked ? '1' : '0');
  } catch (err) {
    console.warn('[minesweeper] could not store the mode', err);
  }
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

/** Persists the level; a storage that refuses is logged, never fatal. */
export function saveMinesweeperLevel(level: MinesweeperLevel): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(LEVEL_STORAGE_KEY, level);
  } catch (err) {
    console.warn('[minesweeper] could not store the level', err);
  }
}
