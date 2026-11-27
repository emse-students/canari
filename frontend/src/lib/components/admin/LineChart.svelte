<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity';
  import { m } from '$lib/paraglide/messages';
  import { TOTAL_DASH, peakOf, smoothPaths, type Series } from '$lib/admin/presenceSeries';
  import { Log } from '$lib/utils/Log';
  import Button from '$lib/components/ui/Button.svelte';

  /**
   * THE ONE LINE CHART of the admin pages: smoothed lines, a dashed total, a crosshair tooltip, a
   * keyboard-reachable readout and a legend that hides a line. `/admin/status` feeds it connected
   * devices a minute apart, `/admin/usage` distinct people a day apart; what a point IS belongs to
   * the caller, and nothing is interpolated across a `null`.
   */
  interface Props {
    /** The time of each point, in epoch seconds, oldest first. */
    times: readonly number[];
    /** One line each; `values` has one entry per point (`null` in a gap). */
    series: readonly Series[];
    /** The dashed total, one entry per point (`null` in a gap). */
    total: readonly (number | null)[];
    /** The legend and tooltip name of a series key. */
    labelOf: (key: string) => string;
    /** The accessible name of the chart. */
    ariaLabel: string;
    /** The line above the chart, right-aligned (what one point stands for). */
    resolution: string;
    /** What the slider announces for the point at an index. */
    readingText: (index: number) => string;
    /** The tooltip's time for a point. */
    stamp: (t: number) => string;
    /** An axis tick's time. */
    tick: (t: number) => string;
    /** Nothing was ever measured in the window. */
    empty: boolean;
    /** What the chart says when `empty`. */
    emptyLabel: string;
    /** The tooltip line of a point nobody measured. */
    gapLabel: string;
    /** Names the chart in the logs. */
    logName: string;
  }

  let {
    times,
    series,
    total,
    labelOf,
    ariaLabel,
    resolution,
    readingText: readingTextAt,
    stamp,
    tick,
    empty,
    emptyLabel,
    gapLabel,
    logName,
  }: Props = $props();

  const BOX = { width: 1000, height: 200 };
  /** The key of the dashed total line in the hidden set; never a series key. */
  const TOTAL_KEY = '\u0000total';

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
    Log.d(`admin.chart toggle ${logName}: ${hidden.has(key) ? 'hid' : 'showed'}`, key);
  }

  // The selected point is kept BY TIMESTAMP, never by index: the refresh slides the window, and an
  // index would then point at the point after the one the reader was on.
  let selectedT = $state<number | null>(null);
  let focused = $state(false);
  const hovered = $derived.by(() => {
    if (selectedT === null) return null;
    const at = times.indexOf(selectedT);
    return at >= 0 ? at : null;
  });
  /** The point under the reader, when there is one; `value` is the total, `null` in a gap. */
  const reading = $derived(hovered === null ? null : { t: times[hovered], value: total[hovered] });

  function select(index: number | null) {
    selectedT = index === null ? null : (times[index] ?? null);
  }

  /**
   * The readout is reachable without a pointer: the chart takes focus, shows the latest point, and
   * the arrows, Home and End walk the points. Escape clears it.
   */
  function onKey(event: KeyboardEvent) {
    const last = times.length - 1;
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
    if (rect.width === 0 || times.length === 0) return;
    const ratio = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
    select(Math.min(times.length - 1, Math.floor(ratio * times.length)));
  }

  const ticks = $derived(
    times.length === 0
      ? []
      : [0, 0.25, 0.5, 0.75, 1].map(
          (f) => times[Math.min(times.length - 1, Math.round(f * (times.length - 1)))]
        )
  );

  const readingText = $derived(hovered === null ? '' : readingTextAt(hovered));
  const hoverPct = $derived(hovered === null ? 0 : ((hovered + 0.5) / times.length) * 100);
  /** What the tooltip lists: the shown lines that are above zero at the hovered point, biggest first. */
  const tooltipRows = $derived(
    hovered === null
      ? []
      : visible
          .map((s) => ({ s, value: s.values[hovered] }))
          .filter((r): r is { s: (typeof visible)[number]; value: number } => !!r.value)
          .sort((a, b) => b.value - a.value)
  );
</script>

<div class="text-xs">
  <div class="text-text-muted mb-1 flex flex-wrap justify-between gap-x-3">
    <span>{m.admin_status_chart_peak({ count: peak })}</span>
    <span>{resolution}</span>
  </div>

  <div class="relative">
    <div
      role="slider"
      tabindex="0"
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      aria-readonly="true"
      aria-valuemin={0}
      aria-valuemax={Math.max(times.length - 1, 0)}
      aria-valuenow={hovered ?? Math.max(times.length - 1, 0)}
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
        if (selectedT === null) select(times.length - 1);
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
        {emptyLabel}
      </p>
    {/if}
    {#if reading !== null}
      <div
        class="border-cn-border text-text-main pointer-events-none absolute top-2 z-10 w-max max-w-56 rounded-lg border bg-(--cn-surface) px-3 py-2 shadow-md"
        style:left="{hoverPct}%"
        style:transform={hoverPct > 55
          ? 'translateX(calc(-100% - 0.75rem))'
          : 'translateX(0.75rem)'}
        data-testid="chart-tooltip"
      >
        <p class="text-text-muted mb-1">{stamp(reading.t)}</p>
        {#if reading.value !== null}
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
              <span class="font-medium">{reading.value}</span>
            </p>
          {/if}
        {:else}
          <p class="text-text-muted">{gapLabel}</p>
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
        <Button
          variant="ghost"
          size="compact"
          aria-pressed={!hidden.has(s.key)}
          onclick={() => toggle(s.key)}
          class="gap-1.5 {hidden.has(s.key) ? 'line-through opacity-50' : ''}"
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
        </Button>
      </li>
    {/each}
    <li>
      <Button
        variant="ghost"
        size="compact"
        aria-pressed={totalShown}
        onclick={() => toggle(TOTAL_KEY)}
        class="gap-1.5 {totalShown ? '' : 'line-through opacity-50'}"
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
      </Button>
    </li>
  </ul>
  <p class="text-text-muted mt-1">{m.admin_status_chart_legend_hint()}</p>
</div>
