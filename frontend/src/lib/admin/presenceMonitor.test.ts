import { describe, it, expect } from 'vitest';
import {
  buildBuckets,
  devicesByPlatform,
  layersOf,
  peakDevices,
  runsOf,
  stackedBands,
  versionShares,
  type Census,
  type CensusHistory,
  type CensusSample,
} from './presenceMonitor';

const group = (platform: string, version: string, devices: number, users = devices) => ({
  platform,
  version,
  devices,
  users,
});

const census = (groups: ReturnType<typeof group>[], users?: number): Census => ({
  devices: groups.reduce((n, g) => n + g.devices, 0),
  users: users ?? groups.reduce((n, g) => n + g.users, 0),
  groups,
});

const sample = (t: number, groups: ReturnType<typeof group>[]): CensusSample => ({
  t,
  ...census(groups),
});

describe('the breakdown by version', () => {
  it('ranks the versions live right now by devices, across platforms, with their share', () => {
    const now = census([
      group('android', '1.5.4', 6),
      group('web', '1.5.4', 2),
      group('ios', '1.5.3', 2),
    ]);

    const shares = versionShares(now);

    expect(shares.map((s) => [s.version, s.devices])).toEqual([
      ['1.5.4', 8],
      ['1.5.3', 2],
    ]);
    expect(shares[0].share).toBeCloseTo(0.8);
    expect(shares[0].platforms).toEqual([
      { platform: 'android', devices: 6 },
      { platform: 'web', devices: 2 },
    ]);
  });

  it('is empty, without dividing by zero, when nobody is connected', () => {
    expect(versionShares(census([]))).toEqual([]);
  });

  it('breaks a tie on the version, so the order never flickers', () => {
    const now = census([group('web', '1.0.1', 1), group('web', '1.0.0', 1)]);
    expect(versionShares(now).map((s) => s.version)).toEqual(['1.0.0', '1.0.1']);
  });

  it('counts devices per platform', () => {
    const now = census([group('web', '1', 2), group('web', '2', 3), group('ios', '1', 1)]);
    expect(Object.fromEntries(devicesByPlatform(now))).toEqual({ web: 5, ios: 1 });
  });
});

describe('the 24-hour window', () => {
  const history = (samples: CensusSample[]): CensusHistory => ({
    now: 1000 * 60 + 17,
    intervalSecs: 60,
    windowSecs: 5 * 60,
    samples,
  });

  it('lays the window out minute by minute, ending at the current minute', () => {
    const buckets = buildBuckets(history([]));
    expect(buckets.map((b) => b.t)).toEqual([996 * 60, 997 * 60, 998 * 60, 999 * 60, 1000 * 60]);
  });

  it('leaves a minute nobody sampled null - a gap, never an interpolated value', () => {
    const buckets = buildBuckets(
      history([sample(996 * 60, [group('web', '1', 4)]), sample(999 * 60, [group('web', '1', 6)])])
    );
    expect(buckets.map((b) => b.sample?.devices ?? null)).toEqual([4, null, null, 6, null]);
  });

  it('splits a line at every gap', () => {
    const buckets = buildBuckets(
      history([
        sample(996 * 60, [group('web', '1', 1)]),
        sample(997 * 60, [group('web', '1', 1)]),
        sample(999 * 60, [group('web', '1', 1)]),
      ])
    );
    expect(runsOf(buckets)).toEqual([
      [0, 1],
      [3, 3],
    ]);
  });

  it('answers a degenerate window with nothing', () => {
    expect(buildBuckets({ now: 10, intervalSecs: 0, windowSecs: 100, samples: [] })).toEqual([]);
  });

  it('keeps a scale for an empty window', () => {
    expect(peakDevices(buildBuckets(history([])))).toBe(1);
    expect(peakDevices(buildBuckets(history([sample(1000 * 60, [group('web', '1', 9)])])))).toBe(9);
  });
});

describe('the stacked bands', () => {
  const box = { width: 500, height: 100 };

  it('draws one polygon per layer per run, and none across a gap', () => {
    const buckets = buildBuckets({
      now: 1000 * 60,
      intervalSecs: 60,
      windowSecs: 5 * 60,
      samples: [
        sample(996 * 60, [group('web', '1', 2)]),
        sample(997 * 60, [group('web', '1', 2), group('ios', '1', 2)]),
        sample(1000 * 60, [group('ios', '1', 4)]),
      ],
    });
    const layers = layersOf(buckets.flatMap((b) => (b.sample ? [b.sample] : [])));

    const bands = stackedBands(buckets, layers, box, 4);

    // run 1 (two minutes): web and ios; run 2 (one minute): ios only.
    expect(bands.map((b) => b.layer)).toEqual(['web', 'ios', 'ios']);
  });

  it('widens a lone sample to one minute so it is visible', () => {
    const buckets = buildBuckets({
      now: 1000 * 60,
      intervalSecs: 60,
      windowSecs: 5 * 60,
      samples: [sample(1000 * 60, [group('web', '1', 4)])],
    });
    const [band] = stackedBands(buckets, ['web'], box, 4);
    const xs = band.points.split(' ').map((p) => Number(p.split(',')[0]));
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(box.width / 5);
  });

  it('scales the top of the stack to the peak', () => {
    const buckets = buildBuckets({
      now: 1000 * 60,
      intervalSecs: 60,
      windowSecs: 60,
      samples: [sample(1000 * 60, [group('web', '1', 4)])],
    });
    const [band] = stackedBands(buckets, ['web'], box, 4);
    const ys = band.points.split(' ').map((p) => Number(p.split(',')[1]));
    expect(Math.min(...ys)).toBe(0);
    expect(Math.max(...ys)).toBe(box.height);
  });

  it('orders the layers named platforms first, then the unnamed ones, then the unfamiliar', () => {
    const layers = layersOf([
      sample(60, [group('unknown', 'x', 1), group('zzz', 'x', 1), group('ios', 'x', 1)]),
      sample(120, [group('web', 'x', 1), group('other', 'x', 1)]),
    ]);
    expect(layers).toEqual(['web', 'ios', 'other', 'unknown', 'zzz']);
  });
});
