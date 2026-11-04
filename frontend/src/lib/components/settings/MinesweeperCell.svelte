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

  /** Tailwind text-color classes for revealed adjacent-mine counts 1-8. */
  const NUMBER_COLORS: Record<number, string> = {
    1: 'text-blue-600',
    2: 'text-green-600',
    3: 'text-red-600',
    4: 'text-purple-700',
    5: 'text-orange-700',
    6: 'text-cyan-700',
    7: 'text-text-main',
    8: 'text-text-muted',
  };

  const tone = $derived(
    pending
      ? 'bg-cn-bg border-cn-border animate-pulse'
      : cell.state !== 'revealed'
        ? 'bg-cn-yellow/25 hover:bg-cn-yellow/40 active:bg-cn-yellow/60 border-cn-border'
        : cell.mine
          ? 'border-transparent bg-red-500/80'
          : 'bg-cn-bg border-transparent'
  );
  const numberColor = $derived(
    cell.state === 'revealed' && !cell.mine && cell.adjacent > 0 ? NUMBER_COLORS[cell.adjacent] : ''
  );
</script>

<button
  type="button"
  data-cell={index}
  class="box-border flex h-[length:var(--ms-cell)] w-[length:var(--ms-cell)] shrink-0 touch-manipulation items-center justify-center rounded-sm border font-mono text-xs font-bold select-none sm:text-sm {tone} {numberColor}"
>
  {#if cell.state === 'flagged'}
    <Flag size={14} class="text-cn-dark" />
  {:else if cell.state === 'revealed' && cell.mine}
    <Bomb size={14} class="text-white" />
  {:else if cell.state === 'revealed' && cell.adjacent > 0}
    {cell.adjacent}
  {/if}
</button>
