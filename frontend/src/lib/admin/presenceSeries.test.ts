import { describe, it, expect } from 'vitest';
import { buildBuckets, type CensusSample } from './presenceMonitor';
import {
  SERIES_SLOTS,
  buildSeries,
  compareVersionsDesc,
  peakOf,
  smoothPaths,
  totalValues,
} from './presenceSeries';

const g = (platform: string, version: string, devices: number) => ({
  platform,
  version,
  devices,
  users: devices,
});
const sample = (t: number, groups: ReturnType<typeof g>[]): CensusSample => ({
  t,
  devices: groups.reduce((n, x) => n + x.devices, 0),
  users: groups.reduce((n, x) => n + x.users, 0),
  groups,
});
const window5 = (samples: CensusSample[]) =>
  buildBuckets({ now: 1000 * 60, intervalSecs: 60, windowSecs: 5 * 60, samples });

describe('version order', () => {
  it('sorts newest first, numerically, a release above its pre-releases, the words last', () => {
    const sorted = [
      '1.9.0',
      'unknown',
      '1.10.0',
      '1.10.0-alpha.2',
      'other',
      '1.10.0-alpha.10',
      '1.10.0',
    ].sort(compareVersionsDesc);
    expect(sorted).toEqual([
      '1.10.0',
      '1.10.0',
      '1.10.0-alpha.10',
      '1.10.0-alpha.2',
      '1.9.0',
      'other',
      'unknown',
    ]);
  });
});

describe('the series', () => {
  const buckets = window5([
    sample(997 * 60, [g('web', '1.6.5', 2), g('ios', '1.6.5', 1)]),
    sample(998 * 60, [g('web', '1.6.4', 1)]),
    sample(1000 * 60, [g('web', '1.6.5', 3)]),
  ]);

  it('gives every platform its own line, a real zero when absent and null in a gap', () => {
    const series = buildSeries(buckets, 'platform');
    expect(series.map((s) => s.key)).toEqual(['web', 'ios']);
    expect(series[0].values).toEqual([null, 2, 1, null, 3]);
    expect(series[1].values).toEqual([null, 1, 0, null, 0]);
  });

  it('gives every version its own line, even a version of one device, newest first', () => {
    const series = buildSeries(buckets, 'version');
    expect(series.map((s) => s.key)).toEqual(['1.6.5', '1.6.4']);
    expect(series[1].values).toEqual([null, 0, 1, null, 0]);
    // Counted from the oldest shown: the older version holds slot 1, the newer slot 2.
    expect(series[1].color).toBe('var(--chart-series-1)');
    expect(series[0].color).toBe('var(--chart-series-2)');
  });

  it('does not repaint an older version when a newer one ships', () => {
    const colours = (versions: string[]) =>
      Object.fromEntries(
        buildSeries(
          window5([
            sample(
              1000 * 60,
              versions.map((v) => g('web', v, 1))
            ),
          ]),
          'version'
        ).map((s) => [s.key, s.color])
      );
    const before = colours(['1.6.3', '1.6.4', '1.6.5']);
    const after = colours(['1.6.3', '1.6.4', '1.6.5', '1.6.6', '1.7.0-alpha.1']);
    for (const v of ['1.6.3', '1.6.4', '1.6.5']) expect(after[v]).toBe(before[v]);
    expect(new Set(Object.values(after)).size).toBe(5);
  });

  it('never cycles a colour without a dash, and keeps unnamed versions muted', () => {
    const many = Array.from({ length: SERIES_SLOTS + 2 }, (_, i) => g('web', `1.0.${i}`, 1));
    const series = buildSeries(
      window5([sample(1000 * 60, [...many, g('web', 'unknown', 1)])]),
      'version'
    );
    const named = series.filter((s) => s.key !== 'unknown');
    // `named` is newest first: the eight oldest hold the solid slots, the two newest lap round
    // with a dash pattern.
    expect(named.slice(2).every((s) => s.dash === undefined)).toBe(true);
    expect(named[0].dash).toBeDefined();
    expect(named[0].color).toBe(named[SERIES_SLOTS].color);
    expect(named[1].color).toBe(named[SERIES_SLOTS + 1].color);
    expect(series.at(-1)?.color).toBe('var(--text-muted)');
  });

  it('totals the devices per bucket and keeps a scale for an empty window', () => {
    expect(totalValues(buckets)).toEqual([null, 3, 1, null, 3]);
    expect(peakOf([totalValues(buckets)])).toBe(3);
    expect(peakOf([])).toBe(1);
  });
});

describe('the smoothed paths', () => {
  const box = { width: 500, height: 100 };

  it('breaks the line at a gap: one path per run, nothing across it', () => {
    const paths = smoothPaths([1, 2, null, null, 3, 4], box, 4);
    expect(paths).toHaveLength(2);
    expect(paths.every((d) => d.startsWith('M') && d.includes('C'))).toBe(true);
  });

  it('draws a lone point as a short flat segment, so it is visible', () => {
    const [d] = smoothPaths([null, 2, null], box, 4);
    expect(d).toMatch(/^M[\d.]+,50\.00L[\d.]+,50\.00$/);
  });

  it('never overshoots between two points (monotone), so a curve cannot go below zero', () => {
    const [d] = smoothPaths([0, 0, 5, 5, 0], box, 5);
    const ys = [...d.matchAll(/[\d.]+,([\d.]+)/g)].map((m) => Number(m[1]));
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(box.height);
  });

  it('answers an empty series with nothing', () => {
    expect(smoothPaths([], box, 1)).toEqual([]);
    expect(smoothPaths([null, null], box, 1)).toEqual([]);
  });
});
