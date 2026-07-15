<script lang="ts">
  import Modal from '$lib/components/shared/Modal.svelte';
  import { Download, Wrench } from '@lucide/svelte';
  import {
    getAppVersionCheck,
    isBelowMinClientVersion,
    isMaintenanceBlockingCurrentUser,
  } from '$lib/stores/appVersionCheck.svelte';
  import { isGlobalAdmin } from '$lib/stores/user';
  import { clearAuth } from '$lib/stores/auth';
  import { isAndroidTauriRuntime, openLatestAppUpdate } from '$lib/utils/appVersion';
  import { isTauriRuntime } from '$lib/utils/openExternal';
  import { goto } from '$app/navigation';
  import { m } from '$lib/paraglide/messages';

  const info = $derived(getAppVersionCheck());
  const isGlobalAdminUser = $derived(isGlobalAdmin());
  const showMinVersion = $derived(isBelowMinClientVersion() && info !== null);
  const showMaintenance = $derived(
    !showMinVersion && isMaintenanceBlockingCurrentUser(isGlobalAdminUser) && info !== null
  );
  const isNative = $derived(isTauriRuntime());
  const isAndroid = $derived(isAndroidTauriRuntime());

  let updating = $state(false);
  let loggingOut = $state(false);

  async function handleUpdate() {
    updating = true;
    try {
      const targetVersion = info?.minClientVersion ?? info?.serverVersion ?? null;
      await openLatestAppUpdate(targetVersion);
    } finally {
      updating = false;
    }
  }

  async function handleMaintenanceLogout() {
    loggingOut = true;
    try {
      await clearAuth();
      await goto('/login', { replaceState: true });
    } finally {
      loggingOut = false;
    }
  }
</script>

{#if showMinVersion && info}
  <Modal
    open={true}
    title={m.update_required_title()}
    dismissible={false}
    maxWidth="max-w-lg"
    onClose={() => {}}
  >
    <div class="space-y-4 text-sm text-text-muted leading-relaxed">
      <p>
        {m.platform_gate_version_prefix()}<strong class="text-cn-dark">{info.clientVersion}</strong
        >{m.platform_gate_version_middle()}
        <strong class="text-cn-dark">{info.minClientVersion}</strong>
        {m.platform_gate_version_suffix()}
      </p>
      {#if isAndroid}
        <p>{m.update_android_instruction()}</p>
      {:else if isNative}
        <p>{m.update_native_instruction()}</p>
      {:else}
        <p>{m.update_web_instruction()}</p>
      {/if}
    </div>

    {#snippet footer()}
      <button
        type="button"
        class="inline-flex items-center gap-2 rounded-lg bg-cn-yellow px-4 py-2 text-sm font-bold text-cn-ink hover:bg-cn-yellow-hover disabled:opacity-60 shadow-sm w-full justify-center"
        disabled={updating}
        onclick={() => void handleUpdate()}
      >
        <Download size={16} />
        {updating
          ? m.update_opening_label()
          : isNative
            ? m.update_download_button()
            : m.update_reload_button()}
      </button>
    {/snippet}
  </Modal>
{:else if showMaintenance && info}
  <Modal
    open={true}
    title={m.platform_gate_maintenance_title()}
    dismissible={false}
    maxWidth="max-w-lg"
    onClose={() => {}}
  >
    <div class="space-y-4 text-sm text-text-muted leading-relaxed">
      <div class="flex justify-center">
        <span
          class="flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500/15 text-amber-600"
        >
          <Wrench size={28} />
        </span>
      </div>
      <p>
        {info.maintenance.message || m.platform_gate_maintenance_default_msg()}
      </p>
    </div>

    {#snippet footer()}
      <button
        type="button"
        class="rounded-lg px-4 py-2 text-sm font-bold text-cn-dark bg-cn-yellow hover:bg-cn-yellow-hover disabled:opacity-60 w-full"
        disabled={loggingOut}
        onclick={() => void handleMaintenanceLogout()}
      >
        {loggingOut ? m.platform_gate_logging_out() : m.platform_gate_logout_button()}
      </button>
    {/snippet}
  </Modal>
{/if}
