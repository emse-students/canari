<script lang="ts">
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import SectionHub from '$lib/components/navigation/SectionHub.svelte';
  import MinesweeperModal from '$lib/components/settings/MinesweeperModal.svelte';
  import { settingsHubRows } from '$lib/settings/settingsSections';
  import { m } from '$lib/paraglide/messages';

  /** Consecutive taps needed on the page header to unlock the easter egg. */
  const EASTER_EGG_TAPS = 5;
  /** Max gap between taps (ms); slower sequences reset the counter. */
  const EASTER_EGG_WINDOW_MS = 2000;

  // Account management hub: a list of sections, each a route segment (`/settings/<section>`).
  // Identity (avatar, bio, associations...) stays on /profile. Each section owns its own data
  // loading; the sign-in guard is the layout's.
  let minesweeperOpen = $state(false);
  let tapCount = $state(0);
  let lastTapAt = 0;

  /** Counts rapid taps on the page header; opens Minesweeper after 5 in a row. */
  function onHeaderTap() {
    const now = Date.now();
    if (now - lastTapAt > EASTER_EGG_WINDOW_MS) tapCount = 0;
    lastTapAt = now;
    tapCount += 1;
    if (tapCount >= EASTER_EGG_TAPS) {
      tapCount = 0;
      minesweeperOpen = true;
    }
  }
</script>

<!-- The 5-tap easter egg lives on the page header now: the raw device id that used to carry it was
     internal text on a user surface (design audit Q9, owner rule of 2026-10-31). -->
<div role="presentation" class="select-none" onclick={onHeaderTap}>
  <PageHeader title={m.settings_page_title()} subtitle={m.settings_page_subtitle()} />
</div>

<div class="space-y-6 md:space-y-8">
  <SectionHub rows={settingsHubRows()} label={m.settings_page_title()} />
</div>

{#if minesweeperOpen}
  <MinesweeperModal open={true} onClose={() => (minesweeperOpen = false)} />
{/if}
