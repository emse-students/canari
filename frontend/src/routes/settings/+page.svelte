<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { SlidersHorizontal } from '@lucide/svelte';
  import { globalSession as session } from '$lib/stores/globalChatSingleton.svelte';
  import SettingsPreferencesSection from '$lib/components/settings/SettingsPreferencesSection.svelte';
  import SettingsSecuritySection from '$lib/components/settings/SettingsSecuritySection.svelte';
  import SettingsSyncSection from '$lib/components/settings/SettingsSyncSection.svelte';
  import SettingsPaymentsSection from '$lib/components/settings/SettingsPaymentsSection.svelte';
  import SettingsSubscriptionsSection from '$lib/components/settings/SettingsSubscriptionsSection.svelte';
  import SettingsDangerZone from '$lib/components/settings/SettingsDangerZone.svelte';
  import MinesweeperModal from '$lib/components/settings/MinesweeperModal.svelte';
  import { m } from '$lib/paraglide/messages';

  /** Consecutive taps needed on the device id to unlock the easter egg. */
  const EASTER_EGG_TAPS = 5;
  /** Max gap between taps (ms); slower sequences reset the counter. */
  const EASTER_EGG_WINDOW_MS = 2000;

  // Account management hub: preferences, security, sync, payments and the danger zone.
  // Identity (avatar, bio, associations...) stays on /profile. Each section owns its own
  // data loading, so this page is a thin assembly.
  onMount(() => {
    if (!session.isLoggedIn) {
      void goto('/login?returnTo=/settings', { replaceState: true });
    }
  });

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

<div class="px-4 py-8 sm:px-6 max-w-3xl mx-auto space-y-6 md:space-y-8">
  <div class="flex items-center gap-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
    <div class="p-3 rounded-2xl bg-cn-yellow/10 text-cn-dark">
      <SlidersHorizontal size={26} strokeWidth={2.5} />
    </div>
    <div>
      <h1 class="text-2xl sm:text-3xl font-extrabold text-text-main tracking-tight">
        {m.settings_page_title()}
      </h1>
      <p class="text-sm text-text-muted mt-0.5">{m.settings_page_subtitle()}</p>
    </div>
  </div>

  <SettingsPreferencesSection />
  <SettingsSecuritySection />
  <SettingsSyncSection />
  <SettingsPaymentsSection />
  <SettingsSubscriptionsSection />
  <SettingsDangerZone />

  <!-- Device identifier (discreet diagnostic). Tap 5x quickly to unlock Minesweeper. -->
  {#if session.myDeviceId}
    <button
      type="button"
      class="block w-full text-center text-[0.65rem] font-mono text-text-muted/40 select-none pt-2 cursor-default"
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
