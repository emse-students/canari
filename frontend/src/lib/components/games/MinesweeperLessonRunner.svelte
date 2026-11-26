<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Lightbulb, RotateCcw } from '@lucide/svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Select from '$lib/components/ui/Select.svelte';
  import type { PickerOption } from '$lib/components/ui/picker';
  import MinesweeperMiniGrid from '$lib/components/games/MinesweeperMiniGrid.svelte';
  import type { Lesson } from '$lib/minesweeper/tutorial/lessons';
  import { m } from '$lib/paraglide/messages';

  /**
   * THE LESSON READER shared by the tutorial and its annex, the pattern catalogue (owner, 2026-11-26): one
   * lesson at a time on a playable mini-grid, an "Indice" button that walks the explanation, a restart, and
   * the way to the neighbours. The closing screen is the caller's (`finish`). A list too long to walk with
   * "next" - the catalogue - also offers a jump, grouped by the lessons' `section`.
   * docs/wiki/frontend/modules/minesweeper.md
   */
  interface Props {
    lessons: readonly Lesson[];
    /** What follows the last lesson; `restart` goes back to the first. */
    finish: Snippet<[{ restart: () => void }]>;
    /** Offers a "jump to" list of every lesson, grouped by section. */
    jump?: boolean;
  }

  let { lessons, finish, jump = false }: Props = $props();

  type Outcome = 'playing' | 'solved' | 'lost';

  /** The lesson on screen; one past the last is the closing screen. */
  let index = $state(0);
  /** Bumped by a restart and by a lesson change, so the mini-grid is a new component each time. */
  let attempt = $state(0);
  /** The step of the lesson's hints being shown, or null. */
  let hintStep = $state<number | null>(null);
  let outcome = $state<Outcome>('playing');

  const lesson = $derived(index < lessons.length ? lessons[index] : null);
  /** The family a catalogue entry belongs to, then a separator: a string, so no whitespace is lost in markup. */
  const sectionPrefix = $derived(lesson?.section ? `${lesson.section()} · ` : '');

  function reset() {
    attempt += 1;
    hintStep = null;
    outcome = 'playing';
  }

  function go(to: number) {
    index = Math.max(0, Math.min(lessons.length, to));
    reset();
  }

  /** Shows the first hint, then the next one, then hides them. */
  function nextHint() {
    if (!lesson) return;
    hintStep = hintStep === null ? 0 : hintStep + 1 < lesson.hints.length ? hintStep + 1 : null;
  }

  /** The jump list: every lesson, under the heading of its section. */
  const options = $derived<PickerOption[]>(
    lessons.map((l, i) => ({ value: String(i), label: l.title(), group: l.section?.() }))
  );
</script>

{#if lesson}
  <section class="border-cn-border bg-cn-surface space-y-4 rounded-2xl border p-4">
    {#if jump}
      <Select
        label={m.minesweeper_patterns_jump()}
        value={String(index)}
        {options}
        onValueChange={(v) => go(Number(v))}
      />
    {/if}
    <p class="text-text-muted text-sm font-semibold" data-testid="tutorial-progress">
      {sectionPrefix}{jump
        ? m.minesweeper_patterns_n({ n: String(index + 1), total: String(lessons.length) })
        : m.minesweeper_tutorial_lesson_n({ n: String(index + 1), total: String(lessons.length) })}
    </p>
    <h2 class="text-text-main text-lg font-bold">{lesson.title()}</h2>
    <p class="text-text-main text-sm">{lesson.body()}</p>

    {#key `${lesson.id}-${attempt}`}
      <MinesweeperMiniGrid
        {lesson}
        {hintStep}
        onSolved={() => (outcome = 'solved')}
        onLost={() => (outcome = 'lost')}
      />
    {/key}

    <div class="min-h-12" role="status" aria-live="polite">
      {#if outcome === 'solved'}
        <p class="text-green-ok text-sm font-semibold" data-testid="tutorial-solved">
          {m.minesweeper_tutorial_solved()}
        </p>
      {:else if outcome === 'lost'}
        <p class="text-red-err text-sm font-semibold" data-testid="tutorial-lost">
          {m.minesweeper_tutorial_lost()}
        </p>
      {:else if hintStep !== null}
        <p
          class="bg-accent/10 text-text-main rounded-lg px-3 py-2 text-sm"
          data-testid="tutorial-hint"
        >
          {lesson.hints[hintStep].text()}
        </p>
        <!-- What the three outlines mean: the colour is the whole message, so it is said once. -->
        <ul
          class="text-text-muted mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs"
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
      {/if}
    </div>

    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        {#if outcome === 'playing'}
          <Button variant="secondary" size="compact" onclick={nextHint}>
            <Lightbulb size={16} strokeWidth={2.25} />
            {hintStep === null
              ? m.minesweeper_tutorial_hint_button()
              : hintStep + 1 < lesson.hints.length
                ? m.minesweeper_tutorial_hint_next()
                : m.minesweeper_tutorial_hint_hide()}
          </Button>
        {/if}
        <Button variant="ghost" size="compact" onclick={reset}>
          <RotateCcw size={16} strokeWidth={2.25} />
          {m.minesweeper_tutorial_restart()}
        </Button>
      </div>
      <div class="flex items-center gap-2">
        {#if index > 0}
          <Button variant="ghost" size="compact" onclick={() => go(index - 1)}>
            {m.minesweeper_tutorial_prev()}
          </Button>
        {/if}
        <Button
          variant={outcome === 'solved' ? 'primary' : 'secondary'}
          size="compact"
          onclick={() => go(index + 1)}
        >
          {m.minesweeper_tutorial_next()}
        </Button>
      </div>
    </div>
  </section>
{:else}
  {@render finish({ restart: () => go(0) })}
{/if}
