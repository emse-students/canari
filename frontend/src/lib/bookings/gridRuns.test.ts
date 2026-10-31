import { describe, expect, it } from 'vitest';
import type { SlotUnit } from './api';
import type { PlacedUnit } from './grid';
import { blockDensity, buildRuns, cutRange, spanOf, type RunKind } from './gridRuns';

const T0 = Date.parse('2026-11-02T08:00:00+01:00');
const STEP = 30 * 60_000;

type Spec =
  | 'free'
  | 'closed'
  | 'past'
  | { booked: string }
  | { blocked: string | null; id?: string };

function placed(specs: Spec[]): PlacedUnit[] {
  return specs.map((s, i) => {
    const startMs = T0 + i * STEP;
    const base = { date: '2026-11-02', startMs, endMs: startMs + STEP };
    let unit: SlotUnit;
    if (typeof s === 'string') unit = { ...base, state: 'free' };
    else if ('booked' in s)
      unit = {
        ...base,
        state: 'booked',
        booking: {
          id: s.booked,
          resourceId: 'r',
          startsAt: '',
          endsAt: '',
          cancelled: false,
          mine: false,
        },
      };
    else unit = { ...base, state: 'blocked', blockReason: s.blocked, blockId: s.id };
    return { unit, topMin: 480 + i * 30, heightMin: 30, lane: 0, lanes: 1 };
  });
}

/** Reads the spec back out of the unit: the test's stand-in for the screen's clock-dependent reading. */
function kindFrom(specs: Spec[]) {
  return (unit: { startMs: number }): RunKind => {
    const s = specs[(unit.startMs - T0) / STEP];
    if (typeof s === 'string') return s;
    return 'booked' in s ? 'booked' : 'blocked';
  };
}

const runsOf = (specs: Spec[]) => buildRuns(placed(specs), kindFrom(specs));

describe('buildRuns', () => {
  it('merges touching free units into one run', () => {
    const runs = runsOf(['free', 'free', 'free']);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ kind: 'free', first: 0, last: 2, heightMin: 90, topMin: 480 });
    expect(runs[0].endMs - runs[0].startMs).toBe(3 * STEP);
  });

  it('keeps two adjacent different bookings apart, and one booking whole', () => {
    const runs = runsOf([{ booked: 'a' }, { booked: 'a' }, { booked: 'b' }, 'free']);
    expect(runs.map((r) => [r.kind, r.first, r.last])).toEqual([
      ['booked', 0, 1],
      ['booked', 2, 2],
      ['free', 3, 3],
    ]);
  });

  it('keeps two organiser blocks apart by id, and merges one block by id or by reason', () => {
    expect(
      runsOf([
        { blocked: 'x', id: '1' },
        { blocked: 'x', id: '2' },
      ])
    ).toHaveLength(2);
    expect(
      runsOf([
        { blocked: 'x', id: '1' },
        { blocked: 'x', id: '1' },
      ])
    ).toHaveLength(1);
    expect(runsOf([{ blocked: 'x' }, { blocked: 'x' }])).toHaveLength(1);
    expect(runsOf([{ blocked: 'x' }, { blocked: 'y' }])).toHaveLength(2);
  });

  it('splits free, closed and past stretches by what the clock makes of them', () => {
    const runs = runsOf(['past', 'past', 'closed', 'free', 'free']);
    expect(runs.map((r) => r.kind)).toEqual(['past', 'closed', 'free']);
  });

  it('does not merge units that are not touching (a gap between two windows)', () => {
    const p = placed(['free', 'free']);
    p[1] = {
      ...p[1],
      unit: { ...p[1].unit, startMs: p[1].unit.startMs + STEP, endMs: p[1].unit.endMs + STEP },
    };
    expect(buildRuns(p, () => 'free')).toHaveLength(2);
  });

  it('never merges units that share the width (lanes of a doubled hour)', () => {
    const p = placed(['free', 'free']);
    p[0].lanes = 2;
    p[1].lanes = 2;
    expect(buildRuns(p, () => 'free')).toHaveLength(2);
  });

  it('keeps a run that touches the end of the day (24:00) at its own height', () => {
    const p = placed(['free', 'free']).map((u, i) => ({ ...u, topMin: 1380 + i * 30 }));
    const [run] = buildRuns(p, () => 'free');
    expect(run.topMin + run.heightMin).toBe(1440);
  });

  it('keeps every free unit apart for fixed slots, and still merges the rest', () => {
    const specs: Spec[] = ['free', 'free', { booked: 'a' }, { booked: 'a' }];
    const runs = buildRuns(placed(specs), kindFrom(specs), true);
    expect(runs.map((r) => [r.kind, r.first, r.last])).toEqual([
      ['free', 0, 0],
      ['free', 1, 1],
      ['booked', 2, 3],
    ]);
  });

  it('is empty for an empty day', () => {
    expect(buildRuns([], () => 'free')).toEqual([]);
  });
});

describe('cutRange', () => {
  const specs: Spec[] = ['free', 'free', 'free', 'free', { booked: 'a' }];
  const p = placed(specs);
  const runs = buildRuns(p, kindFrom(specs));

  it('splits a free run around a selection inside it', () => {
    const cut = cutRange(runs, p, 1, 2);
    expect(cut.map((r) => [r.kind, r.first, r.last, r.topMin, r.heightMin])).toEqual([
      ['free', 0, 0, 480, 30],
      ['free', 3, 3, 570, 30],
      ['booked', 4, 4, 600, 30],
    ]);
  });

  it('drops the whole run when the selection covers it, and trims at an edge', () => {
    expect(cutRange(runs, p, 0, 3).map((r) => r.kind)).toEqual(['booked']);
    expect(cutRange(runs, p, 0, 1).map((r) => [r.first, r.last])).toEqual([
      [2, 3],
      [4, 4],
    ]);
  });
});

describe('spanOf', () => {
  it('measures the selection from its first to its last unit', () => {
    const p = placed(['free', 'free', 'free']);
    expect(spanOf(p, 1, 2)).toMatchObject({ topMin: 510, heightMin: 60, lane: 0, lanes: 1 });
  });
});

describe('blockDensity', () => {
  it('degrades from two lines to one line to the avatar alone', () => {
    expect(blockDensity(6)).toBe('full');
    expect(blockDensity(2)).toBe('line');
    expect(blockDensity(1.75)).toBe('line');
    expect(blockDensity(1)).toBe('icon');
  });
});
