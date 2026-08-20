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
  import {
    openLatestAppUpdate,
    resolveUpdateTarget,
    type UpdateTarget,
  } from '$lib/utils/appVersion';
  import { updateTargetButtonLabel, updateTargetInstruction } from '$lib/utils/updateTargetCopy';
  import { goto } from '$app/navigation';
  import { m } from '$lib/paraglide/messages';

  const info = $derived(getAppVersionCheck());
  const isGlobalAdminUser = $derived(isGlobalAdmin());
  const showMinVersion = $derived(isBelowMinClientVersion() && info !== null);
  const showMaintenance = $derived(
    !showMinVersion && isMaintenanceBlockingCurrentUser(isGlobalAdminUser) && info !== null
  );
  /** Version to install: the enforced minimum, or the server build when it is unknown. */
  const targetVersion = $derived(info?.minClientVersion ?? info?.serverVersion ?? null);

  // Resolved asynchronously: on Android the destination depends on how this install
  // arrived (Play Store vs sideloaded APK), which only the native side knows.
  let target = $state<UpdateTarget | null>(null);

  let updating = $state(false);
  let loggingOut = $state(false);

  $effect(() => {
    if (!showMinVersion) return;
    const version = targetVersion;
    void resolveUpdateTarget(version).then((resolved) => {
      target = resolved;
    });
  });

  async function handleUpdate() {
    updating = true;
    try {
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
    <div class="text-text-muted space-y-4 text-sm leading-relaxed">
      <p>
        {m.platform_gate_version_prefix()}<strong class="text-cn-dark">{info.clientVersion}</strong
        >{m.platform_gate_version_middle()}
        <strong class="text-cn-dark">{info.minClientVersion}</strong>
        {m.platform_gate_version_suffix()}
      </p>
      {#if target}
        <p>{updateTargetInstruction(target.kind)}</p>
      {/if}
    </div>

    {#snippet footer()}
      <button
        type="button"
        class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover inline-flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-bold shadow-sm disabled:opacity-60"
        disabled={updating || target === null}
        onclick={() => void handleUpdate()}
      >
        <Download size={16} />
        {updating
          ? m.update_opening_label()
          : target
            ? updateTargetButtonLabel(target.kind)
            : m.common_loading_label()}
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
    <div class="text-text-muted space-y-4 text-sm leading-relaxed">
      <div class="flex justify-center">
        <span
          class="text-amber-warn flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500/15"
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
        class="text-cn-dark bg-cn-yellow hover:bg-cn-yellow-hover w-full rounded-lg px-4 py-2 text-sm font-bold disabled:opacity-60"
        disabled={loggingOut}
        onclick={() => void handleMaintenanceLogout()}
      >
        {loggingOut ? m.platform_gate_logging_out() : m.platform_gate_logout_button()}
      </button>
    {/snippet}
  </Modal>
{/if}
