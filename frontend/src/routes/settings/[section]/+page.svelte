<script lang="ts">
  import Breadcrumb from '$lib/components/navigation/Breadcrumb.svelte';
  import SettingsPreferencesSection from '$lib/components/settings/SettingsPreferencesSection.svelte';
  import SettingsNotificationsSection from '$lib/components/settings/SettingsNotificationsSection.svelte';
  import SettingsSecuritySection from '$lib/components/settings/SettingsSecuritySection.svelte';
  import SettingsBackupSection from '$lib/components/settings/SettingsBackupSection.svelte';
  import SettingsAboutSection from '$lib/components/settings/SettingsAboutSection.svelte';
  import SettingsStorageSection from '$lib/components/settings/SettingsStorageSection.svelte';
  import SettingsBlockedSection from '$lib/components/settings/SettingsBlockedSection.svelte';
  import SettingsDangerZone from '$lib/components/settings/SettingsDangerZone.svelte';
  import { settingsTrail } from '$lib/settings/settingsSections';
  import { m } from '$lib/paraglide/messages';

  // `+page.ts` has already refused an unknown segment, so `data.section` is always a real key.
  let { data } = $props();
  const section = $derived(data.section);
</script>

<Breadcrumb crumbs={settingsTrail(section, m.settings_page_title())} />

<div class="space-y-6 md:space-y-8">
  {#if section === 'preferences'}
    <SettingsPreferencesSection />
  {:else if section === 'notifications'}
    <SettingsNotificationsSection />
  {:else if section === 'security'}
    <SettingsSecuritySection />
  {:else if section === 'backup'}
    <SettingsBackupSection />
  {:else if section === 'blocked'}
    <SettingsBlockedSection />
  {:else if section === 'about'}
    <SettingsAboutSection />
  {:else if section === 'storage'}
    <SettingsStorageSection />
  {:else if section === 'danger'}
    <SettingsDangerZone />
  {/if}
</div>
