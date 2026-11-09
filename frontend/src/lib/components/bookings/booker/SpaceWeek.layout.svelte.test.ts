// @vitest-environment happy-dom
/**
 * THE PAGE'S ONE COLUMN IS NEVER SIZED BY ITS CONTENT (owner, 2026-11-08): happy-dom has no layout,
 * so what is pinned is the cause - the booker's grid names its phone track `minmax(0,1fr)` and its
 * aside may shrink, so no `truncate` line can widen the week past the viewport - (the end-of-day
 * label is pinned in `grid.test.ts`). Measured in Chrome at 390 px: scrollWidth 519 before, 390 after.
 */
import { it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick } from 'svelte';
import type { BookerSpace } from '$lib/bookings/api';

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

it('phone: the grid track and the aside cannot grow with their content', async () => {
  viewport(true);
  await open();
  const layout = document.querySelector('[data-week-layout]') as HTMLElement;
  expect(layout.className).toContain('grid-cols-[minmax(0,1fr)]');
  expect(layout.className).not.toMatch(/(^|\s)grid-cols-\[auto/);
  expect(layout.querySelector('aside')?.className).toContain('min-w-0');
});
