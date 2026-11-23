<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { RefreshCw } from '@lucide/svelte';
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import { m } from '$lib/paraglide/messages';
  import { isGlobalAdmin } from '$lib/stores/user';
  import { apiFetch } from '$lib/utils/apiFetch';
  import { socialUrl } from '$lib/utils/apiUrl';
  import { intlLocale } from '$lib/utils/intlLocale';
  import { Log } from '$lib/utils/Log';
  import {
    ACTIVITY_METRICS,
    USAGE_CATEGORIES,
    activityByMonth,
    activityLabel,
    categoryLabel,
    hourMapMax,
    versionsOf,
    type UsagePeriod,
    type UsageView,
  } from '$lib/admin/usageDashboard';

  /**
   * THE USAGE DASHBOARD (owner, 2026-11-16 and 2026-11-19; docs/wiki/usage-dashboard.md): who uses
   * Canari, counted without keeping who - distinct people per day, week and month, by device type
   * and version, when in the week, and the platform's daily activity. Platform admins only, figures
   * only: no person is on the wire, so this page cannot show one.
   */
  let view = $state<UsageView | null>(null);
  let loading = $state(true);
  let failed = $state(false);

  /** How many days the bar chart and the activity table show. */
  const CHART_DAYS = 31;
  const ACTIVITY_DAYS = 14;

  async function load() {
    Log.d('admin.usage.load');
    loading = view === null;
    try {
      const res = await apiFetch(`${socialUrl()}/api/admin/usage`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      view = (await res.json()) as UsageView;
      failed = false;
    } catch (e) {
      Log.d('admin.usage.load failed', e);
      failed = true;
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    if (!isGlobalAdmin()) {
      void goto(resolve('/admin'), { replace: true });
      return;
    }
    void load();
  });

  const dayFmt = $derived(
    new Intl.DateTimeFormat(intlLocale(), { day: 'numeric', month: 'short', timeZone: 'UTC' })
  );
  const monthFmt = $derived(
    new Intl.DateTimeFormat(intlLocale(), { month: 'long', year: 'numeric', timeZone: 'UTC' })
  );
  const weekdayFmt = $derived(
    new Intl.DateTimeFormat(intlLocale(), { weekday: 'short', timeZone: 'UTC' })
  );
  /** A `YYYY-MM-DD` day as a calendar date, read at noon UTC so no zone moves it. */
  const asDate = (day: string) => new Date(`${day}T12:00:00Z`);

  const last = <T>(list: T[] | undefined): T | undefined => list?.[list.length - 1];
  const today = $derived(view?.days.find((d) => d.start === view?.today));
  const thisWeek = $derived(last(view?.weeks));
  const thisMonth = $derived(last(view?.months));
  const chartDays = $derived(view ? view.days.slice(-CHART_DAYS) : []);
  const chartMax = $derived(Math.max(1, ...chartDays.map((d) => d.people.all)));
  const activityDays = $derived(view ? view.days.slice(-ACTIVITY_DAYS).reverse() : []);
  const activityMonths = $derived(view ? activityByMonth(view.days).reverse() : []);
  const monthVersions = $derived(versionsOf(thisMonth));
  const hourMax = $derived(view ? hourMapMax(view.hours.cells) : 0);
  /** Monday first: 2026-11-23 is a Monday, so the week from it names the seven days in order. */
  const weekdays = $derived(
    Array.from({ length: 7 }, (_, i) => weekdayFmt.format(asDate(`2026-11-${23 + i}`)))
  );

  /** The single-hue scale of the hour map: the accent at a strength proportional to the cell. */
  const cellColor = (value: number) =>
    value <= 0 || hourMax <= 0
      ? 'var(--surface-elevated)'
      : `color-mix(in srgb, var(--chart-series-1) ${Math.round(15 + (85 * value) / hourMax)}%, var(--cn-surface))`;

  const categoryRows = $derived(
    [
      { label: m.admin_usage_period_today(), period: today },
      { label: m.admin_usage_period_week(), period: thisWeek },
      { label: m.admin_usage_period_month(), period: thisMonth },
    ].filter(
      (r): r is { label: (typeof r)['label']; period: UsagePeriod } => r.period !== undefined
    )
  );
</script>

<PageHeader title={m.admin_usage_title()} subtitle={m.admin_usage_subtitle()}>
  {#snippet actions()}
    <Button variant="secondary" size="compact" onclick={() => void load()}>
      <RefreshCw size={14} />
      {m.common_refresh_button()}
    </Button>
  {/snippet}
</PageHeader>

{#if failed}
  <div
    class="border-red-err/30 text-red-err mb-4 rounded-xl border bg-[color-mix(in_srgb,var(--red-err)_8%,var(--cn-surface))] px-4 py-3 text-sm"
    data-testid="usage-error"
  >
    {m.admin_usage_error()}
  </div>
{/if}

{#if loading}
  <div class="text-text-muted">{m.common_loading_label()}</div>
{:else if view}
  <p class="text-text-muted mb-6 text-sm">{m.admin_usage_explainer()}</p>

  <!-- Distinct people now: today, this week, this month -->
  <section class="mb-8" aria-labelledby="usage-people">
    <h2 id="usage-people" class="text-text-muted mb-3 text-xs font-semibold">
      {m.admin_usage_people_heading()}
    </h2>
    <div class="grid grid-cols-3 gap-3">
      {#each [{ label: m.admin_usage_period_today(), period: today, id: 'today' }, { label: m.admin_usage_period_week(), period: thisWeek, id: 'week' }, { label: m.admin_usage_period_month(), period: thisMonth, id: 'month' }] as tile (tile.id)}
        <div class="border-cn-border rounded-xl border bg-(--cn-surface) p-4">
          <p class="text-text-main text-3xl font-semibold" data-testid="usage-people-{tile.id}">
            {tile.period?.people.all ?? 0}
          </p>
          <p class="text-text-muted text-sm">{tile.label}</p>
        </div>
      {/each}
    </div>
  </section>

  <!-- People per day: one series, so the title names it and no legend is drawn -->
  <section class="mb-8" aria-labelledby="usage-days">
    <h2 id="usage-days" class="text-text-muted mb-3 text-xs font-semibold">
      {m.admin_usage_days_heading({ days: CHART_DAYS })}
    </h2>
    {#if chartDays.length === 0}
      <p class="text-text-muted text-sm">{m.admin_usage_empty()}</p>
    {:else}
      <div
        class="border-cn-border flex h-40 items-end gap-0.5 rounded-xl border bg-(--cn-surface) p-3"
        role="img"
        aria-label={m.admin_usage_days_heading({ days: CHART_DAYS })}
      >
        {#each chartDays as d (d.start)}
          <div
            class="group relative flex h-full flex-1 items-end"
            title={m.admin_usage_day_tooltip({
              day: dayFmt.format(asDate(d.start)),
              count: d.people.all,
            })}
            data-testid="usage-day-bar"
          >
            <div
              class="w-full rounded-t-sm bg-(--chart-series-1) group-hover:opacity-80"
              style:height="{Math.max((d.people.all / chartMax) * 100, d.people.all > 0 ? 2 : 0)}%"
            ></div>
          </div>
        {/each}
      </div>
      <div class="text-text-muted mt-1 flex justify-between text-xs">
        <span>{dayFmt.format(asDate(chartDays[0].start))}</span>
        <span>{dayFmt.format(asDate(chartDays[chartDays.length - 1].start))}</span>
      </div>
    {/if}
  </section>

  <!-- By device type -->
  <section class="mb-8" aria-labelledby="usage-categories">
    <h2 id="usage-categories" class="text-text-muted mb-1 text-xs font-semibold">
      {m.admin_usage_categories_heading()}
    </h2>
    <p class="text-text-muted mb-3 text-sm">{m.admin_usage_categories_hint()}</p>
    <div class="border-cn-border overflow-x-auto rounded-xl border bg-(--cn-surface)">
      <table class="w-full text-sm">
        <thead>
          <tr class="text-text-muted text-left text-xs">
            <th class="px-3 py-2 font-medium">{m.admin_usage_category_column()}</th>
            {#each categoryRows as r (r.label)}
              <th class="px-3 py-2 text-right font-medium">{r.label}</th>
            {/each}
          </tr>
        </thead>
        <tbody class="divide-cn-border divide-y">
          {#each USAGE_CATEGORIES as c (c)}
            <tr data-testid="usage-category">
              <td class="text-text-main px-3 py-2">{categoryLabel(c)}</td>
              {#each categoryRows as r (r.label)}
                <td class="text-text-main px-3 py-2 text-right tabular-nums">
                  {r.period.people.categories[c] ?? 0}
                </td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>

  <!-- Versions this month -->
  <section class="mb-8" aria-labelledby="usage-versions">
    <h2 id="usage-versions" class="text-text-muted mb-3 text-xs font-semibold">
      {m.admin_usage_versions_heading()}
    </h2>
    {#if monthVersions.length === 0}
      <p class="text-text-muted text-sm">{m.admin_usage_empty()}</p>
    {:else}
      <ul class="border-cn-border divide-cn-border divide-y rounded-xl border bg-(--cn-surface)">
        {#each monthVersions as v (v.version)}
          <li
            class="flex items-baseline justify-between px-4 py-2 text-sm"
            data-testid="usage-version"
          >
            <span class="text-text-main font-mono">{v.version}</span>
            <span class="text-text-muted tabular-nums"
              >{m.admin_usage_people_count({ count: v.people })}</span
            >
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <!-- Week by hour -->
  <section class="mb-8" aria-labelledby="usage-hours">
    <h2 id="usage-hours" class="text-text-muted mb-1 text-xs font-semibold">
      {m.admin_usage_hours_heading()}
    </h2>
    <p class="text-text-muted mb-3 text-sm">
      {m.admin_usage_hours_hint({
        from: dayFmt.format(asDate(view.hours.from)),
        to: dayFmt.format(asDate(view.hours.to)),
      })}
    </p>
    <div class="overflow-x-auto">
      <table class="border-separate border-spacing-0.5 text-xs" data-testid="usage-hour-map">
        <thead>
          <tr>
            <th></th>
            {#each Array.from({ length: 24 }, (_, h) => h) as h (h)}
              <th class="text-text-muted w-6 font-normal">{h % 3 === 0 ? h : ''}</th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each view.hours.cells as row, d (d)}
            <tr>
              <th class="text-text-muted pr-2 text-left font-normal">{weekdays[d]}</th>
              {#each row as value, h (h)}
                <td
                  class="h-6 w-6 rounded-sm"
                  style:background-color={cellColor(value)}
                  title={m.admin_usage_hour_tooltip({ day: weekdays[d], hour: h, count: value })}
                ></td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>

  <!-- Activity, per day only -->
  <section class="mb-8" aria-labelledby="usage-activity">
    <h2 id="usage-activity" class="text-text-muted mb-1 text-xs font-semibold">
      {m.admin_usage_activity_heading()}
    </h2>
    <p class="text-text-muted mb-3 text-sm">{m.admin_usage_activity_hint()}</p>
    {#each [{ id: 'days', rows: activityDays.map( (d) => ({ label: dayFmt.format(asDate(d.start)), activity: d.activity }) ) }, { id: 'months', rows: activityMonths.map( (mo) => ({ label: monthFmt.format(asDate(mo.start)), activity: mo.activity }) ) }] as block (block.id)}
      <div class="border-cn-border mb-4 overflow-x-auto rounded-xl border bg-(--cn-surface)">
        <table class="w-full text-sm" data-testid="usage-activity-{block.id}">
          <thead>
            <tr class="text-text-muted text-left text-xs">
              <th class="px-3 py-2 font-medium">
                {block.id === 'days' ? m.admin_usage_day_column() : m.admin_usage_month_column()}
              </th>
              {#each ACTIVITY_METRICS as k (k)}
                <th class="px-3 py-2 text-right font-medium">{activityLabel(k)}</th>
              {/each}
            </tr>
          </thead>
          <tbody class="divide-cn-border divide-y">
            {#each block.rows as r (r.label)}
              <tr>
                <td class="text-text-main px-3 py-2">{r.label}</td>
                {#each ACTIVITY_METRICS as k (k)}
                  <td class="text-text-main px-3 py-2 text-right tabular-nums">
                    {r.activity?.[k] ?? 0}
                  </td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/each}
  </section>

  <!-- People per month: the year-on-year comparison the history is kept for -->
  <section aria-labelledby="usage-months">
    <h2 id="usage-months" class="text-text-muted mb-3 text-xs font-semibold">
      {m.admin_usage_months_heading()}
    </h2>
    {#if view.months.length === 0}
      <p class="text-text-muted text-sm">{m.admin_usage_empty()}</p>
    {:else}
      <ul class="border-cn-border divide-cn-border divide-y rounded-xl border bg-(--cn-surface)">
        {#each [...view.months].reverse() as mo (mo.start)}
          <li
            class="flex items-baseline justify-between px-4 py-2 text-sm"
            data-testid="usage-month"
          >
            <span class="text-text-main">{monthFmt.format(asDate(mo.start))}</span>
            <span class="text-text-muted tabular-nums"
              >{m.admin_usage_people_count({ count: mo.people.all })}</span
            >
          </li>
        {/each}
      </ul>
    {/if}
  </section>
{/if}
