<script lang="ts">
  import { fly, fade } from 'svelte/transition';
  import { Check } from '@lucide/svelte';
  import { resolve } from '$app/paths';
  import Button from '$lib/components/ui/Button.svelte';
  import { PLAY_MODES, type PlayMode } from '$lib/minesweeper/levels';
  import { playModeDescription, playModeIcon, playModeLabel } from '$lib/minesweeper/modeLabels';
  import { m } from '$lib/paraglide/messages';

  /**
   * THE MODE SHEET (owner, 2026-11-26, picked from four designs): ONE list for what used to be a Classe /
   * Libre toggle AND a level chip that cycled without showing what it cycled through. Four choices, each
   * with a line on what it is, and the way to the tutorial. Opened from the pastille of the bottom bar,
   * before the first cell - after it the mode is decided (a ranked game's board is generated for a challenge),
   * so the pastille only reminds and this sheet is never opened.
   */
  interface Props {
    /** The mode of the game about to start. */
    current: PlayMode;
    /** A pick: the sheet closes itself through the caller. */
    onChoose: (mode: PlayMode) => void;
    onClose: () => void;
    /** Length of the sheet's own motion, the game's animation setting applied (0 = none). */
    durationMs: number;
  }

  let { current, onChoose, onClose, durationMs }: Props = $props();
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === 'Escape') onClose();
  }}
/>

<div class="absolute inset-0 z-30" data-testid="mode-sheet">
  <!-- The scrim is a way out for a pointer; the keyboard has Escape and the close below. -->
  <div
    role="presentation"
    class="absolute inset-0 bg-black/40"
    onclick={onClose}
    transition:fade={{ duration: durationMs }}
  ></div>

  <div
    role="dialog"
    aria-modal="true"
    aria-label={m.minesweeper_mode_sheet_title()}
    class="bg-cn-surface absolute inset-x-0 bottom-0 flex flex-col gap-1 rounded-t-2xl p-3 pb-[calc(var(--safe-area-inset-bottom,0px)+0.75rem)] shadow-2xl"
    transition:fly={{ y: 48, duration: durationMs }}
  >
    <h2 class="text-cn-dark px-2 pt-1 pb-2 text-base font-semibold">
      {m.minesweeper_mode_sheet_title()}
    </h2>

    <div
      role="radiogroup"
      aria-label={m.minesweeper_mode_sheet_title()}
      class="flex flex-col gap-1"
    >
      {#each PLAY_MODES as mode (mode)}
        {@const Glyph = playModeIcon(mode)}
        {@const selected = mode === current}
        <Button
          variant="bare"
          role="radio"
          aria-checked={selected}
          data-mode={mode}
          onclick={() => onChoose(mode)}
          class="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left transition-colors {selected
            ? 'bg-accent/15'
            : 'hover:bg-cn-bg'}"
        >
          <Glyph size={20} strokeWidth={2.25} class="text-cn-dark shrink-0" />
          <span class="min-w-0 flex-1">
            <span class="text-text-main block text-sm font-semibold">{playModeLabel(mode)}</span>
            <span class="text-text-muted block text-xs">{playModeDescription(mode)}</span>
          </span>
          {#if selected}
            <Check size={18} strokeWidth={2.5} class="text-accent-text shrink-0" />
          {/if}
        </Button>
      {/each}
    </div>

    <div class="flex items-center justify-between gap-2 px-2 pt-2">
      <a
        href={resolve('/games/tutorial')}
        class="text-accent-text text-sm font-semibold hover:underline"
      >
        {m.minesweeper_mode_tutorial()}
      </a>
      <Button variant="ghost" size="compact" onclick={onClose}>{m.minesweeper_close()}</Button>
    </div>
  </div>
</div>
