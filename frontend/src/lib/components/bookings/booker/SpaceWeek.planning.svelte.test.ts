// @vitest-environment happy-dom
/**
 * THE PHONE'S PLANNING (owner, 2026-11-01: "vue planning, un + et on rentre les infos"): below `md`
 * the week is a list of rows, not a grid; a free row opens the range form prefilled, the "+" opens
 * it blank, its choices come from the free runs, and its answer opens the SAME booking sheet the
 * grid opens (the organiser's: the block sheet). From `md` up the grid stays.
 */
import { it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import type { BookerSpace, ResourceSlots } from '$lib/bookings/api';
import { m } from '$lib/paraglide/messages';

const api = vi.hoisted(() => ({
  getSlots: vi.fn(),
  myBookings: vi.fn(async () => []),
  book: vi.fn(),
  addBlock: vi.fn(),
  BookingsApiError: class extends Error {
    bookingIds: string[] = [];
  },
}));
vi.mock('$lib/bookings/api', () => api);

import SpaceWeek from './SpaceWeek.svelte';

// Wednesday 2026-11-04 08:00 Paris.
const NOW = Date.parse('2026-11-04T07:00:00Z');
const SPACE = {
  id: 's1',
  name: 'Espace',
  timeZone: 'Europe/Paris',
  slotMode: 'step',
  stepMinutes: 60,
  maxSteps: 3,
  opensAt: null,
  minNoticeMinutes: null,
  horizonDays: null,
  canManage: false,
  poster: null,
  items: [],
  hiddenItemIds: [],
  participantWithdrawMinMinutes: 0,
  maxPeople: null,
  retentionDays: 7,
  reminderMinutes: null,
  nameVisibility: 'all',
  resources: [{ id: 'r1', name: 'Salle' }],
} as unknown as BookerSpace;

const H = 3_600_000;
const at10 = Date.parse('2026-11-05T09:00:00Z'); // 10:00 Paris, Thursday
/** Free 10:00-13:00, a booking 13:00-14:00 by Camille Test, free 14:00-15:00. */
const WEEK = [
  {
    resourceId: 'r1',
    units: [
      ...[0, 1, 2].map((i) => ({
        date: '2026-11-05',
        startMs: at10 + i * H,
        endMs: at10 + (i + 1) * H,
        state: 'free' as const,
      })),
      {
        date: '2026-11-05',
        startMs: at10 + 3 * H,
        endMs: at10 + 4 * H,
        state: 'booked' as const,
        booking: { id: 'b1', holderName: 'Camille Test', mine: false },
      },
      {
        date: '2026-11-05',
        startMs: at10 + 4 * H,
        endMs: at10 + 5 * H,
        state: 'free' as const,
      },
    ],
  },
] as unknown as ResourceSlots[];

let phone = true;
const settle = async () => {
  for (let i = 0; i < 6; i++) await tick();
  flushSync();
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  phone = true;
  window.matchMedia = (() => ({
    get matches() {
      return phone;
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  api.getSlots.mockReset();
  api.getSlots.mockResolvedValue(WEEK);
});
afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function open(props: Record<string, unknown> = {}) {
  const app = mount(SpaceWeek, {
    target: document.body,
    props: { space: SPACE, nowMs: NOW, ...props },
  });
  await settle();
  return app;
}
const rows = (kind: string) => [
  ...document.querySelectorAll<HTMLButtonElement>(`[data-row="${kind}"]`),
];
const dialog = () => document.querySelector('[role="dialog"]');

it('draws a list of rows on a phone, no grid, and the grid from md up', async () => {
  const first = await open();
  expect(document.querySelector('[data-planning]')).not.toBeNull();
  expect(document.querySelector('[data-cell]')).toBeNull();
  expect(rows('free')).toHaveLength(2);
  expect(rows('booked')).toHaveLength(1);
  // The taken row says who and when, even on the narrowest phone.
  expect(rows('booked')[0].textContent).toContain('Camille Test');
  expect(rows('booked')[0].textContent).toContain('13:00 - 14:00');

  unmount(first);
  document.body.innerHTML = '';
  phone = false;
  await open();
  expect(document.querySelector('[data-planning]')).toBeNull();
  expect(document.querySelectorAll('[data-cell]').length).toBeGreaterThan(0);
});

it('a free row opens the range form prefilled with its stretch', async () => {
  await open();
  rows('free')[0].click(); // 10:00-13:00
  await settle();
  expect(dialog()).not.toBeNull();
  expect(document.body.textContent).toContain(m.bookings_range_title());
  // Prefilled: the start is 10:00 and the end is 13:00 (the three steps one booking may cover).
  const text = dialog()!.textContent!;
  expect(text).toContain('10:00');
  expect(text).toContain('13:00');
});

it('"+" opens the form blank, and "Continuer" hands the range to the booking sheet', async () => {
  await open();
  document
    .querySelector<HTMLButtonElement>(`button[aria-label="${m.bookings_planning_add()}"]`)!
    .click();
  await settle();
  expect(document.body.textContent).toContain(m.bookings_range_title());
  const go = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === m.bookings_range_continue()
  )!;
  expect(go.disabled).toBe(false);
  go.click();
  await settle();
  // The form is replaced by the same sheet a grid tap opens.
  expect(document.body.textContent).not.toContain(m.bookings_range_continue());
  expect(document.body.textContent).toContain(m.bookings_sheet_title());
});

it('says plainly that nothing is free when no day has a free unit', async () => {
  api.getSlots.mockResolvedValue([
    { resourceId: 'r1', units: [WEEK[0].units[3]] }, // only the booking
  ]);
  await open();
  document
    .querySelector<HTMLButtonElement>(`button[aria-label="${m.bookings_planning_add()}"]`)!
    .click();
  await settle();
  expect(document.body.textContent).toContain(m.bookings_range_none());
  const go = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === m.bookings_range_continue()
  )!;
  expect(go.disabled).toBe(true);
});

it('the organiser gets the same "+", opening the block sheet', async () => {
  await open({ mode: 'block' });
  document
    .querySelector<HTMLButtonElement>(`button[aria-label="${m.bookings_planning_add_block()}"]`)!
    .click();
  await settle();
  expect(document.body.textContent).toContain(m.bookings_range_title_block());
  [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((b) => b.textContent?.trim() === m.bookings_range_continue())!
    .click();
  await settle();
  expect(document.body.textContent).toContain(m.bookings_block_title());
});

it('block mode: the "+" offers no unit that has begun (the server freezes history)', async () => {
  // NOW is 08:00 Paris on Wednesday; make a unit span that moment: 07:00-08:00 and 08:00-09:00 free.
  const t = Date.parse('2026-11-04T06:00:00Z');
  api.getSlots.mockResolvedValue([
    {
      resourceId: 'r1',
      units: [0, 1, 2].map((i) => ({
        date: '2026-11-04',
        startMs: t + i * H,
        endMs: t + (i + 1) * H,
        state: 'free' as const,
      })),
    },
  ]);
  await open({ mode: 'block' });
  document
    .querySelector<HTMLButtonElement>(`button[aria-label="${m.bookings_planning_add_block()}"]`)!
    .click();
  await settle();
  const text = dialog()!.textContent!;
  // 07:00-08:00 is over and 08:00-09:00 has begun: only 09:00 may start a block.
  expect(text).toContain('09:00');
  expect(text).not.toContain('07:00');
  expect(text).not.toContain('08:00 -');
});

it('a prefill follows the stretch after a column change, else falls back to the first choice', async () => {
  const two = [
    WEEK[0],
    {
      resourceId: 'r2',
      units: [
        {
          date: '2026-11-06',
          startMs: at10 + 24 * H,
          endMs: at10 + 25 * H,
          state: 'free' as const,
        },
      ],
    },
  ] as unknown as ResourceSlots[];
  api.getSlots.mockResolvedValue(two);
  const space = {
    ...SPACE,
    resources: [
      { id: 'r1', name: 'Salle' },
      { id: 'r2', name: 'Bureau' },
    ],
  };
  await open({ space });
  rows('free')[0].click();
  await settle();
  expect(dialog()!.textContent).toContain('10:00');
});
