import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { readLiveReportAge, workingMsBetween } from './live-report-age';
import { LiveReportAgeScheduler } from './live-report-age.scheduler';
import { LIVE_REPORT_RESPONSE_WORKING_MS, LIVE_REPORT_WORKING_ZONE } from './live.constants';

const PARIS = 'Europe/Paris';
const H = 3_600_000;
const at = (iso: string) => Date.parse(iso);

// 2026-10-21 is a Wednesday; Paris leaves summer time in the night of Sunday 2026-10-25.
describe('workingMsBetween', () => {
  it('counts a weekday span whole', () => {
    // Wed 10:00 -> Thu 10:00, Paris summer time (UTC+2).
    expect(workingMsBetween(at('2026-10-21T08:00:00Z'), at('2026-10-22T08:00:00Z'), PARIS)).toBe(
      24 * H
    );
  });

  it('crosses a local midnight between two weekdays without losing the hour around it', () => {
    // Wed 23:00 -> Thu 01:00 Paris.
    expect(workingMsBetween(at('2026-10-21T21:00:00Z'), at('2026-10-21T23:00:00Z'), PARIS)).toBe(
      2 * H
    );
  });

  it('leaves out Saturday and Sunday, in the zone, across a daylight-saving change', () => {
    // Fri 18:00 (UTC+2) -> Mon 18:00 (UTC+1): 73 h on the wall, 6 h of Friday + 18 h of Monday.
    const from = at('2026-10-23T16:00:00Z');
    const to = at('2026-10-26T17:00:00Z');
    expect(to - from).toBe(73 * H);
    expect(workingMsBetween(from, to, PARIS)).toBe(24 * H);
  });

  it('is zero for a span inside one weekend', () => {
    expect(workingMsBetween(at('2026-10-24T08:00:00Z'), at('2026-10-25T20:00:00Z'), PARIS)).toBe(0);
  });

  it('cuts the weekend at the ZONE midnight, not UTC', () => {
    // Fri 23:30 Paris is 21:30Z: half an hour of Friday is working time, then the weekend.
    expect(workingMsBetween(at('2026-10-23T21:30:00Z'), at('2026-10-24T10:00:00Z'), PARIS)).toBe(
      0.5 * H
    );
  });

  it('is zero when the end is not after the start', () => {
    expect(workingMsBetween(at('2026-10-22T08:00:00Z'), at('2026-10-21T08:00:00Z'), PARIS)).toBe(0);
    expect(workingMsBetween(at('2026-10-22T08:00:00Z'), at('2026-10-22T08:00:00Z'), PARIS)).toBe(0);
  });
});

describe('readLiveReportAge', () => {
  it('reads an empty queue as nothing pending', () => {
    expect(readLiveReportAge([], at('2026-10-21T08:00:00Z'), 24 * H, PARIS)).toEqual({
      pending: 0,
      overdue: 0,
      oldestWallMs: null,
      oldestWorkingMs: null,
    });
  });

  it('is not overdue at exactly the commitment, and is a moment past it', () => {
    const filed = new Date('2026-10-23T16:00:00Z'); // Fri 18:00
    const monday1800 = at('2026-10-26T17:00:00Z');
    expect(readLiveReportAge([filed], monday1800, 24 * H, PARIS).overdue).toBe(0);
    expect(readLiveReportAge([filed], monday1800 + 60_000, 24 * H, PARIS).overdue).toBe(1);
  });

  it('names the oldest report and counts every late one', () => {
    const now = at('2026-10-23T12:00:00Z'); // Fri 14:00
    const reading = readLiveReportAge(
      [
        new Date('2026-10-21T08:00:00Z'), // Wed 10:00: 52 h working
        new Date('2026-10-22T08:00:00Z'), // Thu 10:00: 28 h
        new Date('2026-10-23T08:00:00Z'), // Fri 10:00: 4 h
      ],
      now,
      24 * H,
      PARIS
    );
    expect(reading).toEqual({
      pending: 3,
      overdue: 2,
      oldestWallMs: 52 * H,
      oldestWorkingMs: 52 * H,
    });
  });
});

describe('LiveReportAgeScheduler', () => {
  let logs: { log: string[]; error: string[] };

  beforeEach(() => {
    logs = { log: [], error: [] };
    jest.spyOn(Logger.prototype, 'log').mockImplementation((m: unknown) => {
      logs.log.push(String(m));
    });
    jest.spyOn(Logger.prototype, 'error').mockImplementation((m: unknown) => {
      logs.error.push(String(m));
    });
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  /** A DataSource answering the scheduler's one statement with `now` and these creation instants. */
  const source = (now: string, created: string[]) =>
    ({
      query: jest.fn(async () =>
        created.length === 0
          ? [{ now: new Date(now), at: null }]
          : created.map((c) => ({ now: new Date(now), at: new Date(c) }))
      ),
    }) as unknown as DataSource;

  it('reads the pending live reports only, on the database clock, in one statement', async () => {
    const ds = source('2026-10-21T08:00:00Z', []);
    await new LiveReportAgeScheduler(ds).reportOnce();
    const sql = (ds.query as jest.Mock).mock.calls[0][0] as string;
    expect(sql).toContain(`status = 'pending'`);
    expect(sql).toContain(`"contentType" IN ('live', 'live_chat')`);
    expect(sql).toContain('now()');
    expect((ds.query as jest.Mock).mock.calls).toHaveLength(1);
  });

  it('prints pending=0 on an empty queue, so a silent alarm never reads as an empty one', async () => {
    await new LiveReportAgeScheduler(source('2026-10-21T08:00:00Z', [])).reportOnce();
    expect(logs.log).toEqual(['[LIVE_REPORT_AGE] pending=0']);
    expect(logs.error).toEqual([]);
  });

  it('logs at log level while every report is inside the commitment', async () => {
    await new LiveReportAgeScheduler(
      source('2026-10-23T12:00:00Z', ['2026-10-23T08:00:00Z'])
    ).reportOnce();
    expect(logs.error).toEqual([]);
    expect(logs.log).toEqual([
      '[LIVE_REPORT_AGE] pending=1 overdue=0 oldest=4.0h working (4.0h wall), inside the 24.0h',
    ]);
  });

  it('logs at ERROR with the age and the count once one is past it, and no user data', async () => {
    await new LiveReportAgeScheduler(
      source('2026-10-26T17:00:00Z', [
        '2026-10-23T08:00:00Z', // Fri 10:00 -> Mon 18:00: 32 h working, 81 h wall
        '2026-10-26T08:00:00Z', // Mon 09:00: 9 h
      ])
    ).reportOnce();
    expect(logs.log).toEqual([]);
    expect(logs.error).toHaveLength(1);
    const line = logs.error[0];
    expect(line).toContain('pending=2 overdue=1 oldest=32.0h working (81.0h wall)');
    expect(line).toContain('past the 24.0h working-day commitment');
    // Counts and ages only: no uuid, no 64-hex account id.
    expect(line).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    expect(line).not.toMatch(/[0-9a-f]{64}/i);
  });

  it('says at ERROR that the commitment is unwatched when the queue cannot be read', async () => {
    const ds = {
      query: jest.fn(async () => {
        throw new Error('connection refused');
      }),
    } as unknown as DataSource;
    await new LiveReportAgeScheduler(ds).report();
    expect(logs.error).toHaveLength(1);
    expect(logs.error[0]).toContain('unwatched');
  });

  it('measures the owner commitment: 24 h of working time in the school zone', () => {
    expect(LIVE_REPORT_RESPONSE_WORKING_MS).toBe(24 * H);
    expect(LIVE_REPORT_WORKING_ZONE).toBe(PARIS);
  });
});
