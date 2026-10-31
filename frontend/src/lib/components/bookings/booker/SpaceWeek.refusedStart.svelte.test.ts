// @vitest-environment happy-dom
/**
 * A REFUSED START RETIRES EVERY START BEFORE IT. The server refuses a start as `started` or `notice`
 * when the device's clock is behind its own; both refusals only grow with time, so the one refused
 * start and every earlier one are unbookable. The view keeps ONLY the latest refused start: with a
 * slow clock the booker meets one refusal, not one per unit. Pinned on the real `SpaceWeek`, booking
 * the LAST of three free units through the real sheet with a server that refuses it as too near.
 */
import { it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import type { BookerSpace, ResourceSlots } from '$lib/bookings/api';
import { m } from '$lib/paraglide/messages';

const api = vi.hoisted(() => ({
  getSlots: vi.fn(),
  myBookings: vi.fn(async () => []),
  book: vi.fn(),
}));
vi.mock('$lib/bookings/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/bookings/api')>()),
  ...api,
}));
vi.mock('$lib/stores/toast.svelte', () => ({ showToast: vi.fn() }));

import { BookingsApiError } from '$lib/bookings/api';
import SpaceWeek from './SpaceWeek.svelte';

const NOW = Date.parse('2026-11-04T07:00:00Z');
const HOUR = 3_600_000;
const FIRST = Date.parse('2026-11-04T09:00:00Z');
const SPACE = {
  id: 's1',
  name: 'Espace',
  timeZone: 'Europe/Paris',
  associationId: 'asso',
  slotMode: 'step',
  stepMinutes: 60,
  maxSteps: 1,
  maxPeople: 1,
  opensAt: null,
  minNoticeMinutes: null,
  horizonDays: null,
  canManage: false,
  reminderMinutes: 60,
  retentionDays: 7,
  poster: null,
  items: [],
  hiddenItemIds: [],
  resources: [{ id: 'r1', name: 'Salle' }],
} as unknown as BookerSpace;

/** Three consecutive free hours on the 4th, 10:00 to 13:00 Paris. */
const day = (): ResourceSlots[] => [
  {
    resourceId: 'r1',
    units: [0, 1, 2].map((i) => ({
      date: '2026-11-04',
      startMs: FIRST + i * HOUR,
      endMs: FIRST + (i + 1) * HOUR,
      state: 'free' as const,
    })),
  },
];

const mounted: ReturnType<typeof mount>[] = [];
const settle = async () => {
  for (let i = 0; i < 5; i++) await tick();
  flushSync();
};
const cells = () => [...document.querySelectorAll<HTMLButtonElement>('[data-cell]')];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  window.matchMedia = (() => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  api.getSlots.mockResolvedValue(day());
  api.book.mockRejectedValue(new BookingsApiError('dev text', 'notice', 409, []));
});
afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!, { outro: false });
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('offers none of the units up to the one refused, after ONE refusal', async () => {
  mounted.push(mount(SpaceWeek, { target: document.body, props: { space: SPACE, nowMs: NOW } }));
  await settle();
  expect(cells()).toHaveLength(3);
  expect(cells().map((c) => c.disabled)).toEqual([false, false, false]);

  // Book the LAST unit: the server refuses it, so the two before it are over as well.
  cells()[2].click();
  await settle();
  const submit = [...document.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === m.bookings_sheet_submit()
  )!;
  submit.click();
  await settle();

  expect(api.book).toHaveBeenCalledOnce();
  expect(cells().map((c) => c.disabled)).toEqual([true, true, true]);
});
