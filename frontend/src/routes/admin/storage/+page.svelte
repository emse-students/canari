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
  const mls = $derived(usage?.mls ?? null);

  /**
   * Table bars, largest first, sized against the largest - the question is which table dominates.
   *
   * Each bar carries a SECOND, darker fill for the live data inside it, on the same scale. That is
   * what makes "73 Mo of file holding 1 Mo of queue" visible rather than arithmetic: the bar is long
   * because the table costs that much disk, and almost empty because almost none of it is data.
   * `liveBytes` is an estimate and `bytes` is exact, so the inner fill is clamped - a statistic that
   * overshoots its container would draw a table as MORE than full.
   */
  const tableBars = $derived.by(() => {
    if (!mls || mls.tables.length === 0) return [];
    const largest = Math.max(1, ...mls.tables.map((t) => t.bytes));
    return mls.tables.map((t) => {
      const percent = Math.max(t.bytes > 0 ? 2 : 0, Math.round((t.bytes / largest) * 100));
      const liveShare = t.bytes > 0 ? Math.min(1, t.liveBytes / t.bytes) : 0;
      return { ...t, percent, livePercent: Math.round(percent * liveShare) };
    });
  });

  /** The queue's weekly bars, reversed like the media ones so time reads left to right. */
  const queueBars = $derived.by(() => {
    if (!mls?.queue) return [];
    const tallest = Math.max(1, ...mls.queue.rowsByWeek);
    return mls.queue.rowsByWeek
      .map((rows, index) => ({
        index,
        rows,
        percent: Math.max(rows > 0 ? 2 : 0, Math.round((rows / tallest) * 100)),
      }))
      .reverse();
  });

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
    <p class="text-text-muted text-sm">{m.admin_storage_desc()}</p>
    <button
      type="button"
      onclick={() => void load()}
      disabled={loading}
      class="border-cn-border text-text-main hover:border-cn-yellow/40 inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-sm font-bold transition-all disabled:opacity-50"
    >
      <RefreshCw size={14} class={loading ? 'animate-spin' : ''} />
      {m.common_refresh_button()}
    </button>
  </div>

  {#if loading && !usage}
    <div class="flex justify-center py-16">
      <div
        class="border-cn-yellow h-8 w-8 animate-spin rounded-full border-4 border-t-transparent"
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
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div class="border-cn-border space-y-3 rounded-2xl border bg-(--cn-surface) p-5">
        <div class="flex items-center gap-2.5">
          <span
            class="bg-cn-yellow/10 text-cn-dark flex h-9 w-9 items-center justify-center rounded-xl"
          >
            <HardDrive size={18} />
          </span>
          <h2 class="text-text-main font-bold">{m.admin_storage_disk_label()}</h2>
        </div>
        {#if usage.diskTotalBytes !== null && usage.diskUsedBytes !== null}
          <div class="bg-cn-border h-2 overflow-hidden rounded-full">
            <div class="bg-cn-yellow h-full" style="width: {diskUsedPercent}%"></div>
          </div>
          <p class="text-text-muted text-sm">
            {m.admin_storage_disk_used({
              used: formatStorageBytes(usage.diskUsedBytes),
              total: formatStorageBytes(usage.diskTotalBytes),
              percent: diskUsedPercent ?? 0,
            })}
          </p>
        {:else}
          <p class="text-text-muted text-sm">{m.admin_storage_unavailable()}</p>
        {/if}
      </div>

      <div class="border-cn-border space-y-3 rounded-2xl border bg-(--cn-surface) p-5">
        <div class="flex items-center gap-2.5">
          <span
            class="bg-cn-yellow/10 text-cn-dark flex h-9 w-9 items-center justify-center rounded-xl"
          >
            <Database size={18} />
          </span>
          <h2 class="text-text-main font-bold">{m.admin_storage_postgres_label()}</h2>
        </div>
        {#if usage.postgresBytes !== null}
          <p class="text-text-main text-2xl font-extrabold">
            {formatStorageBytes(usage.postgresBytes)}
          </p>
        {:else}
          <p class="text-text-muted text-sm">{m.admin_storage_unavailable()}</p>
        {/if}
      </div>

      <div class="border-cn-border space-y-3 rounded-2xl border bg-(--cn-surface) p-5">
        <div class="flex items-center gap-2.5">
          <span
            class="bg-cn-yellow/10 text-cn-dark flex h-9 w-9 items-center justify-center rounded-xl"
          >
            <HardDrive size={18} />
          </span>
          <h2 class="text-text-main font-bold">{m.admin_storage_redis_label()}</h2>
        </div>
        {#if usage.redisBytes !== null}
          <p class="text-text-main text-2xl font-extrabold">
            {formatStorageBytes(usage.redisBytes)}
          </p>
        {:else}
          <p class="text-text-muted text-sm">{m.admin_storage_unavailable()}</p>
        {/if}
      </div>

      <!-- The media bucket answers WHY it is that size, not only how much: the growth bars and the
           retention verdict have opposite fixes and a single total cannot tell them apart. -->
      <div
        class="border-cn-border space-y-5 rounded-2xl border bg-(--cn-surface) p-5 sm:col-span-2"
      >
        <div class="flex items-center gap-2.5">
          <span
            class="bg-cn-yellow/10 text-cn-dark flex h-9 w-9 items-center justify-center rounded-xl"
          >
            <Server size={18} />
          </span>
          <h2 class="text-text-main font-bold">{m.admin_storage_garage_label()}</h2>
        </div>

        {#if media}
          <div>
            <p class="text-text-main text-2xl font-extrabold">
              {formatStorageBytes(media.totalBytes)}
            </p>
            <p class="text-text-muted text-sm">
              {m.admin_storage_garage_object_count({ count: media.objectCount })}
            </p>
          </div>

          <div class="space-y-2">
            <h3 class="text-text-muted text-xs font-bold tracking-wide uppercase">
              {m.admin_storage_media_growth_title()}
            </h3>
            <div class="flex h-24 items-end gap-2">
              {#each weekBars as bar (bar.index)}
                <div class="flex h-full flex-1 flex-col items-center justify-end gap-1.5">
                  <span class="text-text-main text-[0.65rem] font-bold">
                    {formatStorageBytes(bar.bytes)}
                  </span>
                  <div
                    class="bg-cn-yellow/70 w-full rounded-t-lg"
                    style="height: {bar.percent}%"
                  ></div>
                  <span class="text-text-muted text-center text-[0.65rem]">
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
            <p class="text-text-muted text-sm">
              {m.admin_storage_media_older({
                days: barsSpanDays,
                size: formatStorageBytes(media.olderBytes),
              })}
            </p>
            {#if media.undatedCount > 0}
              <p class="text-text-muted text-sm">
                {m.admin_storage_media_undated({ count: media.undatedCount })}
              </p>
            {/if}
          </div>

          <div class="space-y-1">
            <h3 class="text-text-muted text-xs font-bold tracking-wide uppercase">
              {m.admin_storage_media_retention_title()}
            </h3>
            {#if retention?.kind === 'stalled'}
              <p class="flex items-start gap-2 text-sm font-semibold text-red-500">
                <TriangleAlert size={16} class="mt-0.5 shrink-0" />
                {m.admin_storage_media_retention_stalled({
                  count: retention.count,
                  size: formatStorageBytes(retention.bytes),
                  age: Math.round(retention.oldestMs / DAY_MS),
                  days: retentionDays,
                })}
              </p>
            {:else if retention?.kind === 'pending'}
              <p class="text-text-muted text-sm">
                {m.admin_storage_media_retention_pending({
                  count: retention.count,
                  size: formatStorageBytes(retention.bytes),
                  days: retentionDays,
                })}
              </p>
            {:else}
              <p class="text-text-muted text-sm">
                {m.admin_storage_media_retention_healthy({
                  days: retentionDays,
                  hours: sweepHours,
                })}
              </p>
            {/if}
          </div>

          <div class="space-y-1">
            <h3 class="text-text-muted text-xs font-bold tracking-wide uppercase">
              {m.admin_storage_media_unreachable_title()}
            </h3>
            {#if unreachableCount === 0}
              <p class="text-text-muted text-sm">{m.admin_storage_media_unreachable_none()}</p>
            {:else}
              <p class="text-text-main text-sm font-semibold">
                {m.admin_storage_media_unreachable_some({
                  count: unreachableCount,
                  size: formatStorageBytes(unreachable),
                })}
              </p>
              {#if media.untrackedCount > 0}
                <p class="text-text-muted text-sm">
                  {m.admin_storage_media_untracked({
                    count: media.untrackedCount,
                    size: formatStorageBytes(media.untrackedBytes),
                  })}
                </p>
              {/if}
              {#if media.tombstonedCount > 0}
                <p class="text-text-muted text-sm">
                  {m.admin_storage_media_tombstoned({
                    count: media.tombstonedCount,
                    size: formatStorageBytes(media.tombstonedBytes),
                  })}
                </p>
              {/if}
            {/if}
          </div>

          {#if media.publicAssetCount > 0}
            <p class="text-text-muted text-sm">
              {m.admin_storage_media_public({
                count: media.publicAssetCount,
                size: formatStorageBytes(media.publicAssetBytes),
              })}
            </p>
          {/if}
        {:else}
          <p class="text-text-muted text-sm">{m.admin_storage_unavailable()}</p>
        {/if}
      </div>

      <!-- The MLS half. Postgres and Redis are bare totals above; this says what they are MADE of,
           and it is display only - the user's call of 2026-08-17 was a panel and no alert. Nothing
           here classifies: a threshold nobody has measured against the population would be a line
           its reader learns to skip. -->
      <div
        class="border-cn-border space-y-5 rounded-2xl border bg-(--cn-surface) p-5 sm:col-span-2"
      >
        <div class="flex items-center gap-2.5">
          <span
            class="bg-cn-yellow/10 text-cn-dark flex h-9 w-9 items-center justify-center rounded-xl"
          >
            <Database size={18} />
          </span>
          <h2 class="text-text-main font-bold">{m.admin_storage_mls_title()}</h2>
        </div>
        <p class="text-text-muted text-sm">{m.admin_storage_mls_desc()}</p>

        {#if mls}
          {#if mls.tables.length > 0}
            <div class="space-y-2">
              <h3 class="text-text-muted text-xs font-bold tracking-wide uppercase">
                {m.admin_storage_mls_tables_title()}
              </h3>
              <!-- Why two sizes. "72.9 Mo, 817 lignes" was read here on 2026-08-19 as a 90 kB
                   average message; the average is under 1 kB, and the gap is the high-water mark of
                   an incident three weeks past. Both figures are always shown: a number that
                   appears only when it disagrees is one nobody trusts when it does. -->
              <p class="text-text-muted text-xs">{m.admin_storage_mls_tables_hint()}</p>
              {#each tableBars as row (row.table)}
                <div class="space-y-1">
                  <div class="flex items-baseline justify-between gap-3">
                    <span class="text-text-main text-sm font-semibold">{row.table}</span>
                    <span class="text-text-muted text-sm">
                      {formatStorageBytes(row.bytes)} &middot;
                      {m.admin_storage_mls_table_live({
                        size: formatStorageBytes(row.liveBytes),
                      })} &middot;
                      {m.admin_storage_mls_table_rows({ rows: row.rows })}
                    </span>
                  </div>
                  <!-- Pale fill: what the table occupies. Solid fill: what is actually in it. -->
                  <div class="bg-cn-border/40 relative h-1.5 w-full rounded-full">
                    <div
                      class="bg-cn-yellow/30 absolute inset-y-0 left-0 rounded-full"
                      style="width: {row.percent}%"
                    ></div>
                    <div
                      class="bg-cn-yellow/80 absolute inset-y-0 left-0 rounded-full"
                      style="width: {row.livePercent}%"
                    ></div>
                  </div>
                </div>
              {/each}
            </div>
          {/if}

          <div class="space-y-2">
            <h3 class="text-text-muted text-xs font-bold tracking-wide uppercase">
              {m.admin_storage_mls_queue_title()}
            </h3>
            {#if !mls.queue}
              <p class="text-text-muted text-sm">{m.admin_storage_unavailable()}</p>
            {:else if mls.queue.rows === 0}
              <p class="text-text-muted text-sm">{m.admin_storage_mls_queue_empty()}</p>
            {:else}
              <p class="text-text-main text-sm">
                {m.admin_storage_mls_queue_summary({
                  rows: mls.queue.rows,
                  devices: mls.queue.devices,
                })}
              </p>
              <!-- The number a total cannot show: forty devices with twenty messages and one device
                   with eight hundred read the same until this line. -->
              <p class="text-text-muted text-sm">
                {m.admin_storage_mls_queue_deepest({ count: mls.queue.deepest })}
              </p>
              {#if mls.queue.oldestMs !== null}
                <p class="text-text-muted text-sm">
                  {m.admin_storage_mls_queue_oldest({
                    days: Math.round(mls.queue.oldestMs / DAY_MS),
                  })}
                </p>
              {/if}
              <h4 class="text-text-muted pt-2 text-xs font-bold tracking-wide uppercase">
                {m.admin_storage_mls_queue_growth()}
              </h4>
              <div class="flex h-20 items-end gap-2">
                {#each queueBars as bar (bar.index)}
                  <div class="flex h-full flex-1 flex-col items-center justify-end gap-1.5">
                    <span class="text-text-main text-[0.65rem] font-bold">{bar.rows}</span>
                    <div
                      class="bg-cn-yellow/70 w-full rounded-t-lg"
                      style="height: {bar.percent}%"
                    ></div>
                    <span class="text-text-muted text-center text-[0.65rem]">
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
            {/if}
          </div>

          <div class="space-y-1">
            <h3 class="text-text-muted text-xs font-bold tracking-wide uppercase">
              {m.admin_storage_mls_ghosts_title()}
            </h3>
            {#if !mls.ghosts}
              <p class="text-text-muted text-sm">{m.admin_storage_unavailable()}</p>
            {:else if mls.ghosts.devicesWithoutKeyPackage === 0}
              <!-- The zero is shown on purpose: a counter that only appears when it is non-zero is
                   a counter nobody believes the first time it does. -->
              <p class="text-text-muted text-sm">
                {m.admin_storage_mls_ghosts_none({ devices: mls.ghosts.devicesWithMemberships })}
              </p>
            {:else}
              <p class="text-text-main text-sm font-semibold">
                {m.admin_storage_mls_ghosts_some({
                  count: mls.ghosts.devicesWithoutKeyPackage,
                  devices: mls.ghosts.devicesWithMemberships,
                  memberships: mls.ghosts.orphanMemberships,
                })}
              </p>
            {/if}
          </div>

          <div class="space-y-1">
            <h3 class="text-text-muted text-xs font-bold tracking-wide uppercase">
              {m.admin_storage_mls_redis_title()}
            </h3>
            {#if !mls.redisKeyspace}
              <p class="text-text-muted text-sm">{m.admin_storage_unavailable()}</p>
            {:else}
              <p class="text-text-main text-sm">
                {m.admin_storage_mls_redis_summary({
                  keys: mls.redisKeyspace.keys,
                  sampled: mls.redisKeyspace.sampled,
                })}
              </p>
              <ul class="flex flex-wrap gap-x-4 gap-y-1">
                {#each mls.redisKeyspace.byPrefix as entry (entry.prefix)}
                  <li class="text-text-muted text-sm">
                    {m.admin_storage_mls_redis_prefix({
                      prefix: entry.prefix,
                      keys: entry.keys,
                    })}
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        {:else}
          <p class="text-text-muted text-sm">{m.admin_storage_unavailable()}</p>
        {/if}
      </div>
    </div>
  {/if}
</div>
