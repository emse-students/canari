<script lang="ts">
  /**
   * THE MINESWEEPER, `/games/play`: a full-screen place (`isFullScreenPlace`) - the shell draws no
   * header and no bar, the board is the page. It was a modal over the Games page, whose portal, focus
   * trap and history overlay cost frames a board of 576 cells cannot spare (owner, 2026-11-25).
   * Back goes to where the player came from, as on any page. docs/wiki/frontend/modules/minesweeper.md
   * It ASKS THE MODE at every arrival ("Nouvelle partie", ranked or training): arriving here is launching a game.
   */
  import MinesweeperModal from '$lib/components/settings/MinesweeperModal.svelte';
</script>

<MinesweeperModal askMode />
