/** The units each sport is read in (decided 2026-10-27), and the locale's numbers. */
import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '$lib/paraglide/runtime';
import {
  formatRunDistance,
  formatRunDuration,
  formatRunElevation,
  formatRunRate,
  runSummary,
} from './format';
import { sampleRun } from '../../test/canarunFixture';

afterEach(() => setLocale('fr', { reload: false }));

describe('CanaRun units', () => {
  it('reads running and hiking as a pace in min/km', () => {
    setLocale('en', { reload: false });
    // 1740 s moving over 5.23 km = 332.7 s/km.
    expect(formatRunRate(sampleRun())).toEqual({ label: 'Pace', value: '5:33 /km' });
    expect(formatRunRate(sampleRun({ sport: 'hiking' }))?.label).toBe('Pace');
  });

  it('reads cycling as a speed in km/h, in the locale', () => {
    const ride = sampleRun({
      sport: 'cycling',
      distanceM: 36_000,
      movingS: 3_600,
      durationS: 3_700,
    });
    setLocale('fr', { reload: false });
    expect(formatRunRate(ride)).toEqual({ label: 'Vitesse', value: '36,0 km/h' });
    setLocale('en', { reload: false });
    expect(formatRunRate(ride)?.value).toBe('36.0 km/h');
  });

  it('gives a pool swim metres, no rate and no elevation', () => {
    setLocale('en', { reload: false });
    const swim = sampleRun({ sport: 'pool-swim', distanceM: 1_500, trackE5: [] });
    expect(formatRunDistance(swim)).toBe('1,500 m');
    expect(formatRunRate(swim)).toBeNull();
    expect(formatRunElevation(swim)).toBeNull();
  });

  it('prints kilometres with the locale separator', () => {
    setLocale('fr', { reload: false });
    expect(formatRunDistance(sampleRun())).toBe('5,23 km');
    expect(formatRunDistance(sampleRun({ distanceM: 42_195 }))).toBe('42,2 km');
    setLocale('en', { reload: false });
    expect(formatRunDistance(sampleRun())).toBe('5.23 km');
  });

  it('gives no rate for nothing travelled', () => {
    expect(formatRunRate(sampleRun({ distanceM: 0 }))).toBeNull();
    expect(formatRunRate(sampleRun({ durationS: 0, movingS: 0 }))).toBeNull();
  });

  it('formats a duration as a clock', () => {
    expect(formatRunDuration(1_800)).toBe('30:00');
    expect(formatRunDuration(3_725)).toBe('1:02:05');
  });

  it('summarises a run in one line', () => {
    setLocale('en', { reload: false });
    expect(runSummary(sampleRun())).toBe('Run · 5.23 km');
    expect(runSummary(sampleRun({ distanceM: 0 }))).toBe('Run');
  });
});
