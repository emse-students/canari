/// <reference types="jest" />
import {
  PUSH_COVERAGE_SQL,
  PUSH_COVERAGE_WINDOW_MS,
  PUSH_REGISTRATION_GRACE_MS,
  reportPushCoverage,
} from './push-coverage';

/**
 * THE DAILY PUSH-COVERAGE COUNT, with the database stubbed: one read, no write, the cutoffs it is
 * asked with, and a WARN per build whose phones ran and hold no registration. The predicate is the
 * one that re-measured the 2026-11-15 incident (every older build 0, `1.6.12` 24 of 58).
 */
describe('reportPushCoverage', () => {
  const NOW = Date.parse('2026-11-15T20:00:00Z');
  const logger = () => ({ log: jest.fn(), warn: jest.fn() });
  const db = (rows: unknown[]) => ({ query: jest.fn(async (): Promise<never> => rows as never) });

  it('reads once, read-only, with the window, the ladder grace, the ban cutoff and now', async () => {
    const d = db([]);
    await reportPushCoverage(d, logger(), NOW);
    expect(d.query).toHaveBeenCalledTimes(1);
    const [sql, params] = d.query.mock.calls[0] as unknown as [string, Date[]];
    expect(sql).toBe(PUSH_COVERAGE_SQL);
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
    expect(params[0].getTime()).toBe(NOW - PUSH_COVERAGE_WINDOW_MS);
    expect(params[1].getTime()).toBe(NOW - PUSH_REGISTRATION_GRACE_MS);
    expect(params[3].getTime()).toBe(NOW);
  });

  it('asks about the phones that RAN - a key package reset by register-device - never row age', () => {
    expect(PUSH_COVERAGE_SQL).toMatch(/k\."createdAt" > \$1\s+AND k\."createdAt" <= \$2/);
    expect(PUSH_COVERAGE_SQL).toContain(`k."deviceOs" IN ('android', 'ios')`);
    expect(PUSH_COVERAGE_SQL).toContain(`s."userId" = k."userId"`);
    expect(PUSH_COVERAGE_SQL).toMatch(
      /t\."userId" = l\."userId"\s+AND t\."deviceId" = l\."deviceId"/
    );
  });

  it('the incident: one plain total, and the build that lost its pushes ACCUSED by name', async () => {
    const l = logger();
    await reportPushCoverage(
      db([
        { os: 'android', build: '1.6.11', devices: 8, withoutPush: 0, noOsToken: 0 },
        { os: 'android', build: '1.6.12', devices: 38, withoutPush: 14, noOsToken: 0 },
        { os: 'ios', build: '1.6.12', devices: 20, withoutPush: 10, noOsToken: 0 },
      ]),
      l,
      NOW
    );
    expect(l.log).toHaveBeenCalledWith(expect.stringMatching(/ran in 24 h: 66, .*: 24, .*: 0$/));
    expect(l.warn).toHaveBeenCalledTimes(2);
    expect(l.warn).toHaveBeenCalledWith(
      expect.stringContaining('os=android build=1.6.12 without=14/38')
    );
    expect(l.warn).toHaveBeenCalledWith(
      expect.stringContaining('os=ios build=1.6.12 without=10/20')
    );
  });

  it('the WARN tallies what the unregistered phones last stated - the branch, without log access', async () => {
    const l = logger();
    await reportPushCoverage(
      db([
        {
          os: 'ios',
          build: '1.7.0',
          devices: 20,
          withoutPush: 4,
          noOsToken: 0,
          outcomes: [
            'in-progress:permission',
            'unauthorized:other',
            'unauthorized:other',
            'unstated',
          ],
        },
      ]),
      l,
      NOW
    );
    expect(l.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'without=4/20 last: unauthorized:other=2 in-progress:permission=1 unstated=1 - '
      )
    );
  });

  it('asks the outcome of the unregistered phones only - the no-token ones are counted apart', () => {
    expect(PUSH_COVERAGE_SQL).toContain(
      `array_agg(u."outcome" ORDER BY u."outcome")\n         FILTER (WHERE u."noRow" AND NOT u."noOsToken")`
    );
  });

  it('zero is the steady state: one line, no accusation', async () => {
    const l = logger();
    await reportPushCoverage(
      db([{ os: 'ios', build: '1.6.11', devices: 29, withoutPush: 0, noOsToken: 0 }]),
      l,
      NOW
    );
    expect(l.log).toHaveBeenCalledTimes(1);
    expect(l.warn).not.toHaveBeenCalled();
  });

  it('a phone the OS gives no push token is COUNTED apart, never accused - zero stays the steady state', async () => {
    const l = logger();
    await reportPushCoverage(
      db([{ os: 'android', build: '1.7.0', devices: 40, withoutPush: 0, noOsToken: 2 }]),
      l,
      NOW
    );
    expect(l.log).toHaveBeenCalledWith(expect.stringMatching(/: 0, given no push token .*: 2$/));
    expect(l.warn).not.toHaveBeenCalled();
  });
});
