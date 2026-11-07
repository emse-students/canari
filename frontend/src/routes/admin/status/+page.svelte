<script lang="ts">
  import { resolve } from '$app/paths';
  import { Log } from '$lib/utils/Log';
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import PresenceLineChart from '$lib/components/admin/PresenceLineChart.svelte';
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { isGlobalAdmin } from '$lib/stores/user';
  import { apiFetch } from '$lib/utils/apiFetch';
  import { gatewayUrl } from '$lib/utils/apiUrl';
  import { RefreshCw } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';
  import {
    devicesByPlatform,
    layersOf,
    versionShares,
    HISTORY_WINDOWS,
    type Census,
    type CensusHistory,
    type HistoryWindow,
  } from '$lib/admin/presenceMonitor';
  import { platformColor, platformLabel, versionLabel } from '$lib/admin/presencePlatforms';

  /**
   * THE PAGE IS COUNTS ONLY (owner, 2026-11-02): how many people and devices are connected, by
   * platform and app version, and 24 hours, 7 days or 30 days of it, one line per platform and one
   * per version. It once listed every connected user and
   * device; neither id is on the wire any more, so this page cannot show one.
   */
  let census = $state<Census | null>(null);
  let history = $state<CensusHistory | null>(null);
  let lastUpdated = $state<Date | null>(null);
  let loading = $state(true);
  // ONE failure flag per source: a success of one must never clear the failure of the other.
  let nowFailed = $state(false);
  let historyFailed = $state(false);
  const error = $derived(nowFailed || historyFailed ? m.admin_status_unknown_error() : null);
  let nowTimer: ReturnType<typeof setInterval>;
  let historyTimer: ReturnType<typeof setInterval>;

  const NOW_REFRESH_MS = 10_000;
  /** The 24 h series gains a point a minute; the 5-minute and 30-minute series gain one far less often. */
  const historyRefreshMs = (w: HistoryWindow) => (w === '24h' ? 60_000 : 300_000);

  let period = $state<HistoryWindow>('24h');

  async function getJson<T>(path: string): Promise<T> {
    const res = await apiFetch(`${gatewayUrl()}${path}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  async function fetchNow() {
    try {
      census = await getJson<Census>('/api/admin/presence');
      lastUpdated = new Date();
      nowFailed = false;
    } catch (e) {
      Log.d('admin.status.fetchNow failed', e);
      nowFailed = true;
    } finally {
      loading = false;
    }
  }

  async function fetchHistory() {
    const asked = period;
    try {
      const answer = await getJson<CensusHistory>(`/api/admin/presence/history?window=${asked}`);
      // A slower answer for a period the reader has since left must not replace the one on screen.
      if (asked !== period) return;
      history = answer;
      historyFailed = false;
    } catch (e) {
      Log.d(`admin.status.fetchHistory failed (${asked})`, e);
      if (asked === period) historyFailed = true;
    }
  }

  /** Switches the period: the old window's curves are dropped (not shown under a new label) and the new one is read at once. */
  function choosePeriod(next: HistoryWindow) {
    if (next === period) return;
    Log.d(`admin.status.period ${period} -> ${next}`);
    period = next;
    history = null;
    void fetchHistory();
    if (!document.hidden) startPolling();
  }

  function refreshAll() {
    void fetchNow();
    void fetchHistory();
  }

  onMount(() => {
    if (!isGlobalAdmin()) {
      void goto(resolve('/admin'), { replace: true });
      return;
    }
    refreshAll();
    startPolling();
    document.addEventListener('visibilitychange', onVisibility);
  });

  onDestroy(() => {
    stopPolling();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility);
    }
  });

  /** Both pollers, started together. A hidden tab polls nothing: see {@link onVisibility}. */
  function startPolling() {
    stopPolling();
    nowTimer = setInterval(() => void fetchNow(), NOW_REFRESH_MS);
    historyTimer = setInterval(() => void fetchHistory(), historyRefreshMs(period));
  }

  function stopPolling() {
    clearInterval(nowTimer);
    clearInterval(historyTimer);
  }

  /**
   * A tab nobody is looking at stops asking the gateway (each request scans the presence keys); the
   * moment it is shown again it reads once at once and resumes - the page never shows a number a
   * hidden tab left stale.
   */
  function onVisibility() {
    if (document.hidden) {
      stopPolling();
      return;
    }
    refreshAll();
    startPolling();
  }

  const platforms = $derived(census ? [...devicesByPlatform(census).entries()] : []);
  const platformOrder = $derived(census ? layersOf([{ t: 0, ...census }]) : ([] as string[]));
  const orderedPlatforms = $derived(
    platformOrder.map((p) => ({ platform: p, devices: platforms.find(([k]) => k === p)?.[1] ?? 0 }))
  );
  const versions = $derived(census ? versionShares(census) : []);
  const percent = (share: number) =>
    new Intl.NumberFormat(getLocale() === 'en' ? 'en-US' : 'fr-FR', {
      style: 'percent',
      maximumFractionDigits: 0,
    }).format(share);
</script>

<PageHeader
  title={m.admin_status_title()}
  subtitle={m.admin_status_subtitle_monitor({ sec: NOW_REFRESH_MS / 1000 })}
>
  {#snippet actions()}
    {#if lastUpdated}
      <span class="text-text-muted text-xs"
        >{m.admin_status_last_updated_label({
          time: lastUpdated.toLocaleTimeString(getLocale() === 'en' ? 'en-US' : 'fr-FR'),
        })}</span
      >
    {/if}
    <button
      onclick={refreshAll}
      class="border-cn-border text-text-muted hover:border-cn-yellow hover:text-text-main flex items-center gap-1.5 rounded-lg border bg-(--cn-surface) px-3 py-1.5 text-sm transition-colors"
    >
      <RefreshCw size={14} />
      {m.common_refresh_button()}
    </button>
  {/snippet}
</PageHeader>

{#if error}
  <div
    class="border-red-err/30 text-red-err mb-4 rounded-xl border bg-[color-mix(in_srgb,var(--red-err)_8%,var(--cn-surface))] px-4 py-3 text-sm"
  >
    {error}
  </div>
{/if}

{#if loading}
  <div class="text-text-muted">{m.common_loading_label()}</div>
{:else if census}
  <!-- Right now -->
  <section class="mb-8" aria-labelledby="status-now">
    <h2
      id="status-now"
      class="text-text-muted mb-3 text-xs font-semibold tracking-widest uppercase"
    >
      {m.admin_status_now_heading()}
    </h2>
    <div class="grid grid-cols-2 gap-3">
      <div class="border-cn-border rounded-xl border bg-(--cn-surface) p-4">
        <p class="text-text-main text-3xl font-semibold" data-testid="status-users">
          {census.users}
        </p>
        <p class="text-text-muted text-sm">{m.admin_status_total_users()}</p>
      </div>
      <div class="border-cn-border rounded-xl border bg-(--cn-surface) p-4">
        <p class="text-text-main text-3xl font-semibold" data-testid="status-devices">
          {census.devices}
        </p>
        <p class="text-text-muted text-sm">{m.admin_status_total_devices()}</p>
      </div>
    </div>
    {#if orderedPlatforms.length > 0}
      <ul class="mt-3 flex flex-wrap gap-2">
        {#each orderedPlatforms as p (p.platform)}
          <li
            class="border-cn-border text-text-main flex items-center gap-2 rounded-full border bg-(--cn-surface) px-3 py-1 text-sm"
          >
            <span
              class="inline-block size-2.5 rounded-full"
              style:background-color={platformColor(p.platform)}
              aria-hidden="true"
            ></span>
            {platformLabel(p.platform)}
            <span class="text-text-muted">{p.devices}</span>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <!-- History: one line per platform, one per version -->
  <section class="mb-8" aria-labelledby="status-history">
    <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h2
        id="status-history"
        class="text-text-muted text-xs font-semibold tracking-widest uppercase"
      >
        {m.admin_status_history_heading()}
      </h2>
      <div
        role="group"
        aria-label={m.admin_status_period_label()}
        class="border-cn-border flex overflow-hidden rounded-lg border bg-(--cn-surface) text-sm"
      >
        {#each HISTORY_WINDOWS as w (w)}
          <button
            type="button"
            aria-pressed={period === w}
            data-testid="period-{w}"
            onclick={() => choosePeriod(w)}
            class="px-3 py-1.5 transition-colors {period === w
              ? 'bg-cn-yellow text-black'
              : 'text-text-muted hover:text-text-main'}"
          >
            {w === '24h'
              ? m.admin_status_period_24h()
              : w === '7d'
                ? m.admin_status_period_7d()
                : m.admin_status_period_30d()}
          </button>
        {/each}
      </div>
    </div>
    <p class="text-text-muted mb-3 text-sm">{m.admin_status_history_hint()}</p>
    {#if history}
      <h3 class="text-text-main mb-1 text-sm font-medium">
        {m.admin_status_chart_platforms_heading()}
      </h3>
      <PresenceLineChart {history} axis="platform" />
      <h3 class="text-text-main mt-6 mb-1 text-sm font-medium">
        {m.admin_status_chart_versions_heading()}
      </h3>
      <PresenceLineChart {history} axis="version" />
      <p class="text-text-muted mt-3 text-xs">{m.admin_status_chart_gap_hint()}</p>
    {:else}
      <div class="text-text-muted text-sm">{m.common_loading_label()}</div>
    {/if}
  </section>

  <!-- Versions live right now -->
  <section aria-labelledby="status-versions">
    <h2
      id="status-versions"
      class="text-text-muted mb-1 text-xs font-semibold tracking-widest uppercase"
    >
      {m.admin_status_versions_heading()}
    </h2>
    <p class="text-text-muted mb-3 text-sm">{m.admin_status_versions_hint()}</p>
    {#if versions.some((v) => v.version === 'unknown')}
      <p class="text-text-muted mb-3 text-sm" data-testid="status-unknown-explainer">
        {m.admin_status_versions_unknown_explainer()}
      </p>
    {/if}
    {#if versions.length === 0}
      <p class="text-text-muted text-sm">{m.admin_status_versions_empty()}</p>
    {:else}
      <ul class="border-cn-border divide-cn-border divide-y rounded-xl border bg-(--cn-surface)">
        {#each versions as v (v.version)}
          <li class="px-4 py-3" data-testid="status-version">
            <div class="flex items-baseline justify-between gap-3">
              <span class="text-text-main font-mono text-sm font-medium"
                >{versionLabel(v.version)}</span
              >
              <span class="text-text-muted text-sm">
                {m.admin_status_version_count({ count: v.devices })} - {percent(v.share)}
              </span>
            </div>
            <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-(--surface-elevated)">
              <div class="flex h-full gap-0.5" style:width="{Math.max(v.share * 100, 1)}%">
                {#each v.platforms as p (p.platform)}
                  <div
                    class="h-full"
                    style:flex-grow={p.devices}
                    style:background-color={platformColor(p.platform)}
                  ></div>
                {/each}
              </div>
            </div>
            <ul class="text-text-muted mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
              {#each v.platforms as p (p.platform)}
                <li class="flex items-center gap-1.5" data-testid="status-version-platform">
                  <span
                    class="inline-block size-2 rounded-full"
                    style:background-color={platformColor(p.platform)}
                    aria-hidden="true"
                  ></span>
                  {platformLabel(p.platform)}
                  {p.devices}
                </li>
              {/each}
            </ul>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
{/if}
