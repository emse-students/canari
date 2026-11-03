/**
 * The admin status page's monitoring data: the gateway's anonymous census, shaped for drawing.
 *
 * THE WIRE IS COUNTS ONLY (`GET /api/admin/presence` and `/history`, chat-gateway `census.rs`): a
 * connected-device and connected-user count per (platform, app version), now and once a minute for
 * the last 24 hours. Nothing here names a person or a device, and nothing here may ever need to.
 *
 * A MINUTE NOBODY SAMPLED IS A GAP, NEVER AN INTERPOLATION: {@link buildBuckets} lays the whole
 * window out minute by minute and leaves the missing ones `null`, and {@link runsOf} is what splits
 * a drawn line at them.
 */

/** One cell of the breakdown: devices, and distinct users, on `platform` running `version`. */
export interface CensusGroup {
  platform: string;
  version: string;
  devices: number;
  users: number;
}

/** Who is connected: `users` is distinct across the whole population, not the sum of the groups. */
export interface Census {
  devices: number;
  users: number;
  groups: CensusGroup[];
}

/** One minute of the series; `t` is Unix seconds, a multiple of the sampling interval. */
export interface CensusSample extends Census {
  t: number;
}

/** What `/api/admin/presence/history` answers. */
export interface CensusHistory {
  now: number;
  intervalSecs: number;
  windowSecs: number;
  samples: CensusSample[];
}

/** The platforms the gateway counts apart, in drawing order (bottom of the stack first). */
export const PLATFORM_ORDER = ['web', 'android', 'ios', 'macos', 'windows', 'linux'] as const;

/** What the gateway calls a platform it could not name, or a client too old to declare one. */
export const UNNAMED_PLATFORMS = ['other', 'unknown'] as const;

/**
 * The layers of the stack, in order: the named platforms, then the two unnamed ones. A platform the
 * gateway invents later still draws (appended by {@link layersOf}); it just has no colour of its own.
 */
export function layersOf(samples: readonly CensusSample[]): string[] {
  const seen = new Set<string>();
  for (const s of samples) for (const g of s.groups) seen.add(g.platform);
  const known: string[] = [...PLATFORM_ORDER, ...UNNAMED_PLATFORMS];
  const present = known.filter((p) => seen.has(p));
  const extra = [...seen].filter((p) => !known.includes(p)).sort();
  return [...present, ...extra];
}

/** Devices per platform in one census. */
export function devicesByPlatform(census: Census): Map<string, number> {
  const out = new Map<string, number>();
  for (const g of census.groups) out.set(g.platform, (out.get(g.platform) ?? 0) + g.devices);
  return out;
}

/** One version's share of the devices connected right now, across platforms. */
export interface VersionShare {
  version: string;
  devices: number;
  /** 0..1 of every connected device. */
  share: number;
  /** The platforms running it, with their device counts, most devices first. */
  platforms: { platform: string; devices: number }[];
}

/**
 * The versions live right now, most devices first - what a `minClientVersion` decision reads. An
 * empty census has no versions (and no division by zero). Ties break on the version string, so the
 * order never flickers between two refreshes.
 */
export function versionShares(census: Census): VersionShare[] {
  const byVersion = new Map<string, Map<string, number>>();
  for (const g of census.groups) {
    const platforms = byVersion.get(g.version) ?? new Map<string, number>();
    platforms.set(g.platform, (platforms.get(g.platform) ?? 0) + g.devices);
    byVersion.set(g.version, platforms);
  }
  const total = census.devices;
  return [...byVersion.entries()]
    .map(([version, platforms]) => {
      const list = [...platforms.entries()]
        .map(([platform, devices]) => ({ platform, devices }))
        .sort((a, b) => b.devices - a.devices || a.platform.localeCompare(b.platform));
      const devices = list.reduce((n, p) => n + p.devices, 0);
      return { version, devices, share: total > 0 ? devices / total : 0, platforms: list };
    })
    .sort((a, b) => b.devices - a.devices || a.version.localeCompare(b.version));
}

/** One minute of the window: the sample that describes it, or `null` for a minute nobody sampled. */
export interface Bucket {
  t: number;
  sample: CensusSample | null;
}

/**
 * The window laid out minute by minute, ending at the minute containing `history.now`. A minute with
 * no sample is `null` - the gap the chart draws - and no value is invented for it.
 */
export function buildBuckets(history: CensusHistory): Bucket[] {
  const step = history.intervalSecs;
  if (step <= 0 || history.windowSecs <= 0) return [];
  const last = history.now - (history.now % step);
  const count = Math.floor(history.windowSecs / step);
  const byMinute = new Map(history.samples.map((s) => [s.t, s]));
  const buckets: Bucket[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const t = last - i * step;
    buckets.push({ t, sample: byMinute.get(t) ?? null });
  }
  return buckets;
}

/** The `[from, to]` index ranges (inclusive) of consecutive buckets that have a sample. */
export function runsOf(buckets: readonly Bucket[]): [number, number][] {
  const runs: [number, number][] = [];
  let start = -1;
  for (let i = 0; i <= buckets.length; i++) {
    const has = i < buckets.length && buckets[i].sample !== null;
    if (has && start < 0) start = i;
    if (!has && start >= 0) {
      runs.push([start, i - 1]);
      start = -1;
    }
  }
  return runs;
}

/** The tallest stack in the window, never below 1 so an empty window still has a scale. */
export function peakDevices(buckets: readonly Bucket[]): number {
  let peak = 1;
  for (const b of buckets) if (b.sample && b.sample.devices > peak) peak = b.sample.devices;
  return peak;
}

/** Geometry of the chart's drawing area, in SVG user units. */
export interface ChartBox {
  width: number;
  height: number;
}

/**
 * One filled polygon per (run, layer): the band of `layer` between the layers below it and itself,
 * across the consecutive minutes of `run`. A run of a single minute is widened to one minute's
 * width so a lone sample is visible rather than a zero-width sliver.
 *
 * Returns SVG `points` strings, keyed by layer, one entry per run (empty bands omitted).
 */
export function stackedBands(
  buckets: readonly Bucket[],
  layers: readonly string[],
  box: ChartBox,
  peak: number
): { layer: string; points: string }[] {
  const n = buckets.length;
  if (n === 0) return [];
  const colWidth = box.width / n;
  const x = (i: number) => (i + 0.5) * colWidth;
  const y = (devices: number) => box.height - (devices / peak) * box.height;
  const bands: { layer: string; points: string }[] = [];
  for (const [from, to] of runsOf(buckets)) {
    const columns =
      from === to
        ? [
            { x: x(from) - colWidth / 2, idx: from },
            { x: x(from) + colWidth / 2, idx: from },
          ]
        : range(from, to).map((idx) => ({ x: x(idx), idx }));
    const cumulative = columns.map(() => 0);
    for (const layer of layers) {
      const lower = [...cumulative];
      const upper = columns.map(({ idx }, k) => {
        const cell = buckets[idx].sample?.groups.filter((g) => g.platform === layer) ?? [];
        return cumulative[k] + cell.reduce((sum, g) => sum + g.devices, 0);
      });
      if (upper.every((value, k) => value === lower[k])) continue;
      const top = columns.map((c, k) => `${c.x.toFixed(2)},${y(upper[k]).toFixed(2)}`);
      const bottom = columns.map((c, k) => `${c.x.toFixed(2)},${y(lower[k]).toFixed(2)}`).reverse();
      bands.push({ layer, points: [...top, ...bottom].join(' ') });
      upper.forEach((value, k) => (cumulative[k] = value));
    }
  }
  return bands;
}

/** `from..to` inclusive. */
function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}
