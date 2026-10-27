<!--
  CanaRun - the activity card a `RunMsg` is drawn as, inside a DM, group or salon bubble.

  Reads a run `checkRunActivity` already accepted, so every number here is bounded. The trace is a
  bare inline SVG polyline in a fixed viewBox - no map tiles, no request of any kind (decided
  2026-10-27) - and is absent for a pool swim and for a stats-only send.
  docs/wiki/frontend/modules/canarun.md.
-->
<script lang="ts">
  import { Activity, Bike, Footprints, Mountain, Waves } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import type { RunActivity } from '$lib/canarun/activity';
  import {
    formatRunDistance,
    formatRunDuration,
    formatRunElevation,
    formatRunRate,
    formatRunStart,
    runSportLabel,
  } from '$lib/canarun/format';
  import { TRACK_VIEWBOX, trackPolylinePoints } from '$lib/canarun/trackPath';

  let { run }: { run: RunActivity } = $props();

  const SportIcon = $derived(
    run.sport === 'running'
      ? Footprints
      : run.sport === 'cycling'
        ? Bike
        : run.sport === 'hiking'
          ? Mountain
          : run.sport === 'pool-swim'
            ? Waves
            : Activity
  );
  const sportLabel = $derived(runSportLabel(run.sport));
  const points = $derived(trackPolylinePoints(run.trackE5));
  const rate = $derived(formatRunRate(run));
  const elevation = $derived(formatRunElevation(run));
</script>

<div
  class="border-cn-border bg-cn-surface text-text-main w-72 max-w-full overflow-hidden rounded-2xl border"
  data-testid="run-card"
>
  {#if points}
    <svg
      viewBox="0 0 {TRACK_VIEWBOX.width} {TRACK_VIEWBOX.height}"
      role="img"
      aria-label={m.canarun_trace_label()}
      class="bg-cn-surface-alt block h-auto w-full text-amber-500"
      data-testid="run-trace"
    >
      <polyline
        {points}
        fill="none"
        stroke="currentColor"
        stroke-width="3"
        stroke-linejoin="round"
        stroke-linecap="round"
      />
    </svg>
  {/if}
  <div class="flex flex-col gap-2 px-3 py-2.5">
    <div class="flex min-w-0 items-center gap-2">
      <SportIcon size={16} class="shrink-0 text-amber-500" />
      <span class="truncate text-sm font-bold">{run.title ?? sportLabel}</span>
    </div>
    <p class="text-text-muted text-xs">
      {m.canarun_sport_and_start({ sport: sportLabel, start: formatRunStart(run.startedAt) })}
    </p>
    <dl class="grid grid-cols-3 gap-2">
      <div class="flex flex-col">
        <dt class="text-text-muted text-2xs">{m.canarun_stat_distance()}</dt>
        <dd class="text-sm font-semibold">{formatRunDistance(run)}</dd>
      </div>
      <div class="flex flex-col">
        <dt class="text-text-muted text-2xs">{m.canarun_stat_duration()}</dt>
        <dd class="text-sm font-semibold">{formatRunDuration(run.durationS)}</dd>
      </div>
      {#if rate}
        <div class="flex flex-col">
          <dt class="text-text-muted text-2xs">{rate.label}</dt>
          <dd class="text-sm font-semibold">{rate.value}</dd>
        </div>
      {/if}
      {#if elevation}
        <div class="flex flex-col">
          <dt class="text-text-muted text-2xs">{m.canarun_stat_elevation()}</dt>
          <dd class="text-sm font-semibold">{elevation}</dd>
        </div>
      {/if}
    </dl>
    {#if points && run.trimmedM > 0}
      <p class="text-text-muted text-2xs">{m.canarun_trimmed_note({ meters: run.trimmedM })}</p>
    {/if}
  </div>
</div>
