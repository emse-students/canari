/**
 * CanaRun - the activity a `RunMsg` carries, and the ONE place its bounds are decided.
 *
 * Every value here comes from a PEER: the live frame (`RunMsg`, proto) and a history bundle (the
 * stored envelope JSON, relayed as a string by another member) are both somebody else's bytes. Both
 * reach the card through {@link checkRunActivity}, so a value no recording could produce - a
 * negative time, a 10^9-point trace, a latitude past the pole - is refused in one place and shown
 * as an unreadable row, never drawn and never thrown. docs/wiki/frontend/modules/canarun.md.
 *
 * Two values are CORRECTED rather than refused, because a correct reading exists: a sport this
 * build was never taught reads as `unspecified` (a newer writer's sport degrades to "an activity"),
 * and a title is cut to {@link RUN_BOUNDS}.maxTitleChars. A pool swim's trace is DROPPED: the
 * product decision is that a pool swim never shows one, whatever the sender put in it.
 */

import { canari } from '$lib/proto/canari.js';
import { Log } from '$lib/utils/Log';

/** The sports a card knows, by name - the stored form, independent of the proto numbers. */
export type RunSportName = 'unspecified' | 'running' | 'cycling' | 'hiking' | 'pool-swim';

/** A run as the card draws it: every value already within {@link RUN_BOUNDS}. */
export interface RunActivity {
  sport: RunSportName;
  /** Unix ms, the sender's clock. */
  startedAt: number;
  durationS: number;
  /** Time in motion, never above `durationS`. */
  movingS: number;
  distanceM: number;
  elevationGainM: number;
  /** Absent when the sender wrote none. */
  title?: string;
  /**
   * The trace as ABSOLUTE points in units of 1e-5 degree, flattened `[lat0, lon0, lat1, lon1, ...]`
   * - integers, so the stored envelope is compact and holds no float noise. Empty = stats only.
   */
  trackE5: number[];
  /** Metres the sender removed at each end of the trace (decided default 200, done by R2). */
  trimmedM: number;
}

/**
 * The bounds a run must meet to be drawn. Generous on purpose - a multi-day ride is legitimate -
 * and absolute: they say what no recording can produce, not what is typical.
 */
export const RUN_BOUNDS = {
  maxPoints: 500,
  maxTitleChars: 80,
  /** 30 days. */
  maxDurationS: 30 * 24 * 3600,
  /** 10 000 km. */
  maxDistanceM: 10_000_000,
  maxElevationGainM: 200_000,
  /** 50 km at each end. */
  maxTrimmedM: 50_000,
  /** 2000-01-01T00:00:00Z. */
  minStartedAt: 946_684_800_000,
  /** 2100-01-01T00:00:00Z. */
  maxStartedAt: 4_102_444_800_000,
  /** Latitude and longitude limits, in 1e-5 degree. */
  maxLatE5: 9_000_000,
  maxLonE5: 18_000_000,
} as const;

/** What a check answers: the activity, or why it cannot be drawn (a LOG line, never branched on). */
export type RunRead = { ok: true; activity: RunActivity } | { ok: false; why: string };

const SPORT_BY_PROTO: ReadonlyMap<number, RunSportName> = new Map([
  [canari.RunSport.RUN_SPORT_RUNNING, 'running'],
  [canari.RunSport.RUN_SPORT_CYCLING, 'cycling'],
  [canari.RunSport.RUN_SPORT_HIKING, 'hiking'],
  [canari.RunSport.RUN_SPORT_POOL_SWIM, 'pool-swim'],
]);

const PROTO_BY_SPORT: Readonly<Record<RunSportName, canari.RunSport>> = {
  unspecified: canari.RunSport.RUN_SPORT_UNSPECIFIED,
  running: canari.RunSport.RUN_SPORT_RUNNING,
  cycling: canari.RunSport.RUN_SPORT_CYCLING,
  hiking: canari.RunSport.RUN_SPORT_HIKING,
  'pool-swim': canari.RunSport.RUN_SPORT_POOL_SWIM,
};

const SPORT_NAMES: ReadonlySet<string> = new Set(Object.keys(PROTO_BY_SPORT));

/** C0 and C1 control characters, bidi overrides included: a title is one plain line. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

/**
 * A sport as the card names it. A number this build was never taught reads as `unspecified`, so a
 * newer writer's sport degrades to "an activity" instead of refusing the card.
 */
export function runSportFromProto(sport: number | null | undefined): RunSportName {
  const name = SPORT_BY_PROTO.get(Number(sport ?? 0));
  if (name) return name;
  if (sport) Log.d('CanaRun.sport', `sport ${String(sport)} unknown to this build - unspecified`);
  return 'unspecified';
}

/** A title cut to the bound, one line, no control characters - `undefined` when nothing is left. */
function cleanTitle(title: unknown): string | undefined {
  if (typeof title !== 'string') return undefined;
  const flat = title.replace(CONTROL_CHARS, ' ').trim();
  if (!flat) return undefined;
  // Cut on code points, so a surrogate pair is never split in half.
  return Array.from(flat).slice(0, RUN_BOUNDS.maxTitleChars).join('').trim();
}

/** `value` as a non-negative integer no larger than `max`, or why not. */
function boundedCount(name: string, value: unknown, max: number): number | string {
  if (typeof value !== 'number' || !Number.isInteger(value)) return `${name} is not an integer`;
  if (value < 0) return `${name} is negative`;
  if (value > max) return `${name} ${value} exceeds ${max}`;
  return value;
}

/**
 * THE ONE CHECK. Takes a candidate whose fields may be anything (it came from a peer), answers a
 * run whose every value is within {@link RUN_BOUNDS}, or why it is not. Both readers - the proto
 * frame and the stored envelope - end here.
 */
export function checkRunActivity(candidate: {
  sport: unknown;
  startedAt: unknown;
  durationS: unknown;
  movingS: unknown;
  distanceM: unknown;
  elevationGainM: unknown;
  title: unknown;
  trackE5: unknown;
  trimmedM: unknown;
}): RunRead {
  const sport: RunSportName =
    typeof candidate.sport === 'string' && SPORT_NAMES.has(candidate.sport)
      ? (candidate.sport as RunSportName)
      : 'unspecified';

  const startedAt = candidate.startedAt;
  if (typeof startedAt !== 'number' || !Number.isInteger(startedAt)) {
    return { ok: false, why: 'startedAt is not an integer' };
  }
  if (startedAt < RUN_BOUNDS.minStartedAt || startedAt > RUN_BOUNDS.maxStartedAt) {
    return { ok: false, why: `startedAt ${startedAt} is outside 2000-2100` };
  }

  const counts = {
    durationS: boundedCount('durationS', candidate.durationS, RUN_BOUNDS.maxDurationS),
    movingS: boundedCount('movingS', candidate.movingS, RUN_BOUNDS.maxDurationS),
    distanceM: boundedCount('distanceM', candidate.distanceM, RUN_BOUNDS.maxDistanceM),
    elevationGainM: boundedCount(
      'elevationGainM',
      candidate.elevationGainM,
      RUN_BOUNDS.maxElevationGainM
    ),
    trimmedM: boundedCount('trimmedM', candidate.trimmedM, RUN_BOUNDS.maxTrimmedM),
  };
  for (const v of Object.values(counts)) if (typeof v === 'string') return { ok: false, why: v };
  const { durationS, movingS, distanceM, elevationGainM, trimmedM } = counts as Record<
    keyof typeof counts,
    number
  >;
  if (movingS > durationS) {
    return { ok: false, why: `movingS ${movingS} exceeds durationS ${durationS}` };
  }

  const track = candidate.trackE5;
  if (!Array.isArray(track)) return { ok: false, why: 'trackE5 is not a list' };
  if (track.length % 2 !== 0) return { ok: false, why: 'trackE5 has an odd length' };
  if (track.length / 2 > RUN_BOUNDS.maxPoints) {
    return { ok: false, why: `${track.length / 2} points exceed ${RUN_BOUNDS.maxPoints}` };
  }
  for (let i = 0; i < track.length; i += 2) {
    const lat: unknown = track[i];
    const lon: unknown = track[i + 1];
    if (typeof lat !== 'number' || !Number.isInteger(lat) || Math.abs(lat) > RUN_BOUNDS.maxLatE5) {
      return { ok: false, why: `point ${i / 2} has an impossible latitude` };
    }
    if (typeof lon !== 'number' || !Number.isInteger(lon) || Math.abs(lon) > RUN_BOUNDS.maxLonE5) {
      return { ok: false, why: `point ${i / 2} has an impossible longitude` };
    }
  }
  let trackE5 = track as number[];
  if (sport === 'pool-swim' && trackE5.length > 0) {
    // Decided (2026-10-27): a pool swim is stats only. Whatever the sender put here is not drawn.
    Log.d('CanaRun.check', `pool swim with ${trackE5.length / 2} points - trace dropped`);
    trackE5 = [];
  }

  const title = cleanTitle(candidate.title);
  return {
    ok: true,
    activity: {
      sport,
      startedAt,
      durationS,
      movingS,
      distanceM,
      elevationGainM,
      ...(title ? { title } : {}),
      trackE5: [...trackE5],
      trimmedM,
    },
  };
}

/**
 * Reads a decoded `RunMsg` - a peer's frame. The trace is integrated from its deltas here, with
 * the point cap checked BEFORE any work so an oversized list costs one comparison.
 */
export function runActivityFromProto(run: canari.RunMsg.$Properties): RunRead {
  const lat = run.trackLat ?? [];
  const lon = run.trackLon ?? [];
  if (lat.length !== lon.length) {
    return { ok: false, why: `trace lists differ (${lat.length} lat, ${lon.length} lon)` };
  }
  if (lat.length > RUN_BOUNDS.maxPoints) {
    return { ok: false, why: `${lat.length} points exceed ${RUN_BOUNDS.maxPoints}` };
  }
  const trackE5: number[] = [];
  let y = 0;
  let x = 0;
  for (let i = 0; i < lat.length; i++) {
    // At most 500 sint32 terms: the running sum stays far inside the safe-integer range, and the
    // check below refuses the first point that leaves the globe.
    y += Number(lat[i]);
    x += Number(lon[i]);
    if (Math.abs(y) > RUN_BOUNDS.maxLatE5 || Math.abs(x) > RUN_BOUNDS.maxLonE5) {
      return { ok: false, why: `point ${i} integrates off the globe` };
    }
    trackE5.push(y, x);
  }
  return checkRunActivity({
    sport: runSportFromProto(run.sport),
    startedAt: Number(run.startedAt ?? 0),
    durationS: Number(run.durationS ?? 0),
    movingS: Number(run.movingS ?? 0),
    distanceM: Number(run.distanceM ?? 0),
    elevationGainM: Number(run.elevationGainM ?? 0),
    title: run.title ?? '',
    trackE5,
    trimmedM: Number(run.trimmedM ?? 0),
  });
}

/**
 * The `RunMsg` for an activity - the inverse of {@link runActivityFromProto}, delta-encoding the
 * trace. Used by tests and by the R2 writer; nothing in R1 sends it (`RUN_WRITER_ENABLED` in
 * `features.ts`).
 */
export function runActivityToProto(activity: RunActivity): canari.RunMsg.$Properties {
  const trackLat: number[] = [];
  const trackLon: number[] = [];
  let py = 0;
  let px = 0;
  for (let i = 0; i < activity.trackE5.length; i += 2) {
    trackLat.push(activity.trackE5[i] - py);
    trackLon.push(activity.trackE5[i + 1] - px);
    py = activity.trackE5[i];
    px = activity.trackE5[i + 1];
  }
  return {
    sport: PROTO_BY_SPORT[activity.sport],
    startedAt: activity.startedAt,
    durationS: activity.durationS,
    movingS: activity.movingS,
    distanceM: activity.distanceM,
    elevationGainM: activity.elevationGainM,
    ...(activity.title ? { title: activity.title } : {}),
    trackLat,
    trackLon,
    trimmedM: activity.trimmedM,
  };
}
