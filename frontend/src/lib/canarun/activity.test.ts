/**
 * The CanaRun reader against a PEER's bytes: the round trip it must keep, and every bound it must
 * refuse rather than draw. A refusal is a value (`ok: false`), never a throw.
 */
import { describe, expect, it, vi } from 'vitest';
import { canari } from '$lib/proto/canari.js';
import { decodeAppMessage, encodeAppMessage, mkRun } from '$lib/proto/codec';
import {
  RUN_BOUNDS,
  checkRunActivity,
  runActivityFromProto,
  runActivityToProto,
  runSportFromProto,
  type RunActivity,
} from './activity';
import { sampleRun } from '../../test/canarunFixture';

/** The run as it comes off the wire: encoded, decoded, read. */
function viaWire(run: canari.RunMsg.$Properties) {
  const decoded = decodeAppMessage(encodeAppMessage({ ...mkRun(run), messageId: 'r1' }));
  if (!decoded?.run) throw new Error('the frame lost its run');
  return runActivityFromProto(decoded.run);
}

/** A stored-envelope candidate (the JSON path), every field overridable with anything. */
function stored(over: Record<string, unknown> = {}) {
  return checkRunActivity({ ...sampleRun(), ...over } as Parameters<typeof checkRunActivity>[0]);
}

describe('the RunMsg round trip', () => {
  it('reads back exactly what was written, trace included', () => {
    const run = sampleRun();
    expect(viaWire(runActivityToProto(run))).toEqual({ ok: true, activity: run });
  });

  it('carries the trace as deltas, the first point absolute', () => {
    const proto = runActivityToProto(sampleRun());
    expect(proto.trackLat?.[0]).toBe(4_543_400);
    expect(proto.trackLat?.[1]).toBe(200);
    expect(proto.trackLon?.[3]).toBe(-500);
  });

  it('keeps a stats-only run (no trace) and a run with no title', () => {
    const run = sampleRun({ trackE5: [], title: undefined });
    expect(viaWire(runActivityToProto(run))).toEqual({ ok: true, activity: run });
  });

  it('keeps every sport it knows', () => {
    for (const sport of ['unspecified', 'running', 'cycling', 'hiking'] as const) {
      const read = viaWire(runActivityToProto(sampleRun({ sport })));
      expect(read.ok && read.activity.sport).toBe(sport);
    }
  });
});

describe('a peer frame that breaks a bound is refused, never drawn', () => {
  const base = () => runActivityToProto(sampleRun());

  it('refuses a trace over the point cap before integrating it', () => {
    const n = RUN_BOUNDS.maxPoints + 1;
    const read = viaWire({ ...base(), trackLat: Array(n).fill(1), trackLon: Array(n).fill(1) });
    expect(read.ok).toBe(false);
    expect(!read.ok && read.why).toContain('exceed');
  });

  it('refuses two trace lists of different lengths', () => {
    const read = viaWire({ ...base(), trackLat: [1, 2, 3], trackLon: [1, 2] });
    expect(read.ok).toBe(false);
  });

  it('refuses a trace whose deltas integrate past the pole', () => {
    const read = viaWire({ ...base(), trackLat: [8_999_999, 2], trackLon: [0, 0] });
    expect(read.ok).toBe(false);
    expect(!read.ok && read.why).toContain('off the globe');
  });

  it('refuses a longitude past the antimeridian', () => {
    const read = viaWire({ ...base(), trackLat: [0, 0], trackLon: [18_000_001, 0] });
    expect(read.ok).toBe(false);
  });

  it('refuses huge values no recording produces', () => {
    for (const over of [
      { durationS: RUN_BOUNDS.maxDurationS + 1, movingS: 0 },
      { distanceM: 4_000_000_000 },
      { elevationGainM: RUN_BOUNDS.maxElevationGainM + 1 },
      { trimmedM: RUN_BOUNDS.maxTrimmedM + 1 },
    ]) {
      expect(viaWire({ ...base(), ...over }).ok, JSON.stringify(over)).toBe(false);
    }
  });

  it('refuses a moving time above the elapsed time', () => {
    expect(viaWire({ ...base(), durationS: 100, movingS: 101 }).ok).toBe(false);
  });

  it('refuses a start outside 2000-2100, an absent one included', () => {
    expect(viaWire({ ...base(), startedAt: 0 }).ok).toBe(false);
    expect(viaWire({ ...base(), startedAt: 5_000_000_000_000 }).ok).toBe(false);
  });
});

describe('what the reader CORRECTS rather than refuses', () => {
  it('reads a sport it was never taught as unspecified', () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const read = viaWire({ ...runActivityToProto(sampleRun()), sport: 42 as canari.RunSport });
    expect(read.ok && read.activity.sport).toBe('unspecified');
    expect(runSportFromProto(undefined)).toBe('unspecified');
    vi.restoreAllMocks();
  });

  it('cuts a title to the bound, on code points, and flattens control characters', () => {
    const long = '\u{1f3c3}'.repeat(RUN_BOUNDS.maxTitleChars + 20);
    const read = viaWire({ ...runActivityToProto(sampleRun()), title: long });
    expect(read.ok && Array.from(read.activity.title ?? '').length).toBe(RUN_BOUNDS.maxTitleChars);
    const ctl = viaWire({ ...runActivityToProto(sampleRun()), title: 'a\nb\u202ec' });
    expect(ctl.ok && ctl.activity.title).toBe('a b c');
  });

  it('drops a pool swim trace: a pool swim is stats only', () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const read = viaWire(runActivityToProto(sampleRun({ sport: 'pool-swim' })));
    expect(read.ok && read.activity.trackE5).toEqual([]);
    vi.restoreAllMocks();
  });
});

describe('the stored envelope path (a history bundle relays it as a string)', () => {
  it('accepts the activity it stored', () => {
    expect(stored()).toEqual({ ok: true, activity: sampleRun() });
  });

  it('refuses NaN, Infinity, strings, negatives and fractions', () => {
    for (const over of [
      { durationS: Number.NaN },
      { distanceM: Number.POSITIVE_INFINITY },
      { elevationGainM: '42' },
      { movingS: -1 },
      { distanceM: 12.5 },
      { startedAt: null },
    ]) {
      expect(stored(over).ok, JSON.stringify(over)).toBe(false);
    }
  });

  it('refuses a trace that is not a flat list of in-range integers', () => {
    expect(stored({ trackE5: 'x' }).ok).toBe(false);
    expect(stored({ trackE5: [1, 2, 3] }).ok).toBe(false);
    expect(stored({ trackE5: [1.5, 2] }).ok).toBe(false);
    expect(stored({ trackE5: [9_000_001, 0] }).ok).toBe(false);
    expect(stored({ trackE5: Array(2 * RUN_BOUNDS.maxPoints + 2).fill(0) }).ok).toBe(false);
  });

  it('reads an unknown sport name as unspecified', () => {
    const read = stored({ sport: 'base-jump' });
    expect(read.ok && (read.activity as RunActivity).sport).toBe('unspecified');
  });
});
