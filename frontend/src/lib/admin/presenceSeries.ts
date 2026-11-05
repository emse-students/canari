/**
 * The admin status page's line charts: one smoothed line per PLATFORM, one per VERSION, and the
 * total as a dashed line (owner, 2026-11-05: "chaque version, chaque plateforme, avec de jolies
 * courbes"). Pure data and geometry; `PresenceLineChart.svelte` draws it.
 *
 * EVERY (platform, version) cell has its own line, even a cell of one device: the gateway no longer
 * merges small cells. A bucket nobody sampled is `null` in every series, and {@link smoothPaths}
 * breaks the line there - nothing is interpolated across a gap.
 */
import { layersOf, runsOfPresent, type Bucket } from './presenceMonitor';
import { platformColor, platformDash } from './presencePlatforms';

/** What a chart splits the devices by. */
export type Axis = 'platform' | 'version';

/** One line: its identity, how it is drawn, and one value per bucket (`null` in a gap). */
export interface Series {
  /** The platform or version string, as the gateway spelled it. */
  key: string;
  /** A CSS colour (a token reference, never a raw value). */
  color: string;
  /** An SVG `stroke-dasharray`, or `undefined` for a solid line. */
  dash?: string;
  values: (number | null)[];
}

/** Geometry of the drawing area, in SVG user units. */
export interface ChartBox {
  width: number;
  height: number;
}

/** The categorical slots in `app.css` (`--chart-series-1` .. `--chart-series-8`). */
export const SERIES_SLOTS = 8;

/** The dash patterns a version beyond the eighth takes, so colour is never the only identity. */
const OVERFLOW_DASHES = ['7 3', '2 3', '8 3 2 3'];

/** The dash of the total line: long and neutral, never a series' own. */
export const TOTAL_DASH = '10 5';

/**
 * Orders two version strings, NEWEST FIRST. Numeric parts compare as numbers (`1.10.0` > `1.9.0`),
 * a pre-release sorts below its release, and the words the gateway uses for "no version"
 * (`other`, `unknown`) sort last. Ties break on the raw string so the order never flickers.
 */
export function compareVersionsDesc(a: string, b: string): number {
  const rank = (v: string) => (v === 'unknown' ? 2 : v === 'other' ? 1 : 0);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  const split = (v: string) => {
    const [core, ...pre] = v.split('-');
    return { nums: core.split('.').map((n) => Number.parseInt(n, 10)), pre: pre.join('-') };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const dx = Number.isNaN(x.nums[i]) ? -1 : (x.nums[i] ?? 0);
    const dy = Number.isNaN(y.nums[i]) ? -1 : (y.nums[i] ?? 0);
    if (dx !== dy) return dy - dx;
  }
  // Same numbers: the release (no suffix) is newer than any of its pre-releases.
  if (x.pre !== y.pre) {
    if (x.pre === '') return -1;
    if (y.pre === '') return 1;
    return y.pre.localeCompare(x.pre, 'en', { numeric: true });
  }
  return a.localeCompare(b);
}

/**
 * One series per platform or version found in the buckets, drawn newest-first for versions and in
 * the platforms' fixed order for platforms. The colour of a platform is its own forever; a
 * version's is its place in the newest-first order (the eight categorical slots, then the same
 * slots again with a dash pattern, and the two unnamed words in muted ink), so a poll that adds no
 * version repaints nothing.
 *
 * A bucket with a sample holds the summed devices of the matching groups - a real zero when the
 * key is absent from it; a bucket without one is `null`.
 */
export function buildSeries(buckets: readonly Bucket[], axis: Axis): Series[] {
  const samples = buckets.flatMap((b) => (b.sample ? [b.sample] : []));
  const keys =
    axis === 'platform'
      ? layersOf(samples)
      : [...new Set(samples.flatMap((s) => s.groups.map((g) => g.version)))].sort(
          compareVersionsDesc
        );
  let rank = 0;
  return keys.map((key) => {
    const values = buckets.map((b) => {
      if (!b.sample) return null;
      let total = 0;
      for (const g of b.sample.groups)
        if ((axis === 'platform' ? g.platform : g.version) === key) total += g.devices;
      return total;
    });
    if (axis === 'platform') {
      return { key, color: platformColor(key), dash: platformDash(key), values };
    }
    if (key === 'unknown' || key === 'other') {
      return { key, color: 'var(--text-muted)', dash: key === 'other' ? '2 3' : undefined, values };
    }
    const slot = rank % SERIES_SLOTS;
    const lap = Math.floor(rank / SERIES_SLOTS);
    rank += 1;
    return {
      key,
      color: `var(--chart-series-${slot + 1})`,
      dash: lap === 0 ? undefined : OVERFLOW_DASHES[(lap - 1) % OVERFLOW_DASHES.length],
      values,
    };
  });
}

/** The total-devices line, one value per bucket (`null` in a gap). */
export function totalValues(buckets: readonly Bucket[]): (number | null)[] {
  return buckets.map((b) => (b.sample ? b.sample.devices : null));
}

/** The tallest value among `lines`, never below 1 so an empty window still has a scale. */
export function peakOf(lines: readonly (readonly (number | null)[])[]): number {
  let peak = 1;
  for (const line of lines) for (const v of line) if (v !== null && v > peak) peak = v;
  return peak;
}

/**
 * A smoothed path per run of consecutive values, never across a gap. The curve is a monotone cubic
 * (Fritsch-Carlson): it passes through every point and never overshoots between two of them, so a
 * smoothed line cannot show a dip below zero or a peak nobody measured. A run of one point is a
 * short flat segment one bucket wide, so a lone sample is visible.
 */
export function smoothPaths(
  values: readonly (number | null)[],
  box: ChartBox,
  peak: number
): string[] {
  const n = values.length;
  if (n === 0) return [];
  const col = box.width / n;
  const x = (i: number) => (i + 0.5) * col;
  const y = (v: number) => box.height - (v / peak) * box.height;
  const f = (v: number) => v.toFixed(2);
  const paths: string[] = [];
  for (const [from, to] of runsOfPresent(values.map((v) => v !== null))) {
    if (from === to) {
      paths.push(
        `M${f(x(from) - col / 2)},${f(y(values[from] as number))}L${f(x(from) + col / 2)},${f(y(values[from] as number))}`
      );
      continue;
    }
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = from; i <= to; i++) {
      xs.push(x(i));
      ys.push(y(values[i] as number));
    }
    const slopes = monotoneSlopes(xs, ys);
    let d = `M${f(xs[0])},${f(ys[0])}`;
    for (let i = 0; i < xs.length - 1; i++) {
      const dx = (xs[i + 1] - xs[i]) / 3;
      d += `C${f(xs[i] + dx)},${f(ys[i] + slopes[i] * dx)} ${f(xs[i + 1] - dx)},${f(ys[i + 1] - slopes[i + 1] * dx)} ${f(xs[i + 1])},${f(ys[i + 1])}`;
    }
    paths.push(d);
  }
  return paths;
}

/** Tangent slopes of a monotone cubic through (xs, ys): zero at a local extremum, never steeper than 3x a secant. */
function monotoneSlopes(xs: readonly number[], ys: readonly number[]): number[] {
  const n = xs.length;
  const secants: number[] = [];
  for (let i = 0; i < n - 1; i++) secants.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  const slopes = Array.from<number>({ length: n });
  slopes[0] = secants[0];
  slopes[n - 1] = secants[n - 2];
  for (let i = 1; i < n - 1; i++) {
    slopes[i] = secants[i - 1] * secants[i] <= 0 ? 0 : (secants[i - 1] + secants[i]) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    if (secants[i] === 0) {
      slopes[i] = 0;
      slopes[i + 1] = 0;
      continue;
    }
    const a = slopes[i] / secants[i];
    const b = slopes[i + 1] / secants[i];
    const h = Math.hypot(a, b);
    if (h > 3) {
      slopes[i] = (3 * a * secants[i]) / h;
      slopes[i + 1] = (3 * b * secants[i]) / h;
    }
  }
  return slopes;
}
