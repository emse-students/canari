<script lang="ts">
  import Modal from '$lib/components/shared/Modal.svelte';
  import {
    createBoard,
    revealCell,
    toggleFlag,
    remainingMines,
    BEGINNER,
    type MinesweeperBoard,
  } from '$lib/minesweeper/game';
  import { Bomb, Flag, RotateCcw } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** Whether the modal is visible; becoming true starts a fresh game. */
    open?: boolean;
    /** Called when the modal should be dismissed. */
    onClose: () => void;
  }

  let { open = false, onClose }: Props = $props();

  /** How long a touch must be held before it flags a cell instead of digging it. */
  const LONG_PRESS_MS = 450;

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

  let board = $state<MinesweeperBoard>(createBoard(BEGINNER));
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let longPressed = false;

  const statusMessage = $derived.by(() => {
    if (board.status === 'won') return m.minesweeper_status_won();
    if (board.status === 'lost') return m.minesweeper_status_lost();
    return m.minesweeper_status_playing();
  });

  function newGame() {
    board = createBoard(BEGINNER);
  }

  /**
   * Forces reactivity after the game helpers mutate `board` in place: the cell
   * array is shallow-copied so Svelte's `$state` proxy detects the change.
   */
  function sync() {
    board = { ...board, cells: board.cells.map((cell) => ({ ...cell })) };
  }

  function clearLongPressTimer() {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  function dig(x: number, y: number) {
    revealCell(board, x, y);
    sync();
  }

  function flag(x: number, y: number) {
    toggleFlag(board, x, y);
    sync();
  }

  function handleCellClick(x: number, y: number) {
    if (longPressed) {
      // The long-press timer already flagged this cell; swallow the trailing click/pointerup.
      longPressed = false;
      return;
    }
    dig(x, y);
  }

  function handleContextMenu(e: MouseEvent, x: number, y: number) {
    e.preventDefault();
    if (longPressed) {
      longPressed = false;
      return;
    }
    clearLongPressTimer();
    flag(x, y);
  }

  function handlePointerDown(e: PointerEvent, x: number, y: number) {
    if (e.pointerType !== 'touch') return;
    longPressed = false;
    clearLongPressTimer();
    longPressTimer = setTimeout(() => {
      longPressed = true;
      flag(x, y);
    }, LONG_PRESS_MS);
  }

  function handlePointerRelease() {
    clearLongPressTimer();
  }
</script>

<Modal {open} title={m.minesweeper_title()} {onClose} maxWidth="max-w-sm">
  <div class="flex items-center justify-between gap-2 mb-3">
    <div class="flex items-center gap-1.5 text-sm font-bold text-text-main">
      <Bomb size={16} class="text-cn-dark" />
      {m.minesweeper_mines_left({ count: remainingMines(board) })}
    </div>
    <p class="text-xs font-semibold text-text-muted truncate">{statusMessage}</p>
    <button
      type="button"
      onclick={newGame}
      class="flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold bg-cn-yellow/10 text-cn-dark hover:bg-cn-yellow/20 transition-colors"
    >
      <RotateCcw size={14} strokeWidth={2.5} />
      {m.minesweeper_new_game()}
    </button>
  </div>

  <div class="grid grid-cols-9 gap-0.5 w-fit mx-auto" style="touch-action: manipulation;">
    {#each board.cells as cell, i (i)}
      {@const x = i % board.width}
      {@const y = Math.floor(i / board.width)}
      <button
        type="button"
        disabled={board.status !== 'playing'}
        onclick={() => handleCellClick(x, y)}
        oncontextmenu={(e) => handleContextMenu(e, x, y)}
        onpointerdown={(e) => handlePointerDown(e, x, y)}
        onpointerup={handlePointerRelease}
        onpointerleave={handlePointerRelease}
        onpointercancel={handlePointerRelease}
        class="size-8 flex items-center justify-center select-none touch-manipulation rounded-md border font-mono font-bold text-sm
          {cell.state === 'hidden'
          ? 'bg-cn-yellow/25 hover:bg-cn-yellow/40 border-cn-border'
          : cell.state === 'flagged'
            ? 'bg-cn-yellow/25 hover:bg-cn-yellow/40 border-cn-border'
            : cell.mine
              ? 'bg-red-500/80 border-transparent'
              : cell.adjacent === 0
                ? 'bg-cn-bg/60 border-transparent'
                : 'bg-cn-bg/80 border-transparent'}
          {cell.state === 'revealed' && !cell.mine && cell.adjacent > 0
          ? NUMBER_COLORS[cell.adjacent]
          : ''}"
      >
        {#if cell.state === 'flagged'}
          <Flag size={14} class="text-cn-dark" />
        {:else if cell.state === 'revealed' && cell.mine}
          <Bomb size={14} class="text-white" />
        {:else if cell.state === 'revealed' && cell.adjacent > 0}
          {cell.adjacent}
        {/if}
      </button>
    {/each}
  </div>

  <div class="mt-3 space-y-0.5 text-center">
    <p class="text-xs text-text-muted">{m.minesweeper_hint_desktop()}</p>
    <p class="text-xs text-text-muted">{m.minesweeper_hint_touch()}</p>
  </div>
</Modal>
