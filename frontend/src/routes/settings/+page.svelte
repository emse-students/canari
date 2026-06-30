<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { SlidersHorizontal } from '@lucide/svelte';
  import { globalSession as session } from '$lib/stores/globalChatSingleton.svelte';
  import SettingsPreferencesSection from '$lib/components/settings/SettingsPreferencesSection.svelte';
  import SettingsNotepadSection from '$lib/components/settings/SettingsNotepadSection.svelte';
  import SettingsSecuritySection from '$lib/components/settings/SettingsSecuritySection.svelte';
  import SettingsSyncSection from '$lib/components/settings/SettingsSyncSection.svelte';
  import SettingsPaymentsSection from '$lib/components/settings/SettingsPaymentsSection.svelte';
  import SettingsSubscriptionsSection from '$lib/components/settings/SettingsSubscriptionsSection.svelte';
  import SettingsDangerZone from '$lib/components/settings/SettingsDangerZone.svelte';
  import { m } from '$lib/paraglide/messages';

  // Account management hub: preferences, security, sync, payments and the danger zone.
  // Identity (avatar, bio, associations...) stays on /profile. Each section owns its own
  // data loading, so this page is a thin assembly.
  onMount(() => {
    if (!session.isLoggedIn) {
      void goto('/login?returnTo=/settings', { replaceState: true });
    }
  });
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
  <SettingsNotepadSection />
  <SettingsSecuritySection />
  <SettingsSyncSection />
  <SettingsPaymentsSection />
  <SettingsSubscriptionsSection />
  <SettingsDangerZone />

  <!-- Device identifier (discreet diagnostic, useful for tracing MLS reboots). -->
  {#if session.myDeviceId}
    <p class="text-center text-[0.65rem] font-mono text-text-muted/40 select-all pt-2">
      device: {session.myDeviceId}
    </p>
  {/if}
</div>
