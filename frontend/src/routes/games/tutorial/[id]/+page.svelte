<script lang="ts">
  /**
   * ONE LESSON OF THE TUTORIAL, `/games/tutorial/<lesson id>` (owner, 2026-11-27): a basics lesson or a pattern,
   * reached from a tile of the path. An id that is no lesson is said, never a blank page.
   * docs/wiki/frontend/modules/minesweeper.md, "The tutorial path"
   */
  import { page } from '$app/state';
  import { resolve } from '$app/paths';
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import MinesweeperLessonRunner from '$lib/components/games/MinesweeperLessonRunner.svelte';
  import { locateLesson } from '$lib/minesweeper/tutorial/path';
  import { m } from '$lib/paraglide/messages';

  const lessonId = $derived(page.params.id ?? '');
  const place = $derived(locateLesson(lessonId));

  $effect(() => {
    if (!place) console.warn('[minesweeper] no such tutorial lesson', { lessonId });
  });
</script>

<PageContainer width="reading">
  <!-- A lesson draws its OWN header (family label, title, position, back arrow: owner mockup, 2026-11-28); only the
       "no such lesson" page keeps the shared one. -->
  {#if place}
    {#key place.lesson.id}
      <MinesweeperLessonRunner {place} />
    {/key}
  {:else}
    <PageHeader
      title={m.minesweeper_tutorial_title()}
      backHref={resolve('/games/tutorial')}
      backLabel={m.minesweeper_lesson_back()}
    />
    <section class="bg-cn-surface space-y-3 rounded-2xl p-4" data-testid="tutorial-missing">
      <p class="text-text-main text-sm">{m.minesweeper_lesson_missing()}</p>
      <Button href={resolve('/games/tutorial')}>{m.minesweeper_lesson_back()}</Button>
    </section>
  {/if}
</PageContainer>
