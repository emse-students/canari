<script lang="ts">
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import SectionHub from '$lib/components/navigation/SectionHub.svelte';
  import MinesweeperModal from '$lib/components/settings/MinesweeperModal.svelte';
  import { globalSession as session } from '$lib/stores/globalChatSingleton.svelte';
  import { settingsHubRows } from '$lib/settings/settingsSections';
  import { m } from '$lib/paraglide/messages';

  /** Consecutive taps needed on the device id to unlock the easter egg. */
  const EASTER_EGG_TAPS = 5;
  /** Max gap between taps (ms); slower sequences reset the counter. */
  const EASTER_EGG_WINDOW_MS = 2000;

  // Account management hub: a list of sections, each a route segment (`/settings/<section>`).
  // Identity (avatar, bio, associations...) stays on /profile. Each section owns its own data
  // loading; the sign-in guard is the layout's.
  let minesweeperOpen = $state(false);
  let tapCount = $state(0);
  let lastTapAt = 0;

  /** Counts rapid taps on the device id footer; opens Minesweeper after 5 in a row. */
  function onDeviceIdTap() {
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

<PageHeader title={m.settings_page_title()} subtitle={m.settings_page_subtitle()} />

<div class="space-y-6 md:space-y-8">
  <SectionHub rows={settingsHubRows()} label={m.settings_page_title()} />

  <!-- Device identifier (discreet diagnostic). Tap 5x quickly to unlock Minesweeper. -->
  {#if session.myDeviceId}
    <button
      type="button"
      class="text-text-muted/40 text-2xs block w-full cursor-default pt-2 text-center font-mono select-none"
      onclick={onDeviceIdTap}
      aria-label={m.settings_device_id_label({ id: session.myDeviceId })}
    >
      {m.settings_device_id_label({ id: session.myDeviceId })}
    </button>
  {/if}
</div>

{#if minesweeperOpen}
  <MinesweeperModal open={true} onClose={() => (minesweeperOpen = false)} />
{/if}
