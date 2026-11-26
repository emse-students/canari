import { Leaf, Sprout, TreePine, Trophy } from '@lucide/svelte';
import { m } from '$lib/paraglide/messages';
import type { MinesweeperLevel, PlayMode } from './levels';

/** The name of a level, in the player's language. */
function levelLabel(level: MinesweeperLevel): string {
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

/** The full name of a mode, as the mode sheet lists it: "Classe", "Libre . Debutant". */
export function playModeLabel(mode: PlayMode): string {
  return mode === 'ranked'
    ? m.minesweeper_ranked()
    : m.minesweeper_mode_casual_level({ level: levelLabel(mode) });
}

/** One line on what a mode is, under its name in the sheet. */
export function playModeDescription(mode: PlayMode): string {
  switch (mode) {
    case 'ranked':
      return m.minesweeper_mode_ranked_desc();
    case 'beginner':
      return m.minesweeper_mode_beginner_desc();
    case 'intermediate':
      return m.minesweeper_mode_intermediate_desc();
    default:
      return m.minesweeper_mode_expert_desc();
  }
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
