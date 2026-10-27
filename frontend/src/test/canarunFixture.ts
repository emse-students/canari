/**
 * One CanaRun activity every test reads - a 5.23 km run around a park in Saint-Etienne, with a
 * four-point trace - so the reader's tests, the bubble's and the pipeline's agree on one shape.
 */
import type { RunActivity } from '$lib/canarun/activity';

/** 2026-10-27T08:00:00Z. */
export const RUN_STARTED_AT = 1_793_088_000_000;

/** A checked activity, as `checkRunActivity` would answer it. */
export function sampleRun(over: Partial<RunActivity> = {}): RunActivity {
  return {
    sport: 'running',
    startedAt: RUN_STARTED_AT,
    durationS: 1_800,
    movingS: 1_740,
    distanceM: 5_230,
    elevationGainM: 42,
    title: 'Footing du matin',
    // lat, lon in 1e-5 degree.
    trackE5: [4_543_400, 439_000, 4_543_600, 439_300, 4_543_300, 439_500, 4_543_400, 439_000],
    trimmedM: 200,
    ...over,
  };
}
