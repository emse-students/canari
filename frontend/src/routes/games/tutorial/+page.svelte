<script lang="ts">
  /**
   * THE MINESWEEPER TUTORIAL, `/games/tutorial` (owner, 2026-11-25, then redesigned 2026-11-27): the PATH. Two
   * tabs - "Les bases" (the gestures and the rules) and "Motifs" (the pattern catalogue) - each a zigzag of
   * tiles led by Le Pic; a tile opens one lesson (`/games/tutorial/<id>`). The order is advised, everything
   * stays open, and nothing counts: no streak, no points (charter, principle 3).
   * docs/wiki/frontend/modules/minesweeper.md, "The tutorial path"
   */
  import { resolve } from '$app/paths';
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import TutorialPath from '$lib/components/games/TutorialPath.svelte';
  import { m } from '$lib/paraglide/messages';
</script>

<PageContainer width="reading">
  <PageHeader
    title={m.minesweeper_path_title()}
    backHref={resolve('/games')}
    backLabel={m.games_page_title()}
  />

  <TutorialPath />
</PageContainer>
