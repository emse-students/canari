<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { isGlobalAdmin } from '$lib/stores/user';
  import {
    getBackendStorageUsage,
    classifyRetention,
    unreachableBytes,
    type BackendStorageUsage,
  } from '$lib/utils/backendStorage';
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

  const DAY_MS = 24 * 60 * 60 * 1000;
  const media = $derived(usage?.media ?? null);
  /** The one sentence the overdue counters are worth: a schedule, a wait, or a fault. */
  const retention = $derived(media ? classifyRetention(media) : null);
  const retentionDays = $derived(media ? Math.round(media.retentionMs / DAY_MS) : 0);
  const sweepHours = $derived(media ? Math.round(media.sweepIntervalMs / (60 * 60 * 1000)) : 0);
  const unreachable = $derived(media ? unreachableBytes(media) : 0);
  const unreachableCount = $derived(media ? media.untrackedCount + media.tombstonedCount : 0);
  /** How far back the weekly bars reach, so the "older" line can name its own boundary. */
  const barsSpanDays = $derived(media ? media.recentBytesByWeek.length * 7 : 0);

  /**
   * The weekly bars, reversed so the row reads left to right as time passes and the rightmost bar
   * is the current week. Heights are relative to the tallest bar: the panel answers "is the slope
   * rising", never "how many bytes is this pixel", which the label already says exactly.
   */
  const weekBars = $derived.by(() => {
    if (!media) return [];
    const tallest = Math.max(1, ...media.recentBytesByWeek);
    return media.recentBytesByWeek
      .map((bytes, index) => ({
        index,
        bytes,
        percent: Math.max(bytes > 0 ? 2 : 0, Math.round((bytes / tallest) * 100)),
      }))
      .reverse();
  });
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

      <!-- The media bucket answers WHY it is that size, not only how much: the growth bars and the
           retention verdict have opposite fixes and a single total cannot tell them apart. -->
      <div
        class="sm:col-span-2 rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-5 space-y-5"
      >
        <div class="flex items-center gap-2.5">
          <span
            class="flex h-9 w-9 items-center justify-center rounded-xl bg-cn-yellow/10 text-cn-dark"
          >
            <Server size={18} />
          </span>
          <h2 class="font-bold text-text-main">{m.admin_storage_garage_label()}</h2>
        </div>

        {#if media}
          <div>
            <p class="text-2xl font-extrabold text-text-main">
              {formatStorageBytes(media.totalBytes)}
            </p>
            <p class="text-sm text-text-muted">
              {m.admin_storage_garage_object_count({ count: media.objectCount })}
            </p>
          </div>

          <div class="space-y-2">
            <h3 class="text-xs font-bold uppercase tracking-wide text-text-muted">
              {m.admin_storage_media_growth_title()}
            </h3>
            <div class="flex items-end gap-2 h-24">
              {#each weekBars as bar (bar.index)}
                <div class="flex-1 flex flex-col items-center justify-end gap-1.5 h-full">
                  <span class="text-[0.65rem] font-bold text-text-main">
                    {formatStorageBytes(bar.bytes)}
                  </span>
                  <div
                    class="w-full rounded-t-lg bg-cn-yellow/70"
                    style="height: {bar.percent}%"
                  ></div>
                  <span class="text-[0.65rem] text-text-muted text-center">
                    {bar.index === 0
                      ? m.admin_storage_media_week_current()
                      : m.admin_storage_media_week_range({
                          from: bar.index * 7,
                          to: (bar.index + 1) * 7,
                        })}
                  </span>
                </div>
              {/each}
            </div>
            <p class="text-sm text-text-muted">
              {m.admin_storage_media_older({
                days: barsSpanDays,
                size: formatStorageBytes(media.olderBytes),
              })}
            </p>
            {#if media.undatedCount > 0}
              <p class="text-sm text-text-muted">
                {m.admin_storage_media_undated({ count: media.undatedCount })}
              </p>
            {/if}
          </div>

          <div class="space-y-1">
            <h3 class="text-xs font-bold uppercase tracking-wide text-text-muted">
              {m.admin_storage_media_retention_title()}
            </h3>
            {#if retention?.kind === 'stalled'}
              <p class="flex items-start gap-2 text-sm font-semibold text-red-500">
                <TriangleAlert size={16} class="shrink-0 mt-0.5" />
                {m.admin_storage_media_retention_stalled({
                  count: retention.count,
                  size: formatStorageBytes(retention.bytes),
                  age: Math.round(retention.oldestMs / DAY_MS),
                  days: retentionDays,
                })}
              </p>
            {:else if retention?.kind === 'pending'}
              <p class="text-sm text-text-muted">
                {m.admin_storage_media_retention_pending({
                  count: retention.count,
                  size: formatStorageBytes(retention.bytes),
                  days: retentionDays,
                })}
              </p>
            {:else}
              <p class="text-sm text-text-muted">
                {m.admin_storage_media_retention_healthy({
                  days: retentionDays,
                  hours: sweepHours,
                })}
              </p>
            {/if}
          </div>

          <div class="space-y-1">
            <h3 class="text-xs font-bold uppercase tracking-wide text-text-muted">
              {m.admin_storage_media_unreachable_title()}
            </h3>
            {#if unreachableCount === 0}
              <p class="text-sm text-text-muted">{m.admin_storage_media_unreachable_none()}</p>
            {:else}
              <p class="text-sm font-semibold text-text-main">
                {m.admin_storage_media_unreachable_some({
                  count: unreachableCount,
                  size: formatStorageBytes(unreachable),
                })}
              </p>
              {#if media.untrackedCount > 0}
                <p class="text-sm text-text-muted">
                  {m.admin_storage_media_untracked({
                    count: media.untrackedCount,
                    size: formatStorageBytes(media.untrackedBytes),
                  })}
                </p>
              {/if}
              {#if media.tombstonedCount > 0}
                <p class="text-sm text-text-muted">
                  {m.admin_storage_media_tombstoned({
                    count: media.tombstonedCount,
                    size: formatStorageBytes(media.tombstonedBytes),
                  })}
                </p>
              {/if}
            {/if}
          </div>

          {#if media.publicAssetCount > 0}
            <p class="text-sm text-text-muted">
              {m.admin_storage_media_public({
                count: media.publicAssetCount,
                size: formatStorageBytes(media.publicAssetBytes),
              })}
            </p>
          {/if}
        {:else}
          <p class="text-sm text-text-muted">{m.admin_storage_unavailable()}</p>
        {/if}
      </div>
    </div>
  {/if}
</div>
