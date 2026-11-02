<script lang="ts">
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';
  import {
    buildBuckets,
    layersOf,
    peakDevices,
    stackedBands,
    type CensusHistory,
  } from '$lib/admin/presenceMonitor';
  import { platformColor, platformLabel } from '$lib/admin/presencePlatforms';

  interface Props {
    /** The last 24 hours, as `/api/admin/presence/history` answers. */
    history: CensusHistory;
  }

  let { history }: Props = $props();

  const BOX = { width: 1000, height: 200 };

  const buckets = $derived(buildBuckets(history));
  const layers = $derived(layersOf(history.samples));
  const peak = $derived(peakDevices(buckets));
  const bands = $derived(stackedBands(buckets, layers, BOX, peak));
  const empty = $derived(history.samples.length === 0);

  let hovered = $state<number | null>(null);
  const reading = $derived(hovered === null ? null : (buckets[hovered] ?? null));

  function moveTo(event: PointerEvent) {
    const rect = (event.currentTarget as Element).getBoundingClientRect();
    if (rect.width === 0 || buckets.length === 0) return;
    const ratio = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
    hovered = Math.min(buckets.length - 1, Math.floor(ratio * buckets.length));
  }

  const locale = $derived(getLocale() === 'en' ? 'en-US' : 'fr-FR');
  function clock(t: number): string {
    return new Date(t * 1000).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  }
  const hoverX = $derived(hovered === null ? 0 : ((hovered + 0.5) / buckets.length) * 100);
</script>

<div class="text-xs">
  <div class="text-text-muted mb-1 flex justify-between">
    <span>{m.admin_status_chart_peak({ count: peak })}</span>
    <span class="min-h-4">
      {#if reading}
        {#if reading.sample}
          {m.admin_status_chart_reading({
            time: clock(reading.t),
            devices: reading.sample.devices,
            users: reading.sample.users,
          })}
        {:else}
          {m.admin_status_chart_reading_gap({ time: clock(reading.t) })}
        {/if}
      {/if}
    </span>
  </div>

  <div class="relative">
    <svg
      viewBox="0 0 {BOX.width} {BOX.height}"
      preserveAspectRatio="none"
      role="img"
      aria-label={m.admin_status_chart_aria()}
      class="border-cn-border block h-48 w-full touch-none rounded-lg border bg-(--cn-surface)"
      onpointermove={moveTo}
      onpointerdown={moveTo}
      onpointerleave={() => (hovered = null)}
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
      {#each bands as band, i (i)}
        <polygon
          points={band.points}
          fill={platformColor(band.layer)}
          fill-opacity="0.85"
          stroke={platformColor(band.layer)}
          stroke-width="1"
          vector-effect="non-scaling-stroke"
        />
      {/each}
      {#if hovered !== null}
        <line
          x1={(hoverX / 100) * BOX.width}
          x2={(hoverX / 100) * BOX.width}
          y1="0"
          y2={BOX.height}
          stroke="var(--text-muted)"
          stroke-width="1"
          vector-effect="non-scaling-stroke"
        />
      {/if}
    </svg>
    {#if empty}
      <p
        class="text-text-muted pointer-events-none absolute inset-0 flex items-center justify-center px-4 text-center"
      >
        {m.admin_status_chart_empty()}
      </p>
    {/if}
  </div>

  <div class="text-text-muted mt-1 flex justify-between">
    <span>{m.admin_status_chart_axis_start()}</span>
    <span>{m.admin_status_chart_axis_middle()}</span>
    <span>{m.admin_status_chart_axis_end()}</span>
  </div>

  <ul class="mt-3 flex flex-wrap gap-x-4 gap-y-1">
    {#each layers as layer (layer)}
      <li class="text-text-main flex items-center gap-1.5">
        <span
          class="inline-block size-2.5 rounded-sm"
          style:background-color={platformColor(layer)}
          aria-hidden="true"
        ></span>
        {platformLabel(layer)}
      </li>
    {/each}
  </ul>
  <p class="text-text-muted mt-2">{m.admin_status_chart_gap_hint()}</p>
</div>
