<script lang="ts">
  import { untrack } from 'svelte';
  import { Bomb } from '@lucide/svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import MinesweeperCell from '$lib/components/settings/MinesweeperCell.svelte';
  import {
    remainingMines,
    revealCell,
    toggleFlag,
    type MinesweeperBoard,
  } from '$lib/minesweeper/game';
  import { EMPTY_CELL_VIEWS, syncCellViews } from '$lib/minesweeper/cellViews';
  import { loadMinesweeperSettings } from '$lib/minesweeper/settings';
  import { boardFromLayout, pictureOf } from '$lib/minesweeper/tutorial/layout';
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
    /** The player's gestures (`controls.ts`): true, a short press flags and a long press digs. */
    flagPrimary: boolean;
    /** Names the gestures for a finger (short / long press) or a mouse (left / right click). */
    touch: boolean;
    /** Swaps the two gestures, for here and for the game. */
    onInvert: () => void;
  }

  let { lesson, hintStep, onSolved, onLost, flagPrimary, touch, onInvert }: Props = $props();

  let board = $state.raw<MinesweeperBoard>(untrack(() => boardFromLayout(lesson.rows)));
  let views = $state.raw(
    syncCellViews(
      untrack(() => board.cells),
      EMPTY_CELL_VIEWS
    ).next
  );
  /** How long a finger stays down before the press is a LONG one: the game's own setting. */
  const longPressMs = loadMinesweeperSettings().longPressMs;
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  /** The click that ends a long press must not run the short press too. */
  let longPressed = false;
  let finished = false;

  /** The mines counter, as the game's HUD draws it: the mines minus the flags, which is not a proof. */
  let remaining = $state(untrack(() => remainingMines(board)));

  /**
   * WHAT THE PICTURE HIDES, read once from it (opening a cell later does not change it): `fog` the cells the
   * picture only suggests (drawn `~`/`X`, or in an open grid a hidden cell no shown number touches), `unknown`
   * the open cells whose number is hidden (`?`). Neither can be played: they are there so that the pattern is
   * the only reasoning the picture allows (owner, 2026-11-27).
   */
  const { fog: far, unknown } = untrack(() => pictureOf(lesson.rows, lesson.open === true));

  /**
   * A CELL THE PLAYER OPENS in an open picture shows "?" too (owner, 2026-11-27: *"les nombres en dessous sont
   * souvent bizarres"*): its number counts the fog beyond the pattern, which the picture does not show anywhere
   * else, so it would be a number about nothing. The pattern is what tells the cell is safe; that is all it says.
   */
  const hiddenAtStart = untrack(() => board.cells.map((cell) => cell.state !== 'revealed'));
  const opened = $derived(
    views.views.map(
      (cell, i) =>
        lesson.open === true && hiddenAtStart[i] && cell.state === 'revealed' && !cell.mine
    )
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

  /**
   * THE GAME'S GESTURES (owner, 2026-11-27): a short press (a left click) digs, or flags when the player chose
   * the flag first; a long press (a right click) does the other. A short press on a number chords it whatever
   * the choice, as in the game.
   */
  function act(index: number, long: boolean) {
    if (finished || far[index] || unknown[index] || opened[index]) return;
    const x = index % board.width;
    const y = Math.floor(index / board.width);
    const flag = long !== flagPrimary;
    if (board.cells[index].state === 'revealed') {
      // A short press on a number always chords it, as in the game; a long press only when it digs.
      if (long && !flagPrimary) return;
      revealCell(board, x, y);
    } else if (flag) toggleFlag(board, x, y);
    else revealCell(board, x, y);
    commit();
  }

  function clearLongPress() {
    if (longPressTimer) clearTimeout(longPressTimer);
    longPressTimer = null;
  }

  function indexOf(event: Event): number | null {
    const el = (event.target as HTMLElement).closest<HTMLElement>('[data-cell]');
    return el ? Number(el.dataset.cell) : null;
  }

  function handleClick(event: MouseEvent) {
    clearLongPress();
    if (longPressed) {
      longPressed = false;
      return;
    }
    const i = indexOf(event);
    if (i !== null) act(i, false);
  }

  function handleContextMenu(event: MouseEvent) {
    event.preventDefault();
    // A finger's long press already ran; the contextmenu it raises must not run it twice.
    if (longPressed) return;
    const i = indexOf(event);
    if (i !== null) act(i, true);
  }

  /** A finger held on a cell for the game's long-press time is a long press. */
  function handlePointerDown(event: PointerEvent) {
    if (event.pointerType !== 'touch') return;
    const i = indexOf(event);
    if (i === null) return;
    longPressed = false;
    clearLongPress();
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      longPressed = true;
      act(i, true);
    }, longPressMs);
  }

  const dig = m.minesweeper_controls_action_dig();
  const flagWord = m.minesweeper_controls_action_flag();
  /** What each gesture does, said once under the grid. */
  const gestures = $derived.by(() => {
    const [short, long] = flagPrimary ? [flagWord, dig] : [dig, flagWord];
    return touch
      ? m.minesweeper_controls_touch({ short, long })
      : m.minesweeper_controls_mouse({ short, long });
  });
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

  <!-- The two layers share the cell size, so an outline is placed in cells with `calc`, no measuring. THE CELLS ARE
       BIG (owner mockup, 2026-11-28: 60 px on a phone, numbers in the display face): as wide as the screen allows
       for this board's columns, capped at 3.75rem, so a 7-column pattern still fits a 360 px phone. -->
  <div
    class="[&_[data-cell]]:font-display relative w-max [--ms-cell:min(3.75rem,calc((100vw-2.5rem-var(--ms-cols)*1px)/var(--ms-cols)))] [&_[data-cell]]:text-2xl [&_[data-cell]_svg]:size-6"
    style="--ms-cols: {board.width};"
  >
    <div
      role="presentation"
      class="grid w-max gap-px"
      style="grid-template-columns: repeat({board.width}, var(--ms-cell));"
      aria-label={m.minesweeper_tutorial_grid_label()}
      onclick={handleClick}
      oncontextmenu={handleContextMenu}
      onpointerdown={handlePointerDown}
      onpointerup={clearLongPress}
      onpointercancel={clearLongPress}
      onpointerleave={clearLongPress}
    >
      {#each views.views as cell, i (i)}
        <MinesweeperCell
          {cell}
          index={i}
          pending={false}
          highlight={reading[i] ?? (unknown[i] || opened[i] ? 'unknown' : far[i] ? 'far' : null)}
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

  <!-- The gestures, said once and kept quiet (owner, 2026-11-27: the mode buttons were too prominent). -->
  <p
    class="text-text-muted flex flex-wrap items-center justify-center gap-x-2 text-xs"
    data-testid="tutorial-gestures"
  >
    <span>{gestures}</span>
    <Button
      variant="bare"
      class="text-accent-text font-semibold hover:underline"
      onclick={onInvert}
      data-testid="tutorial-invert"
    >
      {m.minesweeper_controls_invert()}
    </Button>
  </p>
</div>
