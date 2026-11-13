/**
 * The admin status page's monitoring data: the gateway's anonymous census, shaped for drawing.
 *
 * THE WIRE IS COUNTS ONLY (`GET /api/admin/presence` and `/history`, chat-gateway `census.rs`): a
 * connected-device and connected-user count per (platform, app version), now and, over 24 hours, 7 days or 30 days, a series of peaks. Nothing here names a person or a device, and nothing here may ever need to.
 *
 * A PERIOD NOBODY SAMPLED IS A GAP, NEVER AN INTERPOLATION: {@link buildBuckets} lays the whole
 * window out point by point and leaves the missing ones `null`, and {@link runsOf} is what splits
 * a drawn line at them.
 */

/** One cell of the breakdown: devices, and distinct users, on `platform` running `version`. */
interface CensusGroup {
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

/** The periods the history can be asked for; the gateway refuses any other value. */
export const HISTORY_WINDOWS = ['24h', '7d', '30d'] as const;

/** One of {@link HISTORY_WINDOWS}. */
export type HistoryWindow = (typeof HISTORY_WINDOWS)[number];

/**
 * What `/api/admin/presence/history?window=` answers. `intervalSecs` is the spacing of the points
 * of THIS window (60 s for 24 h, 300 s for 7 d, 1800 s for 30 d), each the peak of its period.
 */
export interface CensusHistory {
  now: number;
  intervalSecs: number;
  windowSecs: number;
  samples: CensusSample[];
}

/** The platforms the gateway counts apart, in drawing order (bottom of the stack first). */
const PLATFORM_ORDER = ['web', 'android', 'ios', 'macos', 'windows', 'linux'] as const;

/** What the gateway calls a platform it could not name, or a client too old to declare one. */
const UNNAMED_PLATFORMS = ['other', 'unknown'] as const;

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
 * The window laid out point by point, ending at the point containing `history.now`. A point with
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
  return runsOfPresent(buckets.map((b) => b.sample !== null));
}

/** The `[from, to]` index ranges (inclusive) of consecutive `true` entries: the runs between gaps. */
export function runsOfPresent(present: readonly boolean[]): [number, number][] {
  const runs: [number, number][] = [];
  let start = -1;
  for (let i = 0; i <= present.length; i++) {
    const has = i < present.length && present[i];
    if (has && start < 0) start = i;
    if (!has && start >= 0) {
      runs.push([start, i - 1]);
      start = -1;
    }
  }
  return runs;
}
