<script lang="ts">
  import { untrack } from 'svelte';
  import { Flag, Pickaxe } from '@lucide/svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import MinesweeperCell from '$lib/components/settings/MinesweeperCell.svelte';
  import { revealCell, toggleFlag, type MinesweeperBoard } from '$lib/minesweeper/game';
  import { EMPTY_CELL_VIEWS, syncCellViews } from '$lib/minesweeper/cellViews';
  import { boardFromLayout } from '$lib/minesweeper/tutorial/layout';
  import { lessonDone, type Lesson } from '$lib/minesweeper/tutorial/lessons';
  import { m } from '$lib/paraglide/messages';

  /**
   * ONE PLAYABLE MINI-GRID OF THE TUTORIAL (owner, 2026-11-25). It is the real game in small: the engine's
   * own board (`boardFromLayout` places the mines of the lesson's picture), its own `revealCell`,
   * `toggleFlag` and chord, and the game's own cell, so a tap here does exactly what it does there.
   *
   * The parent mounts it under `{#key}` for a lesson and an attempt, so it reads its props ONCE: a lesson
   * change or a restart is a new component, never a reset of this one.
   */
  interface Props {
    lesson: Lesson;
    /** The step of the lesson's hints being shown, or null. It lights the numbers and the cells they read. */
    hintStep: number | null;
    /** Called once, when the board satisfies the lesson's goal. */
    onSolved: () => void;
    /** Called once, when a mine was opened: the lesson cannot continue, the parent offers to start over. */
    onLost: () => void;
  }

  let { lesson, hintStep, onSolved, onLost }: Props = $props();

  let board = $state.raw<MinesweeperBoard>(untrack(() => boardFromLayout(lesson.rows)));
  let views = $state.raw(
    syncCellViews(
      untrack(() => board.cells),
      EMPTY_CELL_VIEWS
    ).next
  );
  /** What a tap does: dig (and chord on a number), or flag. A right-click always flags. */
  let flagMode = $state(false);
  let finished = false;

  /** What lights each cell, by index: `hint` the number being read, `group` a cell it speaks about. */
  const lit = $derived.by(() => {
    const marks: Array<'hint' | 'group' | null> = board.cells.map(() => null);
    const at = ([x, y]: readonly [number, number]) => y * board.width + x;
    const step = hintStep === null ? null : lesson.hints[hintStep];
    if (step) {
      for (const c of step.group) marks[at(c)] = 'group';
      for (const c of step.numbers) marks[at(c)] = 'hint';
    } else {
      // A gesture lesson shows where to touch from the start; it is not a hint.
      for (const c of lesson.guide ?? []) marks[at(c)] = 'group';
    }
    return marks;
  });

  /** Publishes what the engine changed, and tells the parent when the lesson is over. */
  function commit() {
    views = syncCellViews(board.cells, views).next;
    if (finished) return;
    if (board.status === 'lost') {
      finished = true;
      console.debug('[minesweeper-tutorial] a mine was opened', { lesson: lesson.id });
      onLost();
    } else if (lessonDone(board, lesson.goal)) {
      finished = true;
      console.debug('[minesweeper-tutorial] lesson solved', { lesson: lesson.id });
      onSolved();
    }
  }

  function act(index: number, flag: boolean) {
    if (finished) return;
    const x = index % board.width;
    const y = Math.floor(index / board.width);
    // A number is chorded by a tap whatever the mode: flagging a revealed cell is meaningless.
    if (flag && board.cells[index].state !== 'revealed') toggleFlag(board, x, y);
    else revealCell(board, x, y);
    commit();
  }

  function indexOf(event: Event): number | null {
    const el = (event.target as HTMLElement).closest<HTMLElement>('[data-cell]');
    return el ? Number(el.dataset.cell) : null;
  }

  function handleClick(event: MouseEvent) {
    const i = indexOf(event);
    if (i !== null) act(i, flagMode);
  }

  function handleContextMenu(event: MouseEvent) {
    event.preventDefault();
    const i = indexOf(event);
    if (i !== null) act(i, true);
  }
</script>

<div class="flex flex-col items-center gap-3">
  <div
    role="presentation"
    class="grid w-max gap-px [--ms-cell:2.5rem] sm:[--ms-cell:2.75rem]"
    style="grid-template-columns: repeat({board.width}, var(--ms-cell));"
    aria-label={m.minesweeper_tutorial_grid_label()}
    onclick={handleClick}
    oncontextmenu={handleContextMenu}
  >
    {#each views.views as cell, i (i)}
      <MinesweeperCell {cell} index={i} pending={false} highlight={lit[i]} />
    {/each}
  </div>

  <div class="flex items-center gap-1" role="group" aria-label={m.minesweeper_mode_hint()}>
    <Button
      size="compact"
      variant={flagMode ? 'ghost' : 'secondary'}
      aria-pressed={!flagMode}
      onclick={() => (flagMode = false)}
    >
      <Pickaxe size={16} strokeWidth={2.25} />
      {m.minesweeper_mode_dig()}
    </Button>
    <Button
      size="compact"
      variant={flagMode ? 'secondary' : 'ghost'}
      aria-pressed={flagMode}
      onclick={() => (flagMode = true)}
    >
      <Flag size={16} strokeWidth={2.25} />
      {m.minesweeper_mode_flag()}
    </Button>
  </div>
</div>
