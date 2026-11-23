/// <reference types="jest" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import {
  addDays,
  daysFrom,
  monthStart,
  nextMonthStart,
  parisSlot,
  weekStart,
  weekdayIndex,
} from './paris-time';
import { UsageActivity } from './usage-activity';
import {
  USAGE_ACTIVITY_METRICS,
  USAGE_CATEGORIES,
  USAGE_DAY_KEY_TTL_SECS,
  USAGE_FOLD_DAYS,
  USAGE_HOUR_KEY_TTL_SECS,
  USAGE_KEY_PREFIX,
  activityKey,
  peopleCategoryKey,
  peopleHourKey,
  peopleKey,
  peopleVersionKey,
  peopleVersionsKey,
} from './usage-contract';
import { foldSpans, readFigures, writeFigures, type UsageRedisReader } from './usage-fold';
import { hourSlots, readHourMap, shapePeriods } from './usage-read';

const contract = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../libs/contracts/usage-dashboard.json'), 'utf8')
) as {
  keyPrefix: string;
  categories: string[];
  activityMetrics: string[];
  dayKeyTtlSecs: number;
  hourKeyTtlSecs: number;
  parisTime: { instant: string; day: string; hour: number }[];
};

/**
 * A Redis double with EXACT distinct sets standing in for HyperLogLogs: the fold's job is to ask
 * the right unions, which an exact set answers exactly.
 */
function fakeRedis(
  people: Record<string, string[]>,
  sets: Record<string, string[]> = {},
  hashes: Record<string, Record<string, string>> = {}
) {
  const asked: string[][] = [];
  const reader: UsageRedisReader = {
    pfcountEach: async (groups) =>
      groups.map((keys) => {
        asked.push([...keys]);
        return new Set(keys.flatMap((k) => people[k] ?? [])).size;
      }),
    smembersEach: async (keys) => keys.map((k) => sets[k] ?? []),
    hgetallEach: async (keys) => keys.map((k) => hashes[k] ?? {}),
  };
  return { reader, asked };
}

describe('the usage dashboard (docs/wiki/usage-dashboard.md)', () => {
  describe('the contract', () => {
    it('is this service s constants', () => {
      expect(USAGE_KEY_PREFIX).toBe(contract.keyPrefix);
      expect([...USAGE_CATEGORIES]).toEqual(contract.categories);
      expect([...USAGE_ACTIVITY_METRICS]).toEqual(contract.activityMetrics);
      expect(USAGE_DAY_KEY_TTL_SECS).toBe(contract.dayKeyTtlSecs);
      expect(USAGE_HOUR_KEY_TTL_SECS).toBe(contract.hourKeyTtlSecs);
    });

    it('names the keys the gateway writes', () => {
      expect([
        peopleKey('2026-11-23'),
        peopleCategoryKey('2026-11-23', 'web_ios'),
        peopleVersionsKey('2026-11-23'),
        peopleVersionKey('2026-11-23', '1.8.0'),
        peopleHourKey('2026-11-23', 7),
        activityKey('2026-11-23'),
      ]).toEqual([
        'usage:people:2026-11-23',
        'usage:people:2026-11-23:cat:web_ios',
        'usage:people:2026-11-23:versions',
        'usage:people:2026-11-23:ver:1.8.0',
        'usage:people:h:2026-11-23T07',
        'usage:activity:2026-11-23',
      ]);
    });

    it('keeps every day the fold reads alive', () => {
      expect(USAGE_FOLD_DAYS * 86_400).toBeLessThan(USAGE_DAY_KEY_TTL_SECS);
    });
  });

  describe('Paris time', () => {
    it('agrees with the contract on both changes of the hour and on midnight', () => {
      for (const c of contract.parisTime) {
        expect([c.instant, parisSlot(new Date(c.instant))]).toEqual([
          c.instant,
          { day: c.day, hour: c.hour },
        ]);
      }
    });

    it('does calendar arithmetic on days, across months, years and a leap day', () => {
      expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
      expect(addDays('2025-12-31', 1)).toBe('2026-01-01');
      expect(weekdayIndex('2026-11-23')).toBe(0);
      expect(weekdayIndex('2026-11-29')).toBe(6);
      expect(weekStart('2026-11-29')).toBe('2026-11-23');
      expect(weekStart('2026-01-01')).toBe('2025-12-29');
      expect(monthStart('2026-11-23')).toBe('2026-11-01');
      expect(nextMonthStart('2026-12-05')).toBe('2027-01-01');
      expect(daysFrom('2026-10-30', '2026-11-02')).toEqual([
        '2026-10-30',
        '2026-10-31',
        '2026-11-01',
        '2026-11-02',
      ]);
    });
  });

  describe('the activity counter', () => {
    const quiet = () => {
      jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
      return jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    };
    afterEach(() => jest.restoreAllMocks());

    it('adds one to the Paris day of the injected instant, with the day s expiry', async () => {
      quiet();
      const evalScript = jest.fn().mockResolvedValue(1);
      await new UsageActivity({ evalScript } as never).count(
        'reels',
        new Date('2026-11-22T23:30:00Z')
      );
      expect(evalScript).toHaveBeenCalledWith(
        expect.stringContaining('HINCRBY'),
        ['usage:activity:2026-11-23'],
        ['reels', USAGE_DAY_KEY_TTL_SECS]
      );
    });

    it('never throws: a lost count is a warn naming it', async () => {
      const warn = quiet();
      const evalScript = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      await expect(
        new UsageActivity({ evalScript } as never).count('lives', new Date('2026-11-23T10:00:00Z'))
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/lives NOT counted on 2026-11-23.*ECONNREFUSED/)
      );
    });
  });

  describe('the fold', () => {
    it('reads every day of the window, and only the weeks and months that start inside it', () => {
      const spans = foldSpans('2026-11-23');
      const days = spans.filter((s) => s.period === 'day').map((s) => s.start);
      expect(days).toHaveLength(USAGE_FOLD_DAYS);
      expect(days[days.length - 1]).toBe('2026-11-23');
      const first = days[0];
      for (const s of spans.filter((x) => x.period !== 'day')) {
        expect(s.start >= first).toBe(true);
        expect(s.days.every((d) => d <= '2026-11-23')).toBe(true);
      }
      // October ended 23 days ago: it started before the window, and kept the value it was folded to.
      expect(spans.some((s) => s.period === 'month' && s.start === '2026-10-01')).toBe(false);
      // Five days after it ended, the whole of October is still read.
      const october = foldSpans('2026-11-05').find(
        (s) => s.period === 'month' && s.start === '2026-10-01'
      );
      expect(october?.days).toHaveLength(31);
      const thisWeek = spans.find((s) => s.period === 'week' && s.start === '2026-11-23');
      expect(thisWeek?.days).toEqual(['2026-11-23']);
    });

    it('counts a person once per week, however many days, devices and categories', async () => {
      const mon = '2026-11-16';
      const fri = '2026-11-20';
      const { reader } = fakeRedis(
        {
          [peopleKey(mon)]: ['alice', 'bob'],
          [peopleKey(fri)]: ['alice'],
          [peopleCategoryKey(mon, 'app_ios')]: ['alice'],
          [peopleCategoryKey(mon, 'web_desktop')]: ['alice', 'bob'],
          [peopleVersionKey(mon, '1.8.0')]: ['alice', 'bob'],
          [peopleVersionKey(fri, '1.8.0')]: ['alice'],
        },
        { [peopleVersionsKey(mon)]: ['1.8.0'], [peopleVersionsKey(fri)]: ['1.8.0'] },
        { [activityKey(mon)]: { messages: '12', posts: '1', unknown: '9' } }
      );
      const figures = await readFigures(reader, '2026-11-23');
      const get = (period: string, start: string, metric: string, dimension: string) =>
        figures.find(
          (f) =>
            f.period === period &&
            f.start === start &&
            f.metric === metric &&
            f.dimension === dimension
        )?.value;
      expect(get('day', mon, 'people', 'all')).toBe(2);
      expect(get('day', fri, 'people', 'all')).toBe(1);
      expect(get('week', mon, 'people', 'all')).toBe(2);
      expect(get('week', mon, 'people', 'ver:1.8.0')).toBe(2);
      expect(get('day', mon, 'people', 'cat:app_ios')).toBe(1);
      expect(get('day', mon, 'people', 'cat:web_desktop')).toBe(2);
      expect(get('month', '2026-11-01', 'people', 'all')).toBe(2);
      // A category nobody used is no row; a day with nobody still says 0 people.
      expect(get('day', mon, 'people', 'cat:app_android')).toBeUndefined();
      expect(get('day', '2026-11-17', 'people', 'all')).toBe(0);
      // Activity: per day, the six metrics, a field nobody decided ignored.
      expect(get('day', mon, 'messages', 'all')).toBe(12);
      expect(get('day', mon, 'calls', 'all')).toBe(0);
      expect(figures.some((f) => f.metric === 'unknown')).toBe(false);
      expect(figures.some((f) => f.period !== 'day' && f.metric !== 'people')).toBe(false);
    });

    it('writes in primary-key order, keeping the larger value, in one statement', async () => {
      const query = jest.fn().mockResolvedValue([]);
      const n = await writeFigures({ query }, [
        { period: 'week', start: '2026-11-16', metric: 'people', dimension: 'all', value: 3 },
        { period: 'day', start: '2026-11-17', metric: 'people', dimension: 'all', value: 2 },
        { period: 'day', start: '2026-11-16', metric: 'messages', dimension: 'all', value: 5 },
      ]);
      expect(n).toBe(3);
      expect(query).toHaveBeenCalledTimes(1);
      const [sql, params] = query.mock.calls[0] as [string, unknown[][]];
      expect(sql).toMatch(/ON CONFLICT \(period, start, metric, dimension\)/);
      expect(sql).toMatch(/WHERE usage_figures\.value < EXCLUDED\.value/);
      expect(params[0]).toEqual(['day', 'day', 'week']);
      expect(params[1]).toEqual(['2026-11-16', '2026-11-17', '2026-11-16']);
      expect(params[4]).toEqual([5, 2, 3]);
    });

    it('writes nothing for nothing', async () => {
      const query = jest.fn();
      expect(await writeFigures({ query }, [])).toBe(0);
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe('the read', () => {
    it('shows a period only once it was folded, with its breakdown and its activity', () => {
      const view = shapePeriods([
        { period: 'day', start: '2026-11-17', metric: 'people', dimension: 'all', value: '4' },
        { period: 'day', start: '2026-11-16', metric: 'people', dimension: 'all', value: '2' },
        {
          period: 'day',
          start: '2026-11-16',
          metric: 'people',
          dimension: 'cat:app_ios',
          value: '1',
        },
        {
          period: 'day',
          start: '2026-11-16',
          metric: 'people',
          dimension: 'ver:1.8.0',
          value: '2',
        },
        { period: 'day', start: '2026-11-16', metric: 'messages', dimension: 'all', value: '12' },
        // A breakdown row of a period with no total is never shown alone.
        {
          period: 'week',
          start: '2026-11-09',
          metric: 'people',
          dimension: 'cat:app_ios',
          value: '1',
        },
        { period: 'month', start: '2026-11-01', metric: 'people', dimension: 'all', value: '5' },
      ]);
      expect(view.days.map((d) => d.start)).toEqual(['2026-11-16', '2026-11-17']);
      expect(view.days[0].people).toEqual({
        all: 2,
        categories: { app_ios: 1 },
        versions: { '1.8.0': 2 },
      });
      expect(view.days[0].activity?.messages).toBe(12);
      expect(view.days[0].activity?.forms).toBe(0);
      expect(view.weeks).toEqual([]);
      expect(view.months[0]).toEqual({
        start: '2026-11-01',
        people: { all: 5, categories: {}, versions: {} },
      });
      expect(view.months[0].activity).toBeUndefined();
    });

    it('names each Paris hour of the 28 days once, through both changes of the hour', () => {
      // 2026-03-29 has 23 hours (no 02h), 2026-10-25 has 25 (02h twice, one slot).
      const spring = hourSlots('2026-04-10');
      expect(spring.from).toBe('2026-03-13');
      expect(spring.to).toBe('2026-04-09');
      expect(spring.slots).toHaveLength(28 * 24 - 1);
      expect(spring.slots.some((s) => s.day === '2026-03-29' && s.hour === 2)).toBe(false);
      const autumn = hourSlots('2026-11-05');
      expect(autumn.slots).toHaveLength(28 * 24);
      expect(autumn.slots.filter((s) => s.day === '2026-10-25' && s.hour === 2)).toHaveLength(1);
    });

    it('maps the mean of each weekday and hour, never averaging an hour that did not exist', async () => {
      const today = '2026-11-23'; // a Monday: the four weeks before are Mondays 10/26 .. 11/16
      const { reader, asked } = fakeRedis({
        [peopleHourKey('2026-11-16', 9)]: ['a', 'b', 'c', 'd'],
        [peopleHourKey('2026-11-09', 9)]: ['a', 'b'],
        [peopleHourKey('2026-11-22', 21)]: ['a'],
      });
      const map = await readHourMap(reader, today);
      expect(map.cells).toHaveLength(7);
      expect(map.cells[0][9]).toBe(1.5); // (4 + 2 + 0 + 0) / 4 Mondays
      expect(map.cells[6][21]).toBe(0.3); // 1 / 4 Sundays, one decimal
      expect(map.cells[2][3]).toBe(0);
      expect(asked.every((keys) => keys.length === 1)).toBe(true);
      expect(asked.some(([k]) => k.includes(today))).toBe(false);
    });
  });
});
