<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { isGlobalAdmin } from '$lib/stores/user';
  import { getBackendStorageUsage, type BackendStorageUsage } from '$lib/utils/backendStorage';
  import { formatStorageBytes } from '$lib/utils/deviceStorage';
  import { HardDrive, Database, Server, RefreshCw, TriangleAlert } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  // WP-DEVICESTORAGE-1's backend counterpart: display-only, no clear/delete action here - none of
  // these four numbers are safe to act on from a button.
  let usage = $state<BackendStorageUsage | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  async function load() {
    loading = true;
    error = null;
    try {
      usage = await getBackendStorageUsage();
    } catch (e) {
      error = e instanceof Error ? e.message : m.common_generic_error_label();
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    if (!isGlobalAdmin()) {
      void goto('/admin', { replaceState: true });
      return;
    }
    void load();
  });

  const diskUsedPercent = $derived(
    usage?.diskTotalBytes && usage?.diskUsedBytes !== null && usage?.diskUsedBytes !== undefined
      ? Math.min(100, Math.round((usage.diskUsedBytes / usage.diskTotalBytes) * 100))
      : null
  );
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <p class="text-sm text-text-muted">{m.admin_storage_desc()}</p>
    <button
      type="button"
      onclick={() => void load()}
      disabled={loading}
      class="inline-flex items-center gap-1.5 rounded-xl border border-cn-border px-3 py-1.5 text-sm font-bold text-text-main hover:border-cn-yellow/40 transition-all disabled:opacity-50"
    >
      <RefreshCw size={14} class={loading ? 'animate-spin' : ''} />
      {m.common_refresh_button()}
    </button>
  </div>

  {#if loading && !usage}
    <div class="flex justify-center py-16">
      <div
        class="h-8 w-8 animate-spin rounded-full border-4 border-cn-yellow border-t-transparent"
      ></div>
    </div>
  {:else if error}
    <div
      class="flex items-center gap-2 rounded-2xl border border-red-500/20 bg-red-500/5 p-4 text-sm font-semibold text-red-500"
    >
      <TriangleAlert size={16} />
      {error}
    </div>
  {:else if usage}
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-5 space-y-3">
        <div class="flex items-center gap-2.5">
          <span
            class="flex h-9 w-9 items-center justify-center rounded-xl bg-cn-yellow/10 text-cn-dark"
          >
            <HardDrive size={18} />
          </span>
          <h2 class="font-bold text-text-main">{m.admin_storage_disk_label()}</h2>
        </div>
        {#if usage.diskTotalBytes !== null && usage.diskUsedBytes !== null}
          <div class="h-2 rounded-full bg-cn-border overflow-hidden">
            <div class="h-full bg-cn-yellow" style="width: {diskUsedPercent}%"></div>
          </div>
          <p class="text-sm text-text-muted">
            {m.admin_storage_disk_used({
              used: formatStorageBytes(usage.diskUsedBytes),
              total: formatStorageBytes(usage.diskTotalBytes),
              percent: diskUsedPercent ?? 0,
            })}
          </p>
        {:else}
          <p class="text-sm text-text-muted">{m.admin_storage_unavailable()}</p>
        {/if}
      </div>

      <div class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-5 space-y-3">
        <div class="flex items-center gap-2.5">
          <span
            class="flex h-9 w-9 items-center justify-center rounded-xl bg-cn-yellow/10 text-cn-dark"
          >
            <Database size={18} />
          </span>
          <h2 class="font-bold text-text-main">{m.admin_storage_postgres_label()}</h2>
        </div>
        {#if usage.postgresBytes !== null}
          <p class="text-2xl font-extrabold text-text-main">
            {formatStorageBytes(usage.postgresBytes)}
          </p>
        {:else}
          <p class="text-sm text-text-muted">{m.admin_storage_unavailable()}</p>
        {/if}
      </div>

      <div class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-5 space-y-3">
        <div class="flex items-center gap-2.5">
          <span
            class="flex h-9 w-9 items-center justify-center rounded-xl bg-cn-yellow/10 text-cn-dark"
          >
            <Server size={18} />
          </span>
          <h2 class="font-bold text-text-main">{m.admin_storage_garage_label()}</h2>
        </div>
        {#if usage.garageBytes !== null}
          <p class="text-2xl font-extrabold text-text-main">
            {formatStorageBytes(usage.garageBytes)}
          </p>
          {#if usage.garageObjectCount !== null}
            <p class="text-sm text-text-muted">
              {m.admin_storage_garage_object_count({ count: usage.garageObjectCount })}
            </p>
          {/if}
        {:else}
          <p class="text-sm text-text-muted">{m.admin_storage_unavailable()}</p>
        {/if}
      </div>

      <div class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-5 space-y-3">
        <div class="flex items-center gap-2.5">
          <span
            class="flex h-9 w-9 items-center justify-center rounded-xl bg-cn-yellow/10 text-cn-dark"
          >
            <HardDrive size={18} />
          </span>
          <h2 class="font-bold text-text-main">{m.admin_storage_redis_label()}</h2>
        </div>
        {#if usage.redisBytes !== null}
          <p class="text-2xl font-extrabold text-text-main">
            {formatStorageBytes(usage.redisBytes)}
          </p>
        {:else}
          <p class="text-sm text-text-muted">{m.admin_storage_unavailable()}</p>
        {/if}
      </div>
    </div>
  {/if}
</div>
