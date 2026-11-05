<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';
  import { buildBuckets, type CensusHistory } from '$lib/admin/presenceMonitor';
  import {
    TOTAL_DASH,
    buildSeries,
    peakOf,
    smoothPaths,
    totalValues,
    type Axis,
  } from '$lib/admin/presenceSeries';
  import { platformLabel, versionLabel } from '$lib/admin/presencePlatforms';
  import { Log } from '$lib/utils/Log';

  interface Props {
    /** The window to draw, as `/api/admin/presence/history` answers. */
    history: CensusHistory;
    /** What a line is: a platform or a version. */
    axis: Axis;
  }

  let { history, axis }: Props = $props();

  const BOX = { width: 1000, height: 200 };
  /** The key of the dashed total line in the hidden set; never a platform or a version string. */
  const TOTAL_KEY = '\u0000total';

  const buckets = $derived(buildBuckets(history));
  const series = $derived(buildSeries(buckets, axis));
  const total = $derived(totalValues(buckets));
  const empty = $derived(history.samples.length === 0);

  // Hidden lines are kept BY KEY: a refresh that adds a version must not un-hide the others.
  const hidden = new SvelteSet<string>();
  const visible = $derived(series.filter((s) => !hidden.has(s.key)));
  const totalShown = $derived(!hidden.has(TOTAL_KEY));
  const peak = $derived(peakOf([...visible.map((s) => s.values), ...(totalShown ? [total] : [])]));

  const lines = $derived(visible.map((s) => ({ ...s, paths: smoothPaths(s.values, BOX, peak) })));
  const totalPaths = $derived(totalShown ? smoothPaths(total, BOX, peak) : []);

  function toggle(key: string) {
    if (hidden.has(key)) hidden.delete(key);
    else hidden.add(key);
    Log.d(`admin.status.chart toggle ${axis}: ${hidden.has(key) ? 'hid' : 'showed'}`, key);
  }

  // The selected point is kept BY TIMESTAMP, never by index: the refresh slides the window, and an
  // index would then point at the point after the one the reader was on.
  let selectedT = $state<number | null>(null);
  let focused = $state(false);
  const hovered = $derived.by(() => {
    if (selectedT === null) return null;
    const at = buckets.findIndex((b) => b.t === selectedT);
    return at >= 0 ? at : null;
  });
  const reading = $derived(hovered === null ? null : (buckets[hovered] ?? null));

  function select(index: number | null) {
    selectedT = index === null ? null : (buckets[index]?.t ?? null);
  }

  /**
   * The readout is reachable without a pointer: the chart takes focus, shows the latest point, and
   * the arrows, Home and End walk the points. Escape clears it.
   */
  function onKey(event: KeyboardEvent) {
    const last = buckets.length - 1;
    if (last < 0) return;
    const at = hovered ?? last;
    const next: Record<string, number> = {
      ArrowLeft: Math.max(at - 1, 0),
      ArrowRight: Math.min(at + 1, last),
      Home: 0,
      End: last,
    };
    if (event.key === 'Escape') {
      select(null);
    } else if (event.key in next) {
      select(next[event.key]);
    } else {
      return;
    }
    event.preventDefault();
  }

  function moveTo(event: PointerEvent) {
    const rect = (event.currentTarget as Element).getBoundingClientRect();
    if (rect.width === 0 || buckets.length === 0) return;
    const ratio = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
    select(Math.min(buckets.length - 1, Math.floor(ratio * buckets.length)));
  }

  const locale = $derived(getLocale() === 'en' ? 'en-US' : 'fr-FR');
  const longWindow = $derived(history.windowSecs > 24 * 60 * 60);
  /** A point's time: the clock for a day, the date and the clock beyond it. */
  function stamp(t: number): string {
    return new Date(t * 1000).toLocaleString(
      locale,
      longWindow
        ? { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }
        : { hour: '2-digit', minute: '2-digit' }
    );
  }
  /** An axis tick: the clock for a day, the date beyond it. */
  function tick(t: number): string {
    return new Date(t * 1000).toLocaleString(
      locale,
      longWindow ? { day: 'numeric', month: 'short' } : { hour: '2-digit', minute: '2-digit' }
    );
  }
  const ticks = $derived(
    buckets.length === 0
      ? []
      : [0, 0.25, 0.5, 0.75, 1].map(
          (f) => buckets[Math.min(buckets.length - 1, Math.round(f * (buckets.length - 1)))].t
        )
  );
  const labelOf = (key: string) => (axis === 'platform' ? platformLabel(key) : versionLabel(key));

  const readingText = $derived(
    !reading
      ? ''
      : reading.sample
        ? m.admin_status_chart_reading({
            time: stamp(reading.t),
            devices: reading.sample.devices,
            users: reading.sample.users,
          })
        : m.admin_status_chart_reading_gap({ time: stamp(reading.t) })
  );
  const hoverPct = $derived(hovered === null ? 0 : ((hovered + 0.5) / buckets.length) * 100);
  /** What the tooltip lists: the shown lines that are above zero at the hovered point, biggest first. */
  const tooltipRows = $derived(
    hovered === null
      ? []
      : visible
          .map((s) => ({ s, value: s.values[hovered] }))
          .filter((r): r is { s: (typeof visible)[number]; value: number } => !!r.value)
          .sort((a, b) => b.value - a.value)
  );
  const minutes = $derived(Math.round(history.intervalSecs / 60));
</script>

<div class="text-xs">
  <div class="text-text-muted mb-1 flex flex-wrap justify-between gap-x-3">
    <span>{m.admin_status_chart_peak({ count: peak })}</span>
    <span>{m.admin_status_chart_resolution({ minutes })}</span>
  </div>

  <div class="relative">
    <div
      role="slider"
      tabindex="0"
      aria-label={axis === 'platform'
        ? m.admin_status_chart_aria_platform()
        : m.admin_status_chart_aria_version()}
      aria-orientation="horizontal"
      aria-readonly="true"
      aria-valuemin={0}
      aria-valuemax={Math.max(buckets.length - 1, 0)}
      aria-valuenow={hovered ?? Math.max(buckets.length - 1, 0)}
      aria-valuetext={readingText}
      class="rounded-lg"
      onpointermove={moveTo}
      onpointerdown={moveTo}
      onpointerleave={() => {
        if (!focused) select(null);
      }}
      onkeydown={onKey}
      onfocus={() => {
        focused = true;
        if (selectedT === null) select(buckets.length - 1);
      }}
      onblur={() => {
        focused = false;
        select(null);
      }}
    >
      <svg
        viewBox="0 0 {BOX.width} {BOX.height}"
        preserveAspectRatio="none"
        aria-hidden="true"
        class="border-cn-border block h-56 w-full touch-pan-y rounded-lg border bg-(--cn-surface)"
      >
        {#each [0.25, 0.5, 0.75] as fraction (fraction)}
          <line
            x1="0"
            x2={BOX.width}
            y1={BOX.height * fraction}
            y2={BOX.height * fraction}
            stroke="var(--cn-border)"
            stroke-width="1"
            vector-effect="non-scaling-stroke"
          />
        {/each}
        {#each lines as line (line.key)}
          {#each line.paths as d, i (i)}
            <path
              {d}
              fill="none"
              stroke={line.color}
              stroke-width="2"
              stroke-dasharray={line.dash}
              stroke-linecap="round"
              stroke-linejoin="round"
              vector-effect="non-scaling-stroke"
              data-series={line.key}
            />
          {/each}
        {/each}
        {#each totalPaths as d, i (i)}
          <path
            {d}
            fill="none"
            stroke="var(--text-main)"
            stroke-width="1.5"
            stroke-dasharray={TOTAL_DASH}
            vector-effect="non-scaling-stroke"
            data-series="total"
          />
        {/each}
        {#if hovered !== null}
          <line
            x1={(hoverPct / 100) * BOX.width}
            x2={(hoverPct / 100) * BOX.width}
            y1="0"
            y2={BOX.height}
            stroke="var(--text-muted)"
            stroke-width="1"
            vector-effect="non-scaling-stroke"
          />
        {/if}
      </svg>
    </div>
    <span class="text-text-muted pointer-events-none absolute top-1 left-2">{peak}</span>
    <span class="text-text-muted pointer-events-none absolute bottom-1 left-2">0</span>
    {#if empty}
      <p
        class="text-text-muted pointer-events-none absolute inset-0 flex items-center justify-center px-4 text-center"
      >
        {m.admin_status_chart_empty()}
      </p>
    {/if}
    {#if reading}
      <div
        class="border-cn-border text-text-main pointer-events-none absolute top-2 z-10 w-max max-w-56 rounded-lg border bg-(--cn-surface) px-3 py-2 shadow-md"
        style:left="{hoverPct}%"
        style:transform={hoverPct > 55
          ? 'translateX(calc(-100% - 0.75rem))'
          : 'translateX(0.75rem)'}
        data-testid="chart-tooltip"
      >
        <p class="text-text-muted mb-1">{stamp(reading.t)}</p>
        {#if reading.sample}
          {#each tooltipRows as row (row.s.key)}
            <p class="flex items-center justify-between gap-3">
              <span class="flex items-center gap-1.5">
                <span
                  class="inline-block h-0.5 w-3"
                  style:background-color={row.s.color}
                  aria-hidden="true"
                ></span>
                {labelOf(row.s.key)}
              </span>
              <span class="font-medium">{row.value}</span>
            </p>
          {/each}
          {#if totalShown}
            <p class="border-cn-border mt-1 flex justify-between gap-3 border-t pt-1">
              <span>{m.admin_status_chart_total()}</span>
              <span class="font-medium">{reading.sample.devices}</span>
            </p>
          {/if}
        {:else}
          <p class="text-text-muted">{m.admin_status_chart_gap_point()}</p>
        {/if}
      </div>
    {/if}
  </div>

  <div class="text-text-muted mt-1 flex justify-between">
    {#each ticks as t, i (i)}
      <span>{tick(t)}</span>
    {/each}
  </div>

  <ul class="mt-3 flex flex-wrap gap-x-2 gap-y-1">
    {#each series as s (s.key)}
      <li>
        <button
          type="button"
          aria-pressed={!hidden.has(s.key)}
          onclick={() => toggle(s.key)}
          class="text-text-main flex items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-(--surface-elevated) {hidden.has(
            s.key
          )
            ? 'line-through opacity-50'
            : ''}"
        >
          <svg width="18" height="6" aria-hidden="true">
            <line
              x1="0"
              x2="18"
              y1="3"
              y2="3"
              stroke={s.color}
              stroke-width="2"
              stroke-dasharray={s.dash}
            />
          </svg>
          {labelOf(s.key)}
        </button>
      </li>
    {/each}
    <li>
      <button
        type="button"
        aria-pressed={totalShown}
        onclick={() => toggle(TOTAL_KEY)}
        class="text-text-main flex items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-(--surface-elevated) {totalShown
          ? ''
          : 'line-through opacity-50'}"
      >
        <svg width="18" height="6" aria-hidden="true">
          <line
            x1="0"
            x2="18"
            y1="3"
            y2="3"
            stroke="var(--text-main)"
            stroke-width="1.5"
            stroke-dasharray={TOTAL_DASH}
          />
        </svg>
        {m.admin_status_chart_total()}
      </button>
    </li>
  </ul>
  <p class="text-text-muted mt-1">{m.admin_status_chart_legend_hint()}</p>
</div>
