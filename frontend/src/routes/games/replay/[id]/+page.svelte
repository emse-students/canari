<script lang="ts">
  /**
   * THE REPLAY OF ONE GAME, `/games/replay/<scoreId>`: a full-screen place like the game itself
   * (`isFullScreenPlace`), so a replay is a link - shareable, and Back returns to the ranking it was
   * opened from. docs/wiki/frontend/modules/minesweeper.md, "The replay".
   */
  import { page } from '$app/state';
  import MinesweeperReplay from '$lib/components/games/MinesweeperReplay.svelte';

  const scoreId = $derived(page.params.id ?? '');
</script>

{#key scoreId}
  <MinesweeperReplay {scoreId} />
{/key}
