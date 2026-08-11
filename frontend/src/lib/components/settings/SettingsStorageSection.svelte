<script lang="ts">
  import { onMount } from 'svelte';
  import { HardDrive, Trash2, Loader2 } from '@lucide/svelte';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import {
    getDeviceStorageUsage,
    clearMediaCache,
    formatStorageBytes,
  } from '$lib/utils/deviceStorage';
  import type { DeviceStorageUsage } from '$lib/utils/deviceStorage';
  import { m } from '$lib/paraglide/messages';

  // WP-DEVICESTORAGE-1: shows how much local storage Canari is using, and lets the user
  // reclaim the media cache. Never offers to touch messages or the MLS encryption state -
  // only the re-fetchable Cache Storage buckets are ever cleared here.
  let usage: DeviceStorageUsage | null = $state(null);
  let loading = $state(true);
  let clearing = $state(false);

  async function loadUsage() {
    loading = true;
    try {
      usage = await getDeviceStorageUsage();
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void loadUsage();
  });

  async function handleClearCache() {
    const confirmed = await showConfirm(m.settings_storage_clear_confirm(), {
      confirmLabel: m.settings_storage_clear_cache_button(),
    });
    if (!confirmed) return;
    clearing = true;
    try {
      await clearMediaCache();
      await loadUsage();
    } finally {
      clearing = false;
    }
  }
</script>

<div
  class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-6 md:p-8 shadow-sm animate-in fade-in slide-in-from-bottom-4 duration-500 delay-300"
  style="animation-fill-mode: backwards;"
>
  <div class="flex items-center gap-3 mb-2">
    <div class="p-2.5 rounded-xl bg-cn-yellow/10 text-cn-dark">
      <HardDrive size={22} strokeWidth={2.5} />
    </div>
    <h2 class="text-lg font-extrabold text-text-main">{m.settings_storage_heading()}</h2>
  </div>
  <p class="text-xs font-medium text-text-muted mb-6 sm:pl-[3.75rem] leading-relaxed">
    {m.settings_storage_desc()}
  </p>

  {#if loading}
    <div class="flex items-center gap-2 text-sm text-text-muted sm:pl-[3.75rem]">
      <Loader2 size={16} class="animate-spin" />
      {m.settings_storage_measuring()}
    </div>
  {:else if usage}
    <div class="space-y-3 sm:pl-[3.75rem]">
      <div class="flex items-center justify-between text-sm">
        <span class="text-text-muted">{m.settings_storage_media_cache_label()}</span>
        <span class="font-bold text-text-main">{formatStorageBytes(usage.mediaCacheBytes)}</span>
      </div>
      <div class="flex items-center justify-between text-sm">
        <span class="text-text-muted">{m.settings_storage_messages_label()}</span>
        <span class="font-bold text-text-main">{formatStorageBytes(usage.messagesBytes)}</span>
      </div>
      {#if usage.encryptionStateBytes !== null}
        <div class="flex items-center justify-between text-sm">
          <span class="text-text-muted">{m.settings_storage_encryption_label()}</span>
          <span class="font-bold text-text-main"
            >{formatStorageBytes(usage.encryptionStateBytes)}</span
          >
        </div>
      {/if}
      <div class="flex items-center justify-between text-sm pt-3 border-t border-cn-border">
        <span class="font-bold text-text-main">{m.settings_storage_total_label()}</span>
        <span class="font-extrabold text-text-main">{formatStorageBytes(usage.totalBytes)}</span>
      </div>
    </div>

    <button
      type="button"
      onclick={handleClearCache}
      disabled={clearing || usage.mediaCacheBytes === 0}
      class="mt-6 inline-flex items-center gap-2 rounded-xl border border-cn-border px-4 py-2.5 text-sm font-bold text-text-main hover:border-cn-yellow/40 transition-all active:scale-95 disabled:opacity-50 sm:ml-[3.75rem]"
    >
      {#if clearing}
        <Loader2 size={16} class="animate-spin" />
        {m.settings_storage_clearing()}
      {:else}
        <Trash2 size={16} strokeWidth={2.5} />
        {m.settings_storage_clear_cache_button()}
      {/if}
    </button>
  {/if}
</div>
