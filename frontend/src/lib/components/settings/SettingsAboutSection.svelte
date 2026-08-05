<script lang="ts">
  import { onMount } from 'svelte';
  import { Info, Download } from '@lucide/svelte';
  import {
    getClientAppVersion,
    openLatestAppUpdate,
    resolveUpdateTarget,
    type UpdateTarget,
  } from '$lib/utils/appVersion';
  import { updateTargetButtonLabel, updateTargetInstruction } from '$lib/utils/updateTargetCopy';
  import {
    getAppVersionCheck,
    isAppUpdateAvailable,
    refreshAppVersionCheck,
  } from '$lib/stores/appVersionCheck.svelte';
  import { m } from '$lib/paraglide/messages';

  // The app stores own updating a store-distributed app, so nothing here interrupts the
  // user: this is the passive counterpart of the blocking minimum-version gate, and the
  // only place the running version is surfaced at all.
  const info = $derived(getAppVersionCheck());
  const updateAvailable = $derived(isAppUpdateAvailable());
  const clientVersion = getClientAppVersion();

  let target = $state<UpdateTarget | null>(null);
  let updating = $state(false);

  onMount(() => {
    void refreshAppVersionCheck();
  });

  // On Android the destination depends on how this install arrived (Play Store vs
  // sideloaded APK), which only the native side knows - so resolve before offering it.
  $effect(() => {
    if (!updateAvailable) return;
    const version = info?.serverVersion ?? null;
    void resolveUpdateTarget(version).then((resolved) => {
      target = resolved;
    });
  });

  async function handleUpdate() {
    updating = true;
    try {
      await openLatestAppUpdate(info?.serverVersion ?? null);
    } finally {
      updating = false;
    }
  }
</script>

<div
  class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-6 md:p-8 shadow-sm animate-in fade-in slide-in-from-bottom-4 duration-500 delay-500"
  style="animation-fill-mode: backwards;"
>
  <div class="flex items-center gap-3 mb-2">
    <div class="p-2.5 rounded-xl bg-cn-yellow/10 text-cn-dark">
      <Info size={22} strokeWidth={2.5} />
    </div>
    <h2 class="text-lg font-extrabold text-text-main">{m.settings_about_heading()}</h2>
  </div>
  <p class="text-xs font-medium text-text-muted mb-6 sm:pl-[3.75rem] leading-relaxed">
    {m.settings_about_desc()}
  </p>

  <div class="sm:pl-[3.75rem] space-y-3">
    <p class="text-sm text-text-main">
      {m.settings_about_version_label()}
      <strong class="font-bold">{clientVersion}</strong>
    </p>

    {#if updateAvailable}
      <p class="text-sm text-text-muted leading-relaxed">
        {m.settings_about_update_available({ version: info?.serverVersion ?? '' })}
        {#if target}
          {updateTargetInstruction(target.kind)}
        {/if}
      </p>
      <button
        type="button"
        class="inline-flex items-center gap-2 rounded-lg border border-cn-border px-4 py-2 text-sm font-bold text-text-main hover:bg-cn-bg transition-colors disabled:opacity-60"
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
    {:else}
      <p class="text-sm text-text-muted">{m.settings_about_up_to_date()}</p>
    {/if}
  </div>
</div>
