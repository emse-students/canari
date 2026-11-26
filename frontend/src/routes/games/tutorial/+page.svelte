<script lang="ts">
  /**
   * THE MINESWEEPER TUTORIAL, `/games/tutorial` (owner, 2026-11-25: the barrier to entry was too high). One
   * lesson at a time on a playable mini-grid: the gestures (open, flag, chord, the counter), then the
   * patterns the regulars read at a glance. The "Indice" button walks through the reasoning of the lesson,
   * ringing the numbers it reads and outlining what they conclude. The pattern CATALOGUE is its annex
   * (`/games/tutorial/patterns`). docs/wiki/frontend/modules/minesweeper.md
   */
  import { resolve } from '$app/paths';
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import MinesweeperLessonRunner from '$lib/components/games/MinesweeperLessonRunner.svelte';
  import { LESSONS } from '$lib/minesweeper/tutorial/lessons';
  import { m } from '$lib/paraglide/messages';
</script>

<PageContainer width="reading">
  <PageHeader
    title={m.minesweeper_tutorial_title()}
    subtitle={m.minesweeper_tutorial_subtitle()}
    backHref={resolve('/games')}
    backLabel={m.games_page_title()}
  >
    {#snippet actions()}
      <Button href={resolve('/games/tutorial/patterns')} variant="secondary" size="compact">
        {m.minesweeper_patterns_open()}
      </Button>
    {/snippet}
  </PageHeader>

  <MinesweeperLessonRunner lessons={LESSONS}>
    {#snippet finish({ restart })}
      <section
        class="border-cn-border bg-cn-surface space-y-3 rounded-2xl border p-4"
        data-testid="tutorial-finish"
      >
        <h2 class="text-text-main text-lg font-bold">{m.minesweeper_tutorial_finish_title()}</h2>
        <p class="text-text-main text-sm">{m.minesweeper_tutorial_finish_body()}</p>
        <div class="flex flex-wrap items-center gap-2">
          <Button href={resolve('/games/play')}>{m.minesweeper_tutorial_play()}</Button>
          <Button href={resolve('/games/tutorial/patterns')} variant="secondary">
            {m.minesweeper_patterns_open()}
          </Button>
          <Button variant="ghost" onclick={restart}>{m.minesweeper_tutorial_restart()}</Button>
        </div>
      </section>
    {/snippet}
  </MinesweeperLessonRunner>
</PageContainer>
