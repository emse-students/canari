// @vitest-environment happy-dom
/**
 * MOVING THE WEEK KEEPS THE PAGE WHERE IT IS (owner, 2026-10-31: an arrow sent the page back to
 * the top). The week is component state, no navigation; what moved the page was the grid being
 * swapped for the one-line "nothing this week" while the next week loaded, which collapsed the page
 * and clamped its scroll. Pinned: while the read is in flight the last grid stays drawn (inert),
 * the arrow keeps the focus, and the new week replaces it once read. A dimmed "Aujourd'hui" is
 * aria-disabled, not disabled: pressing it moves nothing and keeps the focus.
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

/** Whether every media query answers `phone`, and who listens for it to change. */
let phone = false;
const changeListeners = new Set<(e: { matches: boolean }) => void>();
/** Resize across the phone breakpoint while the view stays mounted. */
const setPhone = (next: boolean) => {
  phone = next;
  for (const listener of changeListeners) listener({ matches: next });
};

const settle = async () => {
  for (let i = 0; i < 5; i++) await tick();
  flushSync();
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  phone = false;
  changeListeners.clear();
  window.matchMedia = (() => ({
    get matches() {
      return phone;
    },
    addEventListener: (_type: string, listener: (e: { matches: boolean }) => void) =>
      changeListeners.add(listener),
    removeEventListener: (_type: string, listener: (e: { matches: boolean }) => void) =>
      changeListeners.delete(listener),
  })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('keeps the grid drawn and the arrow focused while the next week loads', async () => {
  let land: (slots: ResourceSlots[]) => void = () => {};
  api.getSlots
    .mockResolvedValueOnce(weekOf('2026-11-05'))
    .mockReturnValueOnce(new Promise<ResourceSlots[]>((resolve) => (land = resolve)));
  mount(SpaceWeek, { target: document.body, props: { space: SPACE, nowMs: NOW } });
  await settle();
  expect(document.querySelectorAll('[data-cell]')).toHaveLength(1);

  const next = document.querySelector<HTMLButtonElement>(
    `button[aria-label="${m.bookings_week_next()}"]`
  )!;
  next.focus();
  next.click();
  await settle();

  const grid = document.querySelector<HTMLElement>('[data-week-grid]')!;
  expect(document.querySelectorAll('[data-cell]')).toHaveLength(1);
  expect(document.body.textContent).not.toContain(m.bookings_week_empty());
  expect(grid.hasAttribute('inert')).toBe(true);
  expect(document.activeElement).toBe(next);

  land(weekOf('2026-11-12'));
  await settle();
  expect(grid.hasAttribute('inert')).toBe(false);
  const cell = document.querySelector('[data-cell]')!;
  expect(cell.getAttribute('aria-label')).toContain('12');
  expect(document.activeElement).toBe(next);
});

it('a dimmed "Aujourd\'hui" moves nothing and keeps the focus when pressed', async () => {
  api.getSlots.mockResolvedValue(weekOf('2026-11-05'));
  mount(SpaceWeek, { target: document.body, props: { space: SPACE, nowMs: NOW } });
  await settle();
  const today = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === m.bookings_week_today()
  )!;
  expect(today.getAttribute('aria-disabled')).toBe('true');
  const label = document.querySelector('h2')?.textContent;
  const reads = api.getSlots.mock.calls.length;

  today.focus();
  today.click();
  await settle();

  expect(document.activeElement).toBe(today);
  expect(document.querySelector('h2')?.textContent).toBe(label);
  expect(api.getSlots.mock.calls.length).toBe(reads);
});

it('a dimmed "Aujourd\'hui" does not jump back to today even when today is not the chosen day', async () => {
  // The phone's chosen day (Thursday) differs from today (Wednesday) while the desktop pill, which
  // is dimmed for the whole week holding today, is the one pressed: only the `away &&` guard
  // keeps that press from moving the chosen day.
  phone = true;
  api.getSlots.mockResolvedValue(weekOf('2026-11-05'));
  mount(SpaceWeek, { target: document.body, props: { space: SPACE, nowMs: NOW } });
  await settle();
  const thursday = () =>
    [...document.querySelectorAll('button[aria-pressed]')].find((b) =>
      b.getAttribute('aria-label')?.includes('5 novembre')
    ) as HTMLButtonElement;
  thursday().click();
  await settle();
  expect(thursday().getAttribute('aria-pressed')).toBe('true');

  setPhone(false);
  await settle();
  const today = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === m.bookings_week_today()
  )!;
  expect(today.getAttribute('aria-disabled')).toBe('true');
  today.click();
  await settle();

  setPhone(true);
  await settle();
  expect(thursday().getAttribute('aria-pressed')).toBe('true');
});
