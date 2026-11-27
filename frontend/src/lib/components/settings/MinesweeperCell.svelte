<script lang="ts">
  import { Bomb, Flag } from '@lucide/svelte';
  import type { Cell } from '$lib/minesweeper/game';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** The view object of this cell: replaced (never mutated) when what is drawn changes. */
    cell: Cell;
    /** Index in the board, read back by the grid's delegated handlers through `data-cell`. */
    index: number;
    /** The cell whose first dig is being prepared: shown pressed until the board exists. */
    pending: boolean;
    /** Ringed: the cell the last action of a replay landed on. */
    marked?: boolean;
    /**
     * Lit by the bulb of an unranked game: `hint` a number to read, `wrong` a misplaced flag
     * (`hint.ts`); by the tutorial, `read` the number its explanation is reading (a dark ring, so the
     * yellow of a group of cells is never confused with it), `far` a cell the picture only suggests (an open
     * grid's unimportant cells: dotted, faded, not playable), `unknown` an open cell whose number the picture
     * hides (drawn "?", so no other reasoning than the pattern's is possible). Null otherwise; a primitive, so
     * only the cells whose value changed re-render.
     */
    highlight?: 'hint' | 'wrong' | 'read' | 'far' | 'unknown' | null;
  }

  let { cell, index, pending, marked = false, highlight = null }: Props = $props();

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
      ? 'bg-cn-bg ms-pending'
      : cell.state !== 'revealed'
        ? highlight === 'far'
          ? 'bg-transparent'
          : 'ms-hidden'
        : cell.mine
          ? 'bg-red-600'
          : 'bg-cn-surface dark:bg-cn-bg'
  );
  /**
   * ONE ring per cell: the bulb's highlight wins over the replay's `marked` ring, so a cell lit by both
   * reads as the hint and never as two rings stacked on each other.
   */
  const ring = $derived(
    highlight === 'hint'
      ? 'ms-hint ring-accent ring-2 ring-inset'
      : highlight === 'wrong'
        ? 'ms-hint ms-hint-wrong ring-red-err ring-2 ring-inset'
        : highlight === 'read'
          ? 'ring-text-main ring-2 ring-inset'
          : highlight === 'far'
            ? 'border-text-muted/60 border border-dashed opacity-60'
            : marked
              ? 'ring-accent ring-2 ring-inset'
              : ''
  );
  /** What a screen reader hears for a lit cell: the ring alone says nothing to it. */
  const hintLabel = $derived(
    highlight === 'hint'
      ? m.minesweeper_hint_cell({ n: String(cell.adjacent) })
      : highlight === 'wrong'
        ? m.minesweeper_hint_wrong_cell()
        : highlight === 'read'
          ? m.minesweeper_tutorial_read_cell({ n: String(cell.adjacent) })
          : highlight === 'far'
            ? m.minesweeper_tutorial_far_cell()
            : highlight === 'unknown'
              ? m.minesweeper_tutorial_unknown_cell()
              : undefined
  );
  const numberColor = $derived(
    highlight === 'unknown'
      ? 'text-text-muted'
      : cell.state === 'revealed' && !cell.mine && cell.adjacent > 0
        ? NUMBER_COLORS[cell.adjacent]
        : ''
  );
</script>

<button
  type="button"
  data-cell={index}
  class="box-border flex h-[length:var(--ms-cell)] w-[length:var(--ms-cell)] shrink-0 touch-manipulation items-center justify-center rounded-md font-mono text-xs font-bold select-none sm:text-sm {tone} {numberColor} {ring}"
  data-hint={highlight ?? undefined}
  aria-label={hintLabel}
>
  {#if highlight === 'unknown'}
    ?
  {:else if cell.state === 'flagged'}
    <Flag size={14} class="dark:text-accent-icon text-accent-text" />
  {:else if cell.state === 'revealed' && cell.mine}
    <Bomb size={14} class="text-white" />
  {:else if cell.state === 'revealed' && cell.adjacent > 0}
    {cell.adjacent}
  {/if}
</button>

<style>
  /*
   * Every `button` gets a 180 ms crossfade of its colours from the base layer of app.css, and a cell is
   * a button: a dug cell faded from hidden to revealed whatever the player chose. Only the DURATION is
   * taken here (the properties stay the base layer's), scaled by the animation speed the modal sets in
   * `--ms-anim`, so "none" makes a dig instant.
   */
  button {
    transition-duration: calc(180ms * var(--ms-anim, 1));
  }

  /*
   * The pressed first-dig cell pulses at Tailwind's own rhythm (2 s) scaled by the player's animation
   * speed (`--ms-anim`, set on the modal). A factor of 0 makes the duration zero, which ends the
   * infinite animation at once - the "off" setting.
   */
  @keyframes ms-pending-pulse {
    50% {
      opacity: 0.5;
    }
  }

  .ms-pending {
    animation: ms-pending-pulse calc(2s * var(--ms-anim, 1)) cubic-bezier(0.4, 0, 0.6, 1) infinite;
  }

  /*
   * The bulb's highlight: the ring stays, and a glow in the ring's own colour breathes around it so
   * the eye finds the cell on a board of 576. Scaled by `--ms-anim` like the rest; at "none" the
   * duration is zero, the animation ends at once and only the ring is left. The glow is a `filter`, not
   * a `box-shadow`: Tailwind draws the ring WITH box-shadow, which the glow would erase. Lifted above
   * its neighbours, which the grid paints after it.
   */
  @keyframes ms-hint-glow {
    50% {
      filter: drop-shadow(0 0 calc(var(--spacing) * 1.5) var(--ms-glow));
    }
  }

  .ms-hint {
    --ms-glow: color-mix(in srgb, var(--accent) 70%, transparent);
    position: relative;
    z-index: 1;
    animation: ms-hint-glow calc(1.6s * var(--ms-anim, 1)) ease-in-out infinite;
  }

  .ms-hint-wrong {
    --ms-glow: color-mix(in srgb, var(--red-err) 70%, transparent);
  }

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
