/// <reference types="jest" />
import {
  INSTALLED_APP_DEVICE_PREFIX,
  parseNotificationState,
  pushPresenceLine,
  PUSH_BROWSER_ONLY_SQL,
  PUSH_UNKNOWN_ID_SQL,
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
    expect(d.query).toHaveBeenCalledTimes(3);
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
    expect(l.log).toHaveBeenCalledWith(
      expect.stringMatching(/ran in 24 h: 66, .*: 24, .*: 0, .*: 0$/)
    );
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
    expect(l.log).toHaveBeenCalledTimes(2);
    expect(l.warn).not.toHaveBeenCalled();
  });

  it('a phone the OS gives no push token is COUNTED apart, never accused - zero stays the steady state', async () => {
    const l = logger();
    await reportPushCoverage(
      db([{ os: 'android', build: '1.7.0', devices: 40, withoutPush: 0, noOsToken: 2 }]),
      l,
      NOW
    );
    expect(l.log).toHaveBeenCalledWith(
      expect.stringMatching(/: 0, given no push token .*: 2, registered .*: 0$/)
    );
    expect(l.warn).not.toHaveBeenCalled();
  });
});

describe('the coverage counts the INSTALLED app only (2026-11-21)', () => {
  it('filters on the tauri- id prefix, so a mobile browser reporting android is no phone', () => {
    expect(INSTALLED_APP_DEVICE_PREFIX).toBe('tauri-');
    expect(PUSH_COVERAGE_SQL).toContain(`k."deviceId" LIKE 'tauri-%'`);
    expect(PUSH_BROWSER_ONLY_SQL).toContain(`k."deviceId" NOT LIKE 'tauri-%'`);
    expect(PUSH_BROWSER_ONLY_SQL).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
  });

  it('ACCUSES a phone-OS device whose id is neither tauri- nor web-, never drops it in silence', async () => {
    const l = { log: jest.fn(), warn: jest.fn() };
    const d = {
      query: jest.fn(async (sql: string): Promise<never> => {
        if (sql === PUSH_UNKNOWN_ID_SQL) return [{ other: 2 }] as never;
        return [] as never;
      }),
    };
    await reportPushCoverage(d, l, Date.now());
    expect(PUSH_UNKNOWN_ID_SQL).toContain(`k."deviceId" NOT LIKE 'tauri-%'`);
    expect(PUSH_UNKNOWN_ID_SQL).toContain(`k."deviceId" NOT LIKE 'web-%'`);
    expect(PUSH_UNKNOWN_ID_SQL).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
    expect(l.warn).toHaveBeenCalledWith(expect.stringContaining('2 phone-OS device(s)'));
  });

  it('says the browser-only members as information at log, never as a warning', async () => {
    const l = { log: jest.fn(), warn: jest.fn() };
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ members: 17 }]);
    await reportPushCoverage({ query } as never, l, Date.now());
    expect(l.log).toHaveBeenCalledWith(
      expect.stringMatching(/only through a mobile browser.*: 17$/)
    );
    expect(l.warn).not.toHaveBeenCalled();
  });

  it('prints no [PUSH_MISSING] for a browser device that reports android', () => {
    const base = { userId: 'u', build: '1.7.0', held: false, outcome: 'none', deviceOs: 'android' };
    expect(pushPresenceLine({ ...base, deviceId: 'web-u-1-a' })).toBeNull();
    expect(pushPresenceLine({ ...base, deviceId: 'tauri-u-1-a' })).not.toBeNull();
  });

  it('counts registered-but-permission-off as its own category, accused by build', async () => {
    const l = { log: jest.fn(), warn: jest.fn() };
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        {
          os: 'android',
          build: '1.7.3',
          devices: 10,
          withoutPush: 0,
          noOsToken: 0,
          permissionOff: 2,
        },
      ])
      .mockResolvedValueOnce([{ members: 0 }]);
    await reportPushCoverage({ query } as never, l, Date.now());
    expect(l.log).toHaveBeenCalledWith(expect.stringContaining('[PUSH_PERMISSION_OFF]): 2'));
    expect(l.warn).toHaveBeenCalledTimes(1);
    expect(l.warn).toHaveBeenCalledWith(
      expect.stringContaining('[PUSH_PERMISSION_OFF] os=android build=1.7.3 off=2/10')
    );
    expect(PUSH_COVERAGE_SQL).toContain(`"notificationState" IN ('off', 'not-asked'`);
  });
});

describe('parseNotificationState', () => {
  const android = (o: object) => ({
    permission: 'granted',
    enabled: true,
    channels: { messages: 'high', posts: 'default' },
    ...o,
  });

  it('absent is unknown, never on - an old client says nothing', () => {
    expect(parseNotificationState(undefined)).toEqual({ state: 'unknown', channels: null });
    expect(parseNotificationState(null).state).toBe('unknown');
  });

  it.each([
    [android({}), 'on', 'messages=high posts=default'],
    [android({ permission: 'denied', enabled: false }), 'off', 'messages=high posts=default'],
    [android({ enabled: false }), 'off', 'messages=high posts=default'],
    [
      android({ channels: { messages: 'none', posts: 'high' } }),
      'channel-off',
      'messages=none posts=high',
    ],
    [{ permission: 'not-determined', enabled: false }, 'not-asked', null],
    [{ permission: 'denied', enabled: false, alerts: false }, 'off', null],
    [{ permission: 'granted', enabled: true, alerts: false }, 'alerts-off', null],
    [{ permission: 'provisional', enabled: true, alerts: true }, 'on', null],
  ])('%j is %s', (raw, state, channels) => {
    expect(parseNotificationState(raw)).toEqual({ state, channels });
  });

  it('a permitted device that does not state `enabled` is unknown, not on', () => {
    expect(parseNotificationState({ permission: 'granted' }).state).toBe('unknown');
  });

  it.each([
    'granted',
    [],
    { permission: 'maybe', enabled: true },
    { permission: 'granted', enabled: 'yes' },
    { permission: 'granted', enabled: true, alerts: 1 },
    { permission: 'granted', enabled: true, channels: { messages: 'loud' } },
    { permission: 'granted', enabled: true, channels: 'x' },
  ])('%j is invalid, and stores nothing', (raw) => {
    expect(parseNotificationState(raw)).toEqual({ state: 'invalid', channels: null });
  });

  it('ignores a channel it was not asked about', () => {
    const r = parseNotificationState(android({ channels: { messages: 'low', evil: 'x' } }));
    expect(r.channels).toBe('messages=low');
  });
});
