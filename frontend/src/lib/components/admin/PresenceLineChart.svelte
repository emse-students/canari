<script lang="ts">
  import { intlLocale } from '$lib/utils/intlLocale';
  import { m } from '$lib/paraglide/messages';
  import { buildBuckets, type CensusHistory } from '$lib/admin/presenceMonitor';
  import { buildSeries, totalValues, type Axis } from '$lib/admin/presenceSeries';
  import { platformLabel, versionLabel } from '$lib/admin/presencePlatforms';
  import LineChart from './LineChart.svelte';

  interface Props {
    /** The window to draw, as `/api/admin/presence/history` answers. */
    history: CensusHistory;
    /** What a line is: a platform or a version. */
    axis: Axis;
  }

  let { history, axis }: Props = $props();

  const buckets = $derived(buildBuckets(history));
  const locale = $derived(intlLocale());
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
  function readingText(index: number): string {
    const b = buckets[index];
    if (!b) return '';
    return b.sample
      ? m.admin_status_chart_reading({
          time: stamp(b.t),
          devices: b.sample.devices,
          users: b.sample.users,
        })
      : m.admin_status_chart_reading_gap({ time: stamp(b.t) });
  }
</script>

<!-- The connected-devices history of /admin/status, drawn by the shared LineChart. -->
<LineChart
  times={buckets.map((b) => b.t)}
  series={buildSeries(buckets, axis)}
  total={totalValues(buckets)}
  labelOf={axis === 'platform' ? platformLabel : versionLabel}
  ariaLabel={axis === 'platform'
    ? m.admin_status_chart_aria_platform()
    : m.admin_status_chart_aria_version()}
  resolution={m.admin_status_chart_resolution({ minutes: Math.round(history.intervalSecs / 60) })}
  {readingText}
  {stamp}
  {tick}
  empty={history.samples.length === 0}
  emptyLabel={m.admin_status_chart_empty()}
  gapLabel={m.admin_status_chart_gap_point()}
  logName="status {axis}"
/>
