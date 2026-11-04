<script lang="ts">
  import { Bomb, Flag } from '@lucide/svelte';
  import type { Cell } from '$lib/minesweeper/game';

  interface Props {
    /** The view object of this cell: replaced (never mutated) when what is drawn changes. */
    cell: Cell;
    /** Index in the board, read back by the grid's delegated handlers through `data-cell`. */
    index: number;
    /** The cell whose first dig is being prepared: shown pressed until the board exists. */
    pending: boolean;
  }

  let { cell, index, pending }: Props = $props();

  /**
   * Revealed-number colours: a deep shade on the light board, a bright one on the black board (the
   * old -600/-700 shades were close to unreadable on black).
   */
  const NUMBER_COLORS: Record<number, string> = {
    1: 'text-blue-700 dark:text-blue-400',
    2: 'text-green-700 dark:text-green-400',
    3: 'text-red-600 dark:text-red-400',
    4: 'text-purple-700 dark:text-purple-400',
    5: 'text-orange-700 dark:text-orange-400',
    6: 'text-cyan-700 dark:text-cyan-400',
    7: 'text-text-main',
    8: 'text-text-muted',
  };

  /**
   * FLAT TONAL (user's pick, 2026-11-04): flat rounded tiles with no border. A hidden cell is the
   * board colour tinted toward the text colour (so it follows the theme), a revealed one is the plain
   * surface in light and the plain board in dark, and the only colour on the board is the numbers,
   * the gold flag and the red mine. The pressed first-dig cell keeps the pulse.
   */
  const tone = $derived(
    pending
      ? 'bg-cn-bg animate-pulse'
      : cell.state !== 'revealed'
        ? 'ms-hidden'
        : cell.mine
          ? 'bg-red-600'
          : 'bg-cn-surface dark:bg-cn-bg'
  );
  const numberColor = $derived(
    cell.state === 'revealed' && !cell.mine && cell.adjacent > 0 ? NUMBER_COLORS[cell.adjacent] : ''
  );
</script>

<button
  type="button"
  data-cell={index}
  class="box-border flex h-[length:var(--ms-cell)] w-[length:var(--ms-cell)] shrink-0 touch-manipulation items-center justify-center rounded-md font-mono text-xs font-bold select-none sm:text-sm {tone} {numberColor}"
>
  {#if cell.state === 'flagged'}
    <Flag size={14} class="dark:text-cn-yellow text-amber-700" />
  {:else if cell.state === 'revealed' && cell.mine}
    <Bomb size={14} class="text-white" />
  {:else if cell.state === 'revealed' && cell.adjacent > 0}
    {cell.adjacent}
  {/if}
</button>

<style>
  /* Hidden tile: the board colour pulled 14% toward the text colour, 22% on hover and 30% pressed. */
  .ms-hidden {
    background: color-mix(in srgb, var(--text-main) 14%, var(--cn-bg));
  }

  /* Hover only where a pointer hovers: on a touch screen it would stick to the last tapped cell. */
  @media (hover: hover) {
    .ms-hidden:hover {
      background: color-mix(in srgb, var(--text-main) 22%, var(--cn-bg));
    }
  }

  .ms-hidden:active {
    background: color-mix(in srgb, var(--text-main) 30%, var(--cn-bg));
  }
</style>
