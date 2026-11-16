import {
  assertTrendThresholdConfigured,
  parseTrendThreshold,
  TREND_THRESHOLD_DEFAULT,
  TREND_THRESHOLD_ENV,
  trendThreshold,
} from './trend-threshold';
import { evaluateTrendSql } from './campus-trend';

describe('the campus trend threshold setting', () => {
  const previous = process.env[TREND_THRESHOLD_ENV];
  afterEach(() => {
    if (previous === undefined) delete process.env[TREND_THRESHOLD_ENV];
    else process.env[TREND_THRESHOLD_ENV] = previous;
  });

  it('defaults to production value 10 when unset or blank', () => {
    expect(TREND_THRESHOLD_DEFAULT).toBe(10);
    expect(parseTrendThreshold(undefined)).toBe(10);
    expect(parseTrendThreshold('  ')).toBe(10);
    delete process.env[TREND_THRESHOLD_ENV];
    expect(trendThreshold()).toBe(10);
  });

  it('honours a configured positive integer', () => {
    expect(parseTrendThreshold('3')).toBe(3);
    process.env[TREND_THRESHOLD_ENV] = ' 4 ';
    expect(trendThreshold()).toBe(4);
    expect(assertTrendThresholdConfigured()).toBe(4);
  });

  it('REFUSES a value that is set and is not a positive integer: no silent fallback', () => {
    for (const bad of ['0', '-1', '2.5', 'ten', '10x', '1e1', 'NaN', '99999999999999999999']) {
      expect(() => parseTrendThreshold(bad)).toThrow(/CAMPUS_TREND_THRESHOLD/);
      process.env[TREND_THRESHOLD_ENV] = bad;
      expect(() => assertTrendThresholdConfigured()).toThrow(/CAMPUS_TREND_THRESHOLD/);
    }
  });

  it('writes the configured threshold into the evaluation statement', () => {
    delete process.env[TREND_THRESHOLD_ENV];
    expect(evaluateTrendSql()).toContain('>= 10');
    expect(evaluateTrendSql()).toContain('< 10');
    process.env[TREND_THRESHOLD_ENV] = '3';
    expect(evaluateTrendSql()).toContain('>= 3');
    expect(evaluateTrendSql()).toContain('< 3');
  });
});
