<script lang="ts">
  import { untrack } from 'svelte';
  import {
    closeHistoryOverlayFromUi,
    pushHistoryOverlay,
    releaseHistoryOverlay,
  } from '$lib/utils/historyOverlayStack';
  import { fade, scale } from 'svelte/transition';
  import { Trophy, X } from '@lucide/svelte';
  import { resolve } from '$app/paths';
  import Button from '$lib/components/ui/Button.svelte';
  import LePic from '$lib/components/games/LePic.svelte';
  import MinerLamp from '$lib/components/games/MinerLamp.svelte';
  import { focusTrap } from '$lib/actions/focusTrap.svelte';
  import { rovingTarget } from '$lib/components/ui/rovingFocus';
  import { CHALLENGE } from '$lib/minesweeper/game';
  import { LEVELS, type MinesweeperLevel, type PlayMode } from '$lib/minesweeper/levels';
  import { levelLabel } from '$lib/minesweeper/modeLabels';
  import { m } from '$lib/paraglide/messages';

  /**
   * THE GAME MODE MODAL, "Nouvelle partie" (owner, 2026-11-27): ONE centered chooser, replacing the bottom sheet
   * of the four modes. Two big cards - "Classé" (timed and ranked, no hint) and "Entraînement" (hints allowed,
   * nothing counted) - the three levels under Entraînement, a "Jouer" button that commits, and the way to the
   * tutorial. It opens by itself when a game is launched (`askMode`, set by the `/games/play` route); afterwards, and any time, the pastille
   * of the bottom bar opens this same modal. The game's own stored settings are written by the caller, exactly
   * as before (`canari.minesweeper.unranked` and `.level`): this component only chooses.
   * docs/wiki/frontend/modules/minesweeper.md, "The game mode modal"
   */
  interface Props {
    /** The mode of the game about to start: where the choice begins. */
    current: PlayMode;
    /** The level Entraînement plays at, when it is picked (the stored one). */
    level: MinesweeperLevel;
    /** "Jouer": the chosen mode, the ranked game or an unranked level. */
    onPlay: (mode: PlayMode) => void;
    /** Escape, the scrim or the close button: nothing is chosen. */
    onClose: () => void;
    /** Length of the modal's own motion, the game's animation setting applied (0 = none). */
    durationMs: number;
  }

  let { current, level, onPlay, onClose, durationMs }: Props = $props();

  type Kind = 'ranked' | 'training';

  /** The draft starts at the mode the game is in; it is read ONCE, the modal is mounted per opening. */
  let kind = $state<Kind>(untrack(() => (current === 'ranked' ? 'ranked' : 'training')));
  let picked = $state<MinesweeperLevel>(untrack(() => (current === 'ranked' ? level : current)));

  /** What "Jouer" commits: ranked, or the level picked under Entraînement. */
  const chosen = $derived<PlayMode>(kind === 'ranked' ? 'ranked' : picked);

  /**
   * THE ANDROID BACK KEY CLOSES THE MODAL, NOT THE GAME (reading of the mode sheet, Mi 9T, 2026-11-27): the modal
   * takes a history entry like every other overlay (`historyOverlayStack`, as `shared/Modal` does), so a Back press pops
   * it and calls `onClose` instead of leaving `/games/play`. The entry is released when the modal goes, whoever closed it.
   */
  let historyClose: (() => void) | null = null;
  $effect(() => {
    const entry = () => onClose();
    historyClose = entry;
    pushHistoryOverlay(entry);
    return () => {
      releaseHistoryOverlay(entry);
      historyClose = null;
    };
  });

  /** Escape, the scrim and the cross: closed through the stack so the entry is released with it. */
  function dismiss() {
    if (historyClose) closeHistoryOverlayFromUi(historyClose);
    else onClose();
  }

  /**
   * THE ARROW KEYS OF A RADIO GROUP: roving tabindex (only the checked radio is a tab stop) and the arrows move AND
   * select, wrapping, as `rovingTarget` does for every group in the app.
   */
  function roving(e: KeyboardEvent) {
    const el = e.currentTarget as HTMLElement;
    const group = [...(el.parentElement?.querySelectorAll<HTMLElement>('[role="radio"]') ?? [])];
    const next = rovingTarget(e.key, group.indexOf(el), group.length);
    if (next < 0) return;
    e.preventDefault();
    group[next].focus();
    group[next].click();
  }

  function pickKind(next: Kind) {
    kind = next;
  }

  function play() {
    console.debug('[minesweeper] mode modal: play', { mode: chosen });
    onPlay(chosen);
  }
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === 'Escape') dismiss();
  }}
/>

<div class="absolute inset-0 z-30 flex items-center justify-center p-4" data-testid="mode-modal">
  <!-- The scrim is a way out for a pointer; the keyboard has Escape and the close button. -->
  <div
    role="presentation"
    class="bg-cn-scrim/55 absolute inset-0"
    onclick={dismiss}
    transition:fade={{ duration: durationMs }}
  ></div>

  <div
    role="dialog"
    aria-modal="true"
    aria-label={m.minesweeper_modal_title()}
    use:focusTrap={{ initial: '[role="radio"][aria-checked="true"]' }}
    class="bg-cn-surface relative flex max-h-full w-full max-w-sm flex-col gap-4 overflow-y-auto rounded-3xl p-4 shadow-2xl"
    transition:scale={{ start: 0.96, duration: durationMs }}
  >
    <div class="flex items-center gap-3">
      <LePic size={56} mood="happy" pose="rest" />
      <div class="min-w-0 flex-1">
        <h2 class="font-display text-text-main text-xl font-bold">{m.minesweeper_modal_title()}</h2>
        <p class="text-text-muted text-sm">{m.minesweeper_modal_subtitle()}</p>
      </div>
      <Button
        variant="ghost"
        icon
        onclick={dismiss}
        aria-label={m.minesweeper_close()}
        class="self-start"
      >
        <X size={20} />
      </Button>
    </div>

    <div
      role="radiogroup"
      aria-label={m.minesweeper_modal_kind_label()}
      class="grid grid-cols-2 gap-2.5"
    >
      <Button
        variant="bare"
        role="radio"
        aria-checked={kind === 'ranked'}
        tabindex={kind === 'ranked' ? 0 : -1}
        onkeydown={roving}
        data-mode="ranked"
        onclick={() => pickKind('ranked')}
        class="flex flex-col items-center gap-1.5 rounded-2xl border-2 px-2.5 py-3.5 text-center {kind ===
        'ranked'
          ? 'border-accent bg-accent/15'
          : 'border-cn-border bg-cn-surface'}"
      >
        <Trophy size={34} strokeWidth={2} class="text-accent-icon" />
        <span class="font-display text-text-main text-lg font-bold">{m.minesweeper_ranked()}</span>
        <span class="text-text-muted text-xs">{m.minesweeper_mode_ranked_desc()}</span>
      </Button>
      <Button
        variant="bare"
        role="radio"
        aria-checked={kind === 'training'}
        tabindex={kind === 'training' ? 0 : -1}
        onkeydown={roving}
        data-mode="training"
        onclick={() => pickKind('training')}
        class="flex flex-col items-center gap-1.5 rounded-2xl border-2 px-2.5 py-3.5 text-center {kind ===
        'training'
          ? 'border-accent bg-accent/15'
          : 'border-cn-border bg-cn-surface'}"
      >
        <MinerLamp lit size={34} />
        <span class="font-display text-text-main text-lg font-bold">
          {m.minesweeper_training()}
        </span>
        <span class="text-text-muted text-xs">{m.minesweeper_mode_training_desc()}</span>
      </Button>
    </div>

    {#if kind === 'training'}
      <div class="flex flex-col gap-1.5">
        <span class="text-text-muted text-xs font-bold">{m.minesweeper_modal_level_label()}</span>
        <div
          role="radiogroup"
          aria-label={m.minesweeper_modal_level_label()}
          class="bg-cn-bg grid grid-cols-3 gap-1 rounded-full p-1"
        >
          {#each LEVELS as lvl (lvl)}
            <Button
              variant="bare"
              role="radio"
              aria-checked={picked === lvl}
              tabindex={picked === lvl ? 0 : -1}
              onkeydown={roving}
              data-level={lvl}
              onclick={() => (picked = lvl)}
              class="min-h-9 rounded-full px-1 text-xs font-bold {picked === lvl
                ? 'bg-cn-surface text-text-main shadow-sm'
                : 'text-text-muted'}"
            >
              {levelLabel(lvl)}
            </Button>
          {/each}
        </div>
      </div>
    {:else}
      <p
        class="bg-accent/15 text-text-main rounded-lg px-3 py-2.5 text-xs font-semibold"
        data-testid="mode-ranked-note"
      >
        {m.minesweeper_modal_ranked_note({
          cols: String(CHALLENGE.width),
          rows: String(CHALLENGE.height),
          mines: String(CHALLENGE.mineCount),
        })}
      </p>
    {/if}

    <Button
      onclick={play}
      class="font-display min-h-14 w-full text-xl font-bold"
      data-testid="mode-play"
    >
      {m.minesweeper_modal_play()}
    </Button>
    <p class="text-text-muted text-center text-xs">{m.minesweeper_modal_change_later()}</p>
    <a
      href={resolve('/games/tutorial')}
      class="text-accent-text self-center py-1 text-sm font-semibold hover:underline"
    >
      {m.minesweeper_modal_tutorial()}
    </a>
  </div>
</div>
