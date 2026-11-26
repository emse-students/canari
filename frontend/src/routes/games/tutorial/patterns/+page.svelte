<script lang="ts">
  /**
   * THE PATTERN CATALOGUE, `/games/tutorial/patterns` - the tutorial's ANNEX (owner, 2026-11-26: *"reprend
   * leurs explications pour tous les patterns dans un tutoriel annexe"*). Every named pattern of the
   * reference catalogue (minesweeper.online), one playable mini-grid each, listed by family, with the
   * reduction of a number by its flags. The boards are ours and each is proved by enumeration.
   * docs/wiki/frontend/modules/minesweeper.md, "The pattern catalogue"
   */
  import { resolve } from '$app/paths';
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import MinesweeperLessonRunner from '$lib/components/games/MinesweeperLessonRunner.svelte';
  import { PATTERNS } from '$lib/minesweeper/tutorial/patterns';
  import { m } from '$lib/paraglide/messages';
</script>

<PageContainer width="reading">
  <PageHeader
    title={m.minesweeper_patterns_title()}
    subtitle={m.minesweeper_patterns_subtitle()}
    backHref={resolve('/games/tutorial')}
    backLabel={m.minesweeper_tutorial_title()}
  />

  <MinesweeperLessonRunner lessons={PATTERNS} jump>
    {#snippet finish({ restart })}
      <section
        class="border-cn-border bg-cn-surface space-y-3 rounded-2xl border p-4"
        data-testid="patterns-finish"
      >
        <h2 class="text-text-main text-lg font-bold">{m.minesweeper_patterns_finish_title()}</h2>
        <p class="text-text-main text-sm">{m.minesweeper_patterns_finish_body()}</p>
        <div class="flex flex-wrap items-center gap-2">
          <Button href={resolve('/games/play')}>{m.minesweeper_tutorial_play()}</Button>
          <Button variant="ghost" onclick={restart}>{m.minesweeper_tutorial_restart()}</Button>
        </div>
      </section>
    {/snippet}
  </MinesweeperLessonRunner>
</PageContainer>
