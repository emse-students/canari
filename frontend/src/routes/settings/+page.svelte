<script lang="ts">
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { globalSession as session } from '$lib/stores/globalChatSingleton.svelte';
  import { currentUserId } from '$lib/stores/user';
  import SettingsPreferencesSection from '$lib/components/settings/SettingsPreferencesSection.svelte';
  import SettingsSecuritySection from '$lib/components/settings/SettingsSecuritySection.svelte';
  import SettingsBackupSection from '$lib/components/settings/SettingsBackupSection.svelte';
  import SettingsPaymentsSection from '$lib/components/settings/SettingsPaymentsSection.svelte';
  import SettingsSubscriptionsSection from '$lib/components/settings/SettingsSubscriptionsSection.svelte';
  import SettingsAboutSection from '$lib/components/settings/SettingsAboutSection.svelte';
  import SettingsStorageSection from '$lib/components/settings/SettingsStorageSection.svelte';
  import SettingsBlockedSection from '$lib/components/settings/SettingsBlockedSection.svelte';
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
  //
  // The guard tests for an ACCOUNT session, not `session.isLoggedIn` (which means "MLS is
  // ready"). Those two diverge whenever the OIDC session is valid but MLS init failed, and
  // bouncing to /login there produced an endless ping-pong: the login page saw a live refresh
  // cookie and sent the user straight back. Sections that need MLS handle its absence
  // themselves.
  onMount(() => {
    if (!currentUserId()) {
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

<PageContainer>
  <PageHeader title={m.settings_page_title()} subtitle={m.settings_page_subtitle()} />

  <div class="space-y-6 md:space-y-8">
    <SettingsPreferencesSection />
    <SettingsSecuritySection />
    <SettingsBackupSection />
    <SettingsPaymentsSection />
    <SettingsSubscriptionsSection />
    <SettingsBlockedSection />
    <SettingsAboutSection />
    <SettingsStorageSection />
    <SettingsDangerZone />

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
</PageContainer>

{#if minesweeperOpen}
  <MinesweeperModal open={true} onClose={() => (minesweeperOpen = false)} />
{/if}
