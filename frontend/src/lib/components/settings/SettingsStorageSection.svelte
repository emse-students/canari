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
  class="border-cn-border animate-in fade-in slide-in-from-bottom-4 rounded-2xl border bg-(--cn-surface) p-6 shadow-sm delay-300 duration-500 md:p-8"
  style="animation-fill-mode: backwards;"
>
  <div class="mb-2 flex items-center gap-3">
    <div class="bg-cn-yellow/10 text-cn-dark rounded-xl p-2.5">
      <HardDrive size={22} strokeWidth={2.5} />
    </div>
    <h2 class="text-text-main text-lg font-extrabold">{m.settings_storage_heading()}</h2>
  </div>
  <p class="text-text-muted mb-6 text-xs leading-relaxed font-medium sm:pl-[3.75rem]">
    {m.settings_storage_desc()}
  </p>

  {#if loading}
    <div class="text-text-muted flex items-center gap-2 text-sm sm:pl-[3.75rem]">
      <Loader2 size={16} class="animate-spin" />
      {m.settings_storage_measuring()}
    </div>
  {:else if usage}
    <div class="space-y-3 sm:pl-[3.75rem]">
      <div class="flex items-center justify-between text-sm">
        <span class="text-text-muted">{m.settings_storage_media_cache_label()}</span>
        <span class="text-text-main font-bold">{formatStorageBytes(usage.mediaCacheBytes)}</span>
      </div>
      <div class="flex items-center justify-between text-sm">
        <span class="text-text-muted">{m.settings_storage_messages_label()}</span>
        <span class="text-text-main font-bold">{formatStorageBytes(usage.messagesBytes)}</span>
      </div>
      {#if usage.encryptionStateBytes !== null}
        <div class="flex items-center justify-between text-sm">
          <span class="text-text-muted">{m.settings_storage_encryption_label()}</span>
          <span class="text-text-main font-bold"
            >{formatStorageBytes(usage.encryptionStateBytes)}</span
          >
        </div>
      {/if}
      <div class="border-cn-border flex items-center justify-between border-t pt-3 text-sm">
        <span class="text-text-main font-bold">{m.settings_storage_total_label()}</span>
        <span class="text-text-main font-extrabold">{formatStorageBytes(usage.totalBytes)}</span>
      </div>
    </div>

    <button
      type="button"
      onclick={handleClearCache}
      disabled={clearing || usage.mediaCacheBytes === 0}
      class="border-cn-border text-text-main hover:border-cn-yellow/40 mt-6 inline-flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-bold transition-all active:scale-95 disabled:opacity-50 sm:ml-[3.75rem]"
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
