// @vitest-environment happy-dom
/**
 * THE "AUJOURD'HUI" PILL, PER CONTROL. The desktop bar goes back to the week that holds today, so
 * it is dimmed while that week is shown; the phone strip goes back to the DAY, so it is dimmed only
 * while today itself is the chosen day - on a week that holds today with another day selected it
 * is live. Each rule is pinned on the real `SpaceWeek`, in both the enabled and the disabled state.
 */
import { it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick } from 'svelte';
import type { BookerSpace } from '$lib/bookings/api';
import { m } from '$lib/paraglide/messages';

const api = vi.hoisted(() => ({
  getSlots: vi.fn(async () => []),
  myBookings: vi.fn(async () => []),
}));
vi.mock('$lib/bookings/api', () => api);

import SpaceWeek from './SpaceWeek.svelte';

const NOW = Date.parse('2026-11-04T10:00:00Z');
const SPACE = {
  id: 's1',
  name: 'Espace',
  timeZone: 'Europe/Paris',
  slotMode: 'step',
  stepMinutes: 30,
  maxSteps: 4,
  opensAt: null,
  minNoticeMinutes: null,
  horizonDays: null,
  canManage: false,
  poster: null,
  items: [],
  hiddenItemIds: [],
  resources: [{ id: 'r1', name: 'Salle' }],
} as unknown as BookerSpace;

const mounted: (() => void)[] = [];

/** Every media query answers `phone`: the strip when true, the desktop week when false. */
function viewport(phone: boolean) {
  window.matchMedia = (() => ({
    matches: phone,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

async function open() {
  const app = mount(SpaceWeek, { target: document.body, props: { space: SPACE, nowMs: NOW } });
  mounted.push(() => void app);
  for (let i = 0; i < 5; i++) await tick();
  flushSync();
}

const today = () =>
  [...document.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === m.bookings_week_today()
  ) as HTMLButtonElement;
const click = async (el: Element) => {
  (el as HTMLElement).click();
  for (let i = 0; i < 5; i++) await tick();
  flushSync();
};

beforeEach(() => {
  // The component re-reads the device clock after each read: the clock itself must be fixed.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('phone: dimmed while today is the chosen day, live as soon as another day is', async () => {
  viewport(true);
  await open();
  expect(today().disabled).toBe(true);
  const thursday = [...document.querySelectorAll('button[aria-pressed]')].find((b) =>
    b.getAttribute('aria-label')?.includes('5 novembre')
  )!;
  await click(thursday);
  expect(today().disabled).toBe(false);
  await click(today());
  expect(today().disabled).toBe(true);
});

it('desktop: dimmed while the week holds today, live on another week', async () => {
  viewport(false);
  await open();
  expect(today().disabled).toBe(true);
  await click(document.querySelector(`button[aria-label="${m.bookings_week_next()}"]`)!);
  expect(today().disabled).toBe(false);
  await click(today());
  expect(today().disabled).toBe(true);
});
