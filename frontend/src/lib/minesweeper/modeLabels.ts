import { Leaf, Sprout, TreePine, Trophy } from '@lucide/svelte';
import { m } from '$lib/paraglide/messages';
import type { MinesweeperLevel, PlayMode } from './levels';

/** The name of a level, in the player's language. */
export function levelLabel(level: MinesweeperLevel): string {
  return level === 'beginner'
    ? m.minesweeper_level_beginner()
    : level === 'intermediate'
      ? m.minesweeper_level_intermediate()
      : m.minesweeper_level_expert();
}

/** The short name a mode wears on the pastille: "Classe", or the level of an unranked game. */
export function playModeShortLabel(mode: PlayMode): string {
  return mode === 'ranked' ? m.minesweeper_ranked() : levelLabel(mode);
}

/** The full name of a mode: "Classe", "Entrainement . Debutant". */
export function playModeLabel(mode: PlayMode): string {
  return mode === 'ranked'
    ? m.minesweeper_ranked()
    : m.minesweeper_mode_casual_level({ level: levelLabel(mode) });
}

/** The glyph of a mode: the trophy for the ranked game, a plant that grows with the level. */
export function playModeIcon(mode: PlayMode) {
  return mode === 'ranked'
    ? Trophy
    : mode === 'beginner'
      ? Sprout
      : mode === 'intermediate'
        ? Leaf
        : TreePine;
}
