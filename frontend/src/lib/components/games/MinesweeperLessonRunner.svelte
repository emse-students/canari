<script lang="ts">
  import { ChevronRight, RotateCcw } from '@lucide/svelte';
  import { resolve } from '$app/paths';
  import Button from '$lib/components/ui/Button.svelte';
  import LePic, { type PicMood, type PicPose } from '$lib/components/games/LePic.svelte';
  import MinerLamp from '$lib/components/games/MinerLamp.svelte';
  import MinesweeperMiniGrid from '$lib/components/games/MinesweeperMiniGrid.svelte';
  import { countDone, shortName, type LessonPlace } from '$lib/minesweeper/tutorial/path';
  import {
    markLampUsed,
    markLessonDone,
    loadTutorialProgress,
  } from '$lib/minesweeper/tutorial/progress';
  import { m } from '$lib/paraglide/messages';

  /**
   * ONE LESSON OF THE TUTORIAL, as a screen (owner, 2026-11-27): Le Pic beside a speech bubble that says the
   * goal and then each step of the lamp, the playable mini-grid with its marks, the legend of the three
   * colours, and a bottom bar - restart, the miner's lamp, skip. Solving the lesson (the mini-grid says so,
   * once) records it as done on this device and shows the solved screen. The lessons and their proofs are
   * `lessons.ts` / `patterns.ts`, untouched: this is only how one is read.
   * docs/wiki/frontend/modules/minesweeper.md, "The tutorial path"
   */
  interface Props {
    place: LessonPlace;
  }

  let { place }: Props = $props();

  type Outcome = 'playing' | 'solved' | 'lost';

  const lesson = $derived(place.lesson);
  /** Bumped by a restart, so the mini-grid is a new component each time. */
  let attempt = $state(0);
  /** The step of the lesson's hints being shown, or null. */
  let hintStep = $state<number | null>(null);
  let outcome = $state<Outcome>('playing');
  let progress = $state(loadTutorialProgress());

  const done = $derived(new Set(progress.done));
  const familyTotal = $derived(place.family.lessons.length);
  const familyDone = $derived(countDone(place.family.lessons, done));
  const stepCount = $derived(lesson.hints.length);
  const lastStep = $derived(hintStep !== null && hintStep + 1 >= stepCount);
  /** The lamp pulses until it was pressed once on this device. */
  const pulse = $derived(hintStep === null && !progress.lampUsed);
  const isPattern = $derived(place.tab === 'patterns');

  /** What Le Pic does: thinks at the start, points while he explains, is glad when the safe cell is shown. */
  const mood = $derived<PicMood>(
    outcome === 'lost' ? 'worried' : hintStep === null ? 'think' : lastStep ? 'happy' : 'neutral'
  );
  const pose = $derived<PicPose>(hintStep === null || outcome === 'lost' ? 'rest' : 'point');

  function restart() {
    console.debug('[minesweeper] lesson restarted', { id: lesson.id });
    attempt += 1;
    hintStep = null;
    outcome = 'playing';
  }

  /** Lights the first step, then the next one, then hides them. */
  function nextHint() {
    if (hintStep === null && !progress.lampUsed) progress = markLampUsed();
    hintStep = hintStep === null ? 0 : hintStep + 1 < stepCount ? hintStep + 1 : null;
    console.debug('[minesweeper] lamp pressed', { id: lesson.id, step: hintStep });
  }

  /** The mini-grid says the goal is met: recorded once, then the solved screen. */
  function solved() {
    progress = markLessonDone(lesson.id);
    outcome = 'solved';
  }

  const hintLabel = $derived(
    hintStep === null
      ? m.minesweeper_tutorial_hint_button()
      : hintStep + 1 < stepCount
        ? m.minesweeper_tutorial_hint_next()
        : m.minesweeper_tutorial_hint_hide()
  );

  const nextHref = $derived(
    place.next ? resolve('/games/tutorial/[id]', { id: place.next.id }) : resolve('/games/tutorial')
  );
</script>

{#if outcome === 'solved'}
  <section
    class="bg-cn-surface flex flex-col items-center gap-4 rounded-2xl p-4 text-center"
    data-testid="tutorial-solved"
  >
    <LePic size={160} mood="happy" pose="flag" />
    <span
      class="bg-accent text-on-accent font-display rounded-full px-3 py-1 text-base font-bold"
      data-testid="tutorial-solved-name"
    >
      {shortName(lesson.title())}
    </span>
    <h2 class="font-display text-text-main text-2xl font-bold">
      {isPattern ? m.minesweeper_done_title_pattern() : m.minesweeper_done_title_lesson()}
    </h2>
    <p class="text-text-muted text-sm" data-testid="tutorial-solved-line">
      {lesson.hints.at(-1)?.text()}
    </p>

    <div class="bg-cn-bg w-full space-y-2 rounded-2xl p-3 text-left">
      <div class="flex items-center justify-between text-sm font-bold">
        <span class="text-text-main">{place.family.label()}</span>
        <span class="text-text-main" data-testid="tutorial-solved-progress">
          {familyDone} / {familyTotal}
        </span>
      </div>
      <div
        class="bg-cn-surface h-2.5 overflow-hidden rounded-full"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={familyTotal}
        aria-valuenow={familyDone}
        aria-label={place.family.label()}
      >
        <div
          class="bg-green-ok h-full rounded-full"
          style:width="{(familyDone / familyTotal) * 100}%"
        ></div>
      </div>
      <p class="text-text-muted text-xs">
        {familyDone >= familyTotal
          ? m.minesweeper_done_family_complete()
          : m.minesweeper_done_remaining({ n: String(familyTotal - familyDone) })}
      </p>
    </div>

    <div class="flex w-full flex-col gap-2">
      {#if place.next}
        <Button href={nextHref} class="w-full" data-testid="tutorial-solved-next">
          {isPattern
            ? m.minesweeper_done_next_pattern({ name: shortName(place.next.title()) })
            : m.minesweeper_done_next_lesson({ name: shortName(place.next.title()) })}
        </Button>
      {:else}
        <Button href={resolve('/games/play')} class="w-full">
          {m.minesweeper_tutorial_play()}
        </Button>
      {/if}
      <Button href={resolve('/games/tutorial')} variant="ghost" class="w-full">
        {m.minesweeper_lesson_back()}
      </Button>
    </div>
  </section>
{:else}
  <section class="space-y-4">
    <div class="flex items-center gap-3">
      <p class="text-text-muted text-sm font-semibold" data-testid="tutorial-progress">
        {place.family.label()} · {m.minesweeper_lesson_position({
          n: String(place.indexInFamily + 1),
          total: String(familyTotal),
        })}
      </p>
      <div
        class="grid flex-1 gap-1"
        style:grid-template-columns="repeat({familyTotal}, minmax(0, 1fr))"
      >
        {#each place.family.lessons as other, i (other.id)}
          <span
            class="h-1.5 rounded-full {done.has(other.id)
              ? 'bg-green-ok'
              : i === place.indexInFamily
                ? 'bg-accent'
                : 'bg-cn-border'}"
          ></span>
        {/each}
      </div>
    </div>

    <div class="flex items-end gap-2">
      <LePic size={96} {mood} {pose} />
      <div
        class="bg-cn-surface text-text-main relative mb-4 min-h-[4.5rem] flex-1 rounded-2xl px-3.5 py-3 text-sm"
        role="status"
        aria-live="polite"
      >
        <span
          class="bg-cn-surface absolute bottom-4 -left-1.5 size-3 rotate-45 rounded-sm"
          aria-hidden="true"
        ></span>
        {#if outcome === 'lost'}
          <p class="text-red-err font-semibold" data-testid="tutorial-lost">
            {m.minesweeper_tutorial_lost()}
          </p>
        {:else if hintStep !== null}
          <p class="text-text-muted text-xs font-bold">
            {m.minesweeper_lesson_hint_tag({ n: String(hintStep + 1), total: String(stepCount) })}
          </p>
          <p data-testid="tutorial-hint">{lesson.hints[hintStep].text()}</p>
        {:else}
          <p class="text-text-muted text-xs font-bold">
            {m.minesweeper_lesson_goal()}
          </p>
          <p data-testid="tutorial-goal">{lesson.body()}</p>
        {/if}
      </div>
    </div>

    {#key `${lesson.id}-${attempt}`}
      <MinesweeperMiniGrid
        {lesson}
        {hintStep}
        onSolved={solved}
        onLost={() => (outcome = 'lost')}
      />
    {/key}

    <!-- What the three outlines mean: the colour is the whole message, so it is said once, under the grid. -->
    <ul
      class="text-text-muted flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs font-semibold"
      data-testid="tutorial-legend"
    >
      <li class="flex items-center gap-1.5">
        <span class="border-red-err bg-red-err/15 size-3 rounded border-2"></span>
        {m.minesweeper_tutorial_legend_mine()}
      </li>
      <li class="flex items-center gap-1.5">
        <span class="border-accent bg-accent/20 size-3 rounded border-2"></span>
        {m.minesweeper_tutorial_legend_group()}
      </li>
      <li class="flex items-center gap-1.5">
        <span class="border-green-ok bg-green-ok/15 size-3 rounded border-2"></span>
        {m.minesweeper_tutorial_legend_safe()}
      </li>
    </ul>

    <div class="bg-cn-surface flex items-center justify-around gap-2 rounded-2xl px-2 py-3">
      <Button
        variant="bare"
        onclick={restart}
        class="text-text-muted flex w-20 flex-col items-center gap-1.5 text-xs font-bold"
      >
        <RotateCcw size={24} strokeWidth={2.4} />
        {m.minesweeper_tutorial_restart()}
      </Button>

      <Button
        variant="bare"
        onclick={nextHint}
        aria-label={hintLabel}
        data-testid="tutorial-lamp"
        class="flex flex-col items-center gap-1.5"
      >
        <span class="lamp-button" class:lamp-lit={hintStep !== null} class:lamp-pulse={pulse}>
          <MinerLamp lit={hintStep !== null} size={58} />
        </span>
        <span class="text-accent-text text-sm font-bold">{hintLabel}</span>
        <span class="flex gap-1.5" aria-hidden="true">
          {#each lesson.hints as step, i (i)}
            <span
              class="size-2 rounded-full {hintStep !== null && i <= hintStep
                ? 'bg-accent'
                : 'bg-cn-border'}"
            ></span>
          {/each}
        </span>
      </Button>

      <Button
        href={nextHref}
        variant="bare"
        class="text-text-muted flex w-20 flex-col items-center gap-1.5 text-xs font-bold"
        data-testid="tutorial-skip"
      >
        <ChevronRight size={24} strokeWidth={2.4} />
        {m.minesweeper_lesson_skip()}
      </Button>
    </div>
  </section>
{/if}

<style>
  /* THE LAMP BUTTON: a big round yellow disc under the lamp. It pulses a halo until the lamp was used once
     on this device, and glows while a hint is shown. Colours are the app's tokens. */
  .lamp-button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 5.25rem;
    height: 5.25rem;
    border-radius: 999px;
    background: var(--accent);
    box-shadow: 0 0.3rem 0 color-mix(in srgb, var(--accent) 70%, black);
  }
  .lamp-lit {
    box-shadow:
      0 0.3rem 0 color-mix(in srgb, var(--accent) 70%, black),
      0 0 1.75rem 0.375rem color-mix(in srgb, var(--accent) 55%, transparent);
  }
  .lamp-pulse {
    animation: lamp-halo 1.8s ease-out infinite;
  }
  @keyframes lamp-halo {
    0% {
      box-shadow:
        0 0.3rem 0 color-mix(in srgb, var(--accent) 70%, black),
        0 0 0 0 color-mix(in srgb, var(--accent) 65%, transparent);
    }
    70% {
      box-shadow:
        0 0.3rem 0 color-mix(in srgb, var(--accent) 70%, black),
        0 0 0 1.125rem color-mix(in srgb, var(--accent) 0%, transparent);
    }
    100% {
      box-shadow:
        0 0.3rem 0 color-mix(in srgb, var(--accent) 70%, black),
        0 0 0 0 color-mix(in srgb, var(--accent) 0%, transparent);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .lamp-pulse {
      animation: none;
    }
  }
</style>
