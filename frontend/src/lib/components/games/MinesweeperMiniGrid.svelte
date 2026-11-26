<script lang="ts">
  import { untrack } from 'svelte';
  import { Bomb, Flag, Pickaxe } from '@lucide/svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import MinesweeperCell from '$lib/components/settings/MinesweeperCell.svelte';
  import {
    remainingMines,
    revealCell,
    toggleFlag,
    type MinesweeperBoard,
  } from '$lib/minesweeper/game';
  import { EMPTY_CELL_VIEWS, syncCellViews } from '$lib/minesweeper/cellViews';
  import { boardFromLayout } from '$lib/minesweeper/tutorial/layout';
  import { lessonDone, type Lesson, type MarkKind } from '$lib/minesweeper/tutorial/lessons';
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
    /** The step of the lesson's hints being shown, or null. It rings the numbers it reads and outlines its marks. */
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

  /** The mines counter, as the game's HUD draws it: the mines minus the flags, which is not a proof. */
  let remaining = $state(untrack(() => remainingMines(board)));

  /**
   * THE CELLS THE PICTURE ONLY SUGGESTS, in an open grid: hidden, and no revealed number touches them. Read
   * once from the picture (opening a cell later does not make one of them part of the pattern).
   */
  const far = untrack(() =>
    board.cells.map((cell, i) => {
      if (!lesson.open || cell.state === 'revealed') return false;
      const x = i % board.width;
      const y = Math.floor(i / board.width);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          const inside = nx >= 0 && nx < board.width && ny >= 0 && ny < board.height;
          if ((dx || dy) && inside && board.cells[ny * board.width + nx].state === 'revealed')
            return false;
        }
      }
      return true;
    })
  );

  /** The numbers the shown explanation reads, ringed (`read`). */
  const reading = $derived.by(() => {
    const lit: Array<'read' | null> = board.cells.map(() => null);
    const step = hintStep === null ? null : lesson.hints[hintStep];
    for (const [x, y] of step?.numbers ?? []) lit[y * board.width + x] = 'read';
    return lit;
  });

  /**
   * ONE OUTLINE PER RECTANGLE, over the grid and never a ring per cell (owner, 2026-11-26): a group of
   * several cells reads as a group. Red is a certain mine, yellow a group holding mines (its count in a
   * badge on the first rectangle), green a certain safe cell. A gesture lesson shows its target from the
   * start; that is not a hint.
   */
  const outlines = $derived.by(() => {
    const step = hintStep === null ? null : lesson.hints[hintStep];
    const marks = step ? step.marks : (lesson.guide ?? []);
    return marks.flatMap((mark) =>
      mark.rects.map(([x, y, w, h], i) => ({
        kind: mark.kind as MarkKind,
        x,
        y,
        w,
        h,
        badge: i === 0 ? mark.count : undefined,
      }))
    );
  });

  /**
   * REDUCTION (owner, 2026-11-26): a number shown with what is left of it once the flags it touches are
   * taken off, as a small `-> n` pill on the number. The test holds each value to the board.
   */
  const reductions = $derived.by(() => {
    const step = hintStep === null ? null : lesson.hints[hintStep];
    return step?.reduced ?? [];
  });

  /** Colours of an outline, by what it says. */
  const OUTLINE: Record<MarkKind, string> = {
    mine: 'border-red-err bg-red-err/15',
    group: 'border-accent bg-accent/20',
    safe: 'border-green-ok bg-green-ok/15',
  };

  /** Publishes what the engine changed, and tells the parent when the lesson is over. */
  function commit() {
    views = syncCellViews(board.cells, views).next;
    remaining = remainingMines(board);
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
    if (finished || far[index]) return;
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
  <span
    role="img"
    aria-label={lesson.open
      ? m.minesweeper_tutorial_counter_unknown()
      : m.minesweeper_tutorial_counter({ n: String(remaining) })}
    class="text-text-main flex items-center gap-1.5 text-sm font-bold"
    data-testid="tutorial-counter"
  >
    <Bomb size={16} class="text-cn-dark" />
    {lesson.open ? '?' : remaining}
  </span>

  <!-- The two layers share the cell size, so an outline is placed in cells with `calc`, no measuring. -->
  <div class="relative w-max [--ms-cell:2.5rem] sm:[--ms-cell:2.75rem]">
    <div
      role="presentation"
      class="grid w-max gap-px"
      style="grid-template-columns: repeat({board.width}, var(--ms-cell));"
      aria-label={m.minesweeper_tutorial_grid_label()}
      onclick={handleClick}
      oncontextmenu={handleContextMenu}
    >
      {#each views.views as cell, i (i)}
        <MinesweeperCell
          {cell}
          index={i}
          pending={false}
          highlight={reading[i] ?? (far[i] ? 'far' : null)}
        />
      {/each}
    </div>

    <div class="pointer-events-none absolute inset-0" aria-hidden="true">
      {#each outlines as o, i (i)}
        <div
          data-mark={o.kind}
          class="absolute rounded-lg border-2 {OUTLINE[o.kind]}"
          style="left: calc({o.x} * (var(--ms-cell) + 1px) - 2px); top: calc({o.y} * (var(--ms-cell) + 1px) - 2px); width: calc({o.w} * var(--ms-cell) + {o.w -
            1} * 1px + 4px); height: calc({o.h} * var(--ms-cell) + {o.h - 1} * 1px + 4px);"
        >
          {#if o.badge !== undefined}
            <span
              data-mark-count={o.badge}
              class="bg-accent text-on-accent absolute -top-3 -right-2 flex items-center gap-0.5 rounded-full px-1.5 text-xs font-bold"
            >
              <Bomb size={10} />
              {o.badge}
            </span>
          {/if}
        </div>
      {/each}
      {#each reductions as r (`${r.cell[0]}-${r.cell[1]}`)}
        <span
          data-reduced={r.value}
          class="bg-cn-dark text-cn-surface absolute z-10 rounded-full px-1.5 text-xs font-bold"
          style="left: calc({r
            .cell[0]} * (var(--ms-cell) + 1px) + var(--ms-cell) - 1.1rem); top: calc({r
            .cell[1]} * (var(--ms-cell) + 1px) - 0.55rem);"
        >
          → {r.value}
        </span>
      {/each}
    </div>
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
