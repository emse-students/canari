// @vitest-environment happy-dom
/**
 * THE WEEK ROLLS (owner, 2026-11-01): seven days from today, moved by sevens. Pinned here because
 * the old ISO-week code passed every other test: the read each move asks for, "Aujourd'hui", the
 * label, the phone strip keeping its weekday, and the grid's scroll (opened once on the first
 * useful hour, and kept across a week that unmounts the grid).
 */
import { it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick } from 'svelte';
import type { BookerSpace, ResourceSlots } from '$lib/bookings/api';
import { m } from '$lib/paraglide/messages';

const api = vi.hoisted(() => ({
  getSlots: vi.fn(),
  myBookings: vi.fn(async () => []),
}));
vi.mock('$lib/bookings/api', () => api);

import SpaceWeek from './SpaceWeek.svelte';

// Wednesday 2026-11-04, 08:00 in Paris.
const NOW = Date.parse('2026-11-04T07:00:00Z');
const SPACE = {
  id: 's1',
  name: 'Espace',
  timeZone: 'Europe/Paris',
  slotMode: 'step',
  stepMinutes: 60,
  maxSteps: 1,
  opensAt: null,
  minNoticeMinutes: null,
  horizonDays: null,
  canManage: false,
  poster: null,
  items: [],
  hiddenItemIds: [],
  resources: [{ id: 'r1', name: 'Salle' }],
} as unknown as BookerSpace;

/** One free 10:00 hour (Paris) on `date`. */
const weekOf = (date: string): ResourceSlots[] => {
  const startMs = Date.parse(`${date}T09:00:00Z`);
  return [
    { resourceId: 'r1', units: [{ date, startMs, endMs: startMs + 3_600_000, state: 'free' }] },
  ];
};
const EMPTY: ResourceSlots[] = [{ resourceId: 'r1', units: [] }];

let phone = false;
const settle = async () => {
  for (let i = 0; i < 5; i++) await tick();
  flushSync();
};
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label
  )!;
const lastRange = () => {
  const call = api.getSlots.mock.calls.at(-1)!;
  return [call[1], call[2]];
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  phone = false;
  window.matchMedia = (() => ({
    get matches() {
      return phone;
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  api.getSlots.mockReset();
});
afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function open(data: ResourceSlots[] = weekOf('2026-11-05')) {
  api.getSlots.mockResolvedValue(data);
  mount(SpaceWeek, { target: document.body, props: { space: SPACE, nowMs: NOW } });
  await settle();
}

it('starts on today, not on Monday: the first read runs from the day before today to today + 6', async () => {
  await open();
  expect(lastRange()).toEqual(['2026-11-03', '2026-11-10']);
  expect(document.querySelector('h2')?.textContent).toMatch(/4.+10.+2026/);
});

it('"suivante" moves by seven days, "Aujourd\'hui" comes back to today', async () => {
  await open();
  button(m.bookings_week_next()).click();
  await settle();
  expect(lastRange()).toEqual(['2026-11-10', '2026-11-17']);
  expect(document.querySelector('h2')?.textContent).toMatch(/11.+17.+2026/);
  expect(button(m.bookings_week_today()).getAttribute('aria-disabled')).toBe('false');

  button(m.bookings_week_today()).click();
  await settle();
  expect(lastRange()).toEqual(['2026-11-03', '2026-11-10']);
  expect(document.querySelector('h2')?.textContent).toMatch(/4.+10.+2026/);
  expect(button(m.bookings_week_today()).getAttribute('aria-disabled')).toBe('true');

  button(m.bookings_week_previous()).click();
  await settle();
  expect(lastRange()).toEqual(['2026-10-27', '2026-11-03']);
});

it('on a phone the chosen weekday survives a move, and "Aujourd\'hui" restores today as the first day', async () => {
  phone = true;
  await open();
  const day = (needle: string) =>
    [...document.querySelectorAll('button[aria-pressed]')].find((b) =>
      b.getAttribute('aria-label')?.includes(needle)
    ) as HTMLButtonElement | undefined;
  day('6 novembre')!.click();
  await settle();
  button(m.bookings_week_next()).click();
  await settle();
  expect(day('13 novembre')!.getAttribute('aria-pressed')).toBe('true');

  button(m.bookings_week_today()).click();
  await settle();
  expect(day('4 novembre')!.getAttribute('aria-pressed')).toBe('true');
  // The strip starts on today again: nothing before it is drawn.
  expect(day('3 novembre')).toBeUndefined();
  expect(lastRange()).toEqual(['2026-11-03', '2026-11-10']);
});

const scrollBox = () => document.querySelector<HTMLElement>('[data-swipe-nav-ignore]')!;

it('opens the grid on the hour of the first free unit, once', async () => {
  await open(weekOf('2026-11-05')); // 10:00 Paris: 10 h x 3 rem = 30 rem, minus half a rem
  expect(scrollBox().scrollTop).toBe(29.5 * 16);
});

it("keeps the reader's scroll through a week with nothing offered, which unmounts the grid", async () => {
  await open();
  const box = scrollBox();
  box.scrollTop = 200;
  box.dispatchEvent(new Event('scroll'));
  await settle();

  api.getSlots.mockResolvedValue(EMPTY);
  button(m.bookings_week_next()).click();
  await settle();
  expect(document.querySelector('[data-swipe-nav-ignore]')).toBeNull();
  expect(document.body.textContent).toContain(m.bookings_week_empty());

  api.getSlots.mockResolvedValue(weekOf('2026-11-19'));
  button(m.bookings_week_next()).click();
  await settle();
  expect(scrollBox().scrollTop).toBe(200);
});
