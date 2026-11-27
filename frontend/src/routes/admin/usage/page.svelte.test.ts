// @vitest-environment happy-dom
/**
 * THE USAGE DASHBOARD IS FIGURES ONLY (owner, 2026-11-19; docs/wiki/usage-dashboard.md): distinct
 * people, the hour map and the daily activity, for the platform admins. A stray `userId` in a
 * response must not reach the DOM, and a reader who is not a platform admin is sent away.
 */
import { it, expect, afterEach, vi } from 'vitest';
import { mount, unmount } from 'svelte';

const goto = vi.hoisted(() => vi.fn());
const roles = vi.hoisted(() => ({ global: true }));
const answer = vi.hoisted(() => ({ status: 200, body: {} as unknown }));

vi.mock('$app/navigation', () => ({ goto }));
vi.mock('$lib/stores/user', () => ({ isGlobalAdmin: () => roles.global }));
vi.mock('$lib/utils/apiUrl', () => ({ socialUrl: () => 'https://social.test' }));
vi.mock('$lib/utils/apiFetch', () => ({
  apiFetch: vi.fn(() =>
    Promise.resolve(new Response(JSON.stringify(answer.body), { status: answer.status }))
  ),
}));

import Page from './+page.svelte';
import { apiFetch } from '$lib/utils/apiFetch';
import {
  activityByMonth,
  calendarDays,
  headline,
  hourMapMax,
  peopleSeries,
  versionsOf,
  type UsageView,
} from '$lib/admin/usageDashboard';
import { Log } from '$lib/utils/Log';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.clearAllMocks();
  roles.global = true;
  answer.status = 200;
});

const activity = (messages: number) => ({
  messages,
  posts: 1,
  reels: 0,
  lives: 0,
  calls: 2,
  forms: 0,
});

function seed() {
  const cells = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  cells[0][9] = 4.5;
  answer.body = {
    timeZone: 'Europe/Paris',
    today: '2026-11-23',
    days: [
      {
        start: '2026-11-22',
        people: { all: 3, categories: { web_desktop: 2 }, versions: { '1.8.0': 3 } },
        activity: activity(10),
        userId: 'u-leak',
      },
      {
        start: '2026-11-23',
        people: { all: 5, categories: { app_android: 4, web_ios: 1 }, versions: { '1.8.0': 5 } },
        activity: activity(7),
      },
    ],
    weeks: [
      { start: '2026-11-16', people: { all: 20, categories: {}, versions: {} } },
      { start: '2026-11-23', people: { all: 5, categories: {}, versions: {} } },
    ],
    months: [
      { start: '2026-10-01', people: { all: 40, categories: {}, versions: {} } },
      {
        start: '2026-11-01',
        people: { all: 42, categories: {}, versions: { '1.8.0': 30, '1.7.3': 12 } },
      },
    ],
    hours: { from: '2026-10-26', to: '2026-11-22', cells },
  };
}

async function render() {
  const target = document.body.appendChild(document.createElement('div'));
  const instance = mount(Page, { target });
  mounted.push(() => unmount(instance));
  return target;
}

it('shows the distinct people of today, this week and this month, and asks social-service', async () => {
  seed();
  const target = await render();
  await vi.waitFor(() =>
    expect(target.querySelector('[data-testid="usage-people-today"]')?.textContent?.trim()).toBe(
      '5'
    )
  );
  expect(target.querySelector('[data-testid="usage-people-week"]')?.textContent?.trim()).toBe('5');
  expect(target.querySelector('[data-testid="usage-people-month"]')?.textContent?.trim()).toBe(
    '42'
  );
  expect(apiFetch).toHaveBeenCalledWith('https://social.test/api/admin/usage');
  expect(target.querySelectorAll('[data-testid="usage-day-bar"]')).toHaveLength(2);
  expect(target.querySelectorAll('[data-testid="usage-category"]')).toHaveLength(7);
  expect(target.querySelectorAll('[data-testid="usage-version"]')).toHaveLength(2);
  expect(target.querySelectorAll('[data-testid="usage-month"]')).toHaveLength(2);
  expect(target.querySelectorAll('[data-testid="usage-hour-map"] td')).toHaveLength(7 * 24);
});

it('never draws an identifier the server should not have sent', async () => {
  seed();
  const target = await render();
  await vi.waitFor(() =>
    expect(target.querySelector('[data-testid="usage-people-today"]')).not.toBeNull()
  );
  expect(target.innerHTML).not.toContain('u-leak');
});

it('says the figures could not be read, never a zero it was not told', async () => {
  answer.status = 503;
  answer.body = { error: 'usage_unavailable' };
  const warn = vi.spyOn(Log, 'w');
  const target = await render();
  await vi.waitFor(() =>
    expect(target.querySelector('[data-testid="usage-error"]')).not.toBeNull()
  );
  // A failed read accuses: a warn, not a debug line nobody reads.
  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining('admin.usage.load failed'),
    expect.anything()
  );
  warn.mockRestore();
  expect(target.querySelector('[data-testid="usage-people-today"]')).toBeNull();
});

it('sends a reader who is not a platform admin back to the admin home, asking nothing', async () => {
  roles.global = false;
  await render();
  await vi.waitFor(() => expect(goto).toHaveBeenCalled());
  expect(apiFetch).not.toHaveBeenCalled();
});

it('keeps a day with no figure as a gap in the chart, never squeezing it out', async () => {
  seed();
  const target = await render();
  await vi.waitFor(() =>
    expect(target.querySelectorAll('[data-testid="usage-day-bar"]')).toHaveLength(2)
  );
  // 30 calendar days end today: two have figures, the other 28 are gaps, not missing columns.
  expect(target.querySelectorAll('[data-testid="usage-day-gap"]')).toHaveLength(28);
  const days = calendarDays((answer.body as UsageView).days, '2026-11-23', 3);
  expect(days.map((d) => [d.start, d.period?.people.all])).toEqual([
    ['2026-11-21', undefined],
    ['2026-11-22', 3],
    ['2026-11-23', 5],
  ]);
  // Across the spring change of the hour, every calendar day once.
  expect(calendarDays([], '2026-03-30', 3).map((d) => d.start)).toEqual([
    '2026-03-28',
    '2026-03-29',
    '2026-03-30',
  ]);
});

it('marks a month partial when any of its own days up to today has no row', () => {
  seed();
  const months = activityByMonth((answer.body as UsageView).days, '2026-11-23');
  expect(months).toEqual([{ start: '2026-11-01', partial: true, activity: expect.any(Object) }]);
  const day = (start: string) => ({
    start,
    people: { all: 1, categories: {}, versions: {} },
    activity: activity(1),
  });
  const february = Array.from({ length: 28 }, (_, i) =>
    day(`2026-02-${String(i + 1).padStart(2, '0')}`)
  );
  const march = ['2026-03-01', '2026-03-02', '2026-03-04'].map(day);
  const partial = (list: ReturnType<typeof day>[], today: string) =>
    activityByMonth(list, today).map((mo) => [mo.start, mo.partial]);
  // February whole (28 days); March has its day 1 but a hole on the 3rd.
  expect(partial([...february, ...march], '2026-03-04')).toEqual([
    ['2026-02-01', false],
    ['2026-03-01', true],
  ]);
  // The current month is owed only the days up to today.
  expect(partial(march.slice(0, 2), '2026-03-02')).toEqual([['2026-03-01', false]]);
  // One day missing from a whole month is enough.
  expect(partial(february.slice(1), '2026-03-10')).toEqual([['2026-02-01', true]]);
});

it('sums a month of activity from its days, most people first for versions, the top of the map', () => {
  const days = [
    {
      start: '2026-10-31',
      people: { all: 1, categories: {}, versions: {} },
      activity: activity(3),
    },
    {
      start: '2026-11-01',
      people: { all: 1, categories: {}, versions: {} },
      activity: activity(4),
    },
    {
      start: '2026-11-02',
      people: { all: 1, categories: {}, versions: {} },
      activity: activity(5),
    },
  ];
  expect(activityByMonth(days, '2026-11-02')).toEqual([
    { start: '2026-10-01', partial: true, activity: activity(3) },
    { start: '2026-11-01', partial: false, activity: { ...activity(9), posts: 2, calls: 4 } },
  ]);
  expect(
    versionsOf({ start: 'x', people: { all: 3, categories: {}, versions: { a: 1, b: 2 } } })
  ).toEqual([
    { version: 'b', people: 2 },
    { version: 'a', people: 1 },
  ]);
  expect(versionsOf(undefined)).toEqual([]);
  expect(
    hourMapMax([
      [0, 2.5],
      [1, 0],
    ])
  ).toBe(2.5);
});

it('gives the order of magnitude of the day, the week and the month with the last complete period', async () => {
  seed();
  const target = await render();
  await vi.waitFor(() =>
    expect(target.querySelector('[data-testid="usage-previous-today"]')).not.toBeNull()
  );
  const text = (id: string) =>
    target.querySelector(`[data-testid="${id}"]`)?.textContent?.replace(/s+/g, ' ').trim();
  expect(text('usage-previous-today')).toContain('3');
  expect(text('usage-previous-week')).toContain('20');
  expect(text('usage-previous-month')).toContain('40');
  // The mean of the days that HAVE a row among the last 7: only 2026-11-22 (3 people).
  expect(text('usage-mean')).toContain('3');
  expect(headline(answer.body as UsageView)).toEqual({
    now: { day: 5, week: 5, month: 42 },
    previous: { day: 3, week: 20, month: 40 },
    mean: { 7: 3, 30: 3 },
  });
});

it('draws the earlier line charts on people per day, a line per device type and per version', async () => {
  seed();
  const target = await render();
  await vi.waitFor(() => expect(target.querySelectorAll('[role="slider"]')).toHaveLength(2));
  const paths = (axis: number, series: string) =>
    target
      .querySelectorAll('[role="slider"]')
      [axis].querySelectorAll(`path[data-series="${series}"]`);
  // Categories: web_desktop (day 22), app_android and web_ios (day 23), plus the dashed total.
  expect(paths(0, 'app_android').length).toBeGreaterThan(0);
  expect(paths(0, 'web_ios').length).toBeGreaterThan(0);
  expect(paths(0, 'total').length).toBeGreaterThan(0);
  expect(paths(0, 'app_desktop')).toHaveLength(0);
  expect(paths(1, '1.8.0').length).toBeGreaterThan(0);
});

it('keeps a gap as null in every line and widens the window with the range buttons', async () => {
  seed();
  const view = answer.body as UsageView;
  const days = calendarDays(view.days, view.today, 3);
  const byCategory = peopleSeries(days, 'category');
  expect(byCategory.total).toEqual([null, 3, 5]);
  expect(byCategory.series.find((s) => s.key === 'app_android')?.values).toEqual([null, 0, 4]);
  expect(byCategory.series.map((s) => s.key)).toEqual(['app_android', 'web_ios', 'web_desktop']);
  const target = await render();
  await vi.waitFor(() =>
    expect(target.querySelectorAll('[data-testid="usage-day-gap"]')).toHaveLength(28)
  );
  target.querySelector<HTMLElement>('[data-testid="usage-range-90"]')!.click();
  await vi.waitFor(() =>
    expect(target.querySelectorAll('[data-testid="usage-day-gap"]')).toHaveLength(88)
  );
});
