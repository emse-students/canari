<script lang="ts">
  /**
   * THE MINESWEEPER TUTORIAL, `/games/tutorial` (owner, 2026-11-25: the barrier to entry was too high). One
   * lesson at a time on a playable mini-grid: the gestures (open, flag, chord), then the patterns the regulars
   * read at a glance (1-1, 1-2-1, 1-2-2-1). The "Indice" button walks through the reasoning of the lesson,
   * ringing the numbers it reads and tinting the cells they speak about. docs/wiki/frontend/modules/minesweeper.md
   */
  import { resolve } from '$app/paths';
  import { Lightbulb, RotateCcw } from '@lucide/svelte';
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import MinesweeperMiniGrid from '$lib/components/games/MinesweeperMiniGrid.svelte';
  import { LESSONS } from '$lib/minesweeper/tutorial/lessons';
  import { m } from '$lib/paraglide/messages';

  type Outcome = 'playing' | 'solved' | 'lost';

  /** The lesson on screen; one past the last is the closing screen. */
  let index = $state(0);
  /** Bumped by a restart and by a lesson change, so the mini-grid is a new component each time. */
  let attempt = $state(0);
  /** The step of the lesson's hints being shown, or null. */
  let hintStep = $state<number | null>(null);
  let outcome = $state<Outcome>('playing');

  const lesson = $derived(index < LESSONS.length ? LESSONS[index] : null);

  function reset() {
    attempt += 1;
    hintStep = null;
    outcome = 'playing';
  }

  function go(to: number) {
    index = Math.max(0, Math.min(LESSONS.length, to));
    reset();
  }

  /** Shows the first hint, then the next one, then hides them. */
  function nextHint() {
    if (!lesson) return;
    hintStep = hintStep === null ? 0 : hintStep + 1 < lesson.hints.length ? hintStep + 1 : null;
  }
</script>

<PageContainer width="reading">
  <PageHeader
    title={m.minesweeper_tutorial_title()}
    subtitle={m.minesweeper_tutorial_subtitle()}
    backHref={resolve('/games')}
    backLabel={m.games_page_title()}
  />

  {#if lesson}
    <section class="border-cn-border bg-cn-surface space-y-4 rounded-2xl border p-4">
      <p class="text-text-muted text-sm font-semibold" data-testid="tutorial-progress">
        {m.minesweeper_tutorial_lesson_n({
          n: String(index + 1),
          total: String(LESSONS.length),
        })}
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
    <section
      class="border-cn-border bg-cn-surface space-y-3 rounded-2xl border p-4"
      data-testid="tutorial-finish"
    >
      <h2 class="text-text-main text-lg font-bold">{m.minesweeper_tutorial_finish_title()}</h2>
      <p class="text-text-main text-sm">{m.minesweeper_tutorial_finish_body()}</p>
      <div class="flex flex-wrap items-center gap-2">
        <Button href={resolve('/games/play')}>{m.minesweeper_tutorial_play()}</Button>
        <Button variant="ghost" onclick={() => go(0)}>{m.minesweeper_tutorial_restart()}</Button>
      </div>
    </section>
  {/if}
</PageContainer>
