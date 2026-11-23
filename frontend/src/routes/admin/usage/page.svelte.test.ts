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
import { activityByMonth, hourMapMax, versionsOf } from '$lib/admin/usageDashboard';

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
    weeks: [{ start: '2026-11-23', people: { all: 5, categories: {}, versions: {} } }],
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
  const target = await render();
  await vi.waitFor(() =>
    expect(target.querySelector('[data-testid="usage-error"]')).not.toBeNull()
  );
  expect(target.querySelector('[data-testid="usage-people-today"]')).toBeNull();
});

it('sends a reader who is not a platform admin back to the admin home, asking nothing', async () => {
  roles.global = false;
  await render();
  await vi.waitFor(() => expect(goto).toHaveBeenCalled());
  expect(apiFetch).not.toHaveBeenCalled();
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
  expect(activityByMonth(days)).toEqual([
    { start: '2026-10-01', activity: activity(3) },
    { start: '2026-11-01', activity: { ...activity(9), posts: 2, calls: 4 } },
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
