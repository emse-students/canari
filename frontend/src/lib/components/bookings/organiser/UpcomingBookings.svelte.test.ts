// @vitest-environment happy-dom
/**
 * THE DASHBOARD'S "COMING" LIST (WP-R5, D50): read from now (`from`), the one under way marked and
 * offered no cancel, a cancel in place that re-reads the list and the week beside it, and "show
 * more" continuing the SAME list without listing a booking twice.
 */
import { it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import type { BookerSpace, OrganiserBooking } from '$lib/bookings/api';
import { m } from '$lib/paraglide/messages';

const api = vi.hoisted(() => ({ upcomingSpaceBookings: vi.fn() }));
const actions = vi.hoisted(() => ({ cancelWithConfirm: vi.fn(async () => true) }));
vi.mock('$lib/bookings/api', () => api);
vi.mock('$lib/bookings/bookingActions', () => actions);

import UpcomingBookings from './UpcomingBookings.svelte';

const NOW = Date.parse('2026-11-02T10:15:00Z');
const SPACE = {
  id: 's1',
  name: 'Salle',
  timeZone: 'UTC',
  resources: [{ id: 'r1', name: 'Salle' }],
} as unknown as BookerSpace;

const row = (id: string, start: string, end: string, extra: Partial<OrganiserBooking> = {}) =>
  ({
    id,
    resourceId: 'r1',
    startsAt: start,
    endsAt: end,
    cancelled: false,
    mine: false,
    holderName: `Holder ${id}`,
    participantNames: [],
    bookedOnBehalf: false,
    cancelledByHolder: false,
    ...extra,
  }) as OrganiserBooking;

const mounted: (() => void)[] = [];
const onChanged = vi.fn();

beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  onChanged.mockReset();
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

async function open() {
  const app = mount(UpcomingBookings, {
    target: document.body,
    props: { space: SPACE, nowMs: NOW, onChanged },
  });
  mounted.push(() => unmount(app, { outro: false }));
  await vi.waitFor(() => expect(document.querySelectorAll('li').length).toBeGreaterThan(0));
}

const buttons = (label: string) =>
  [...document.querySelectorAll('button')].filter((b) => b.textContent?.includes(label));

it('reads from now, marks the one under way and offers it no cancel', async () => {
  api.upcomingSpaceBookings.mockResolvedValueOnce({
    items: [
      row('a', '2026-11-02T10:00:00Z', '2026-11-02T11:00:00Z'),
      row('b', '2026-11-02T13:00:00Z', '2026-11-02T13:30:00Z', { participantNames: ['Bob'] }),
    ],
    nextOffset: null,
  });
  await open();
  expect(api.upcomingSpaceBookings).toHaveBeenCalledWith('s1', expect.any(Number), 0, 50);
  const items = [...document.querySelectorAll('li')];
  expect(items[0].textContent).toContain(m.bookings_upcoming_under_way());
  expect(items[0].querySelector('button')).toBeNull();
  expect(items[1].textContent).toContain(m.bookings_upcoming_people({ names: 'Bob' }));
  expect(buttons(m.bookings_upcoming_cancel())).toHaveLength(1);
});

it('a cancel in place re-reads the list and tells the page', async () => {
  api.upcomingSpaceBookings
    .mockResolvedValueOnce({
      items: [row('b', '2026-11-02T13:00:00Z', '2026-11-02T13:30:00Z')],
      nextOffset: null,
    })
    .mockResolvedValueOnce({ items: [], nextOffset: null });
  await open();
  buttons(m.bookings_upcoming_cancel())[0].click();
  await vi.waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
  expect(actions.cancelWithConfirm).toHaveBeenCalledWith('b', true);
  expect(api.upcomingSpaceBookings).toHaveBeenCalledTimes(2);
  await tick();
  expect(document.body.textContent).toContain(m.bookings_upcoming_empty());
});

it('"show more" continues the same list from the same instant, never twice the same row', async () => {
  api.upcomingSpaceBookings
    .mockResolvedValueOnce({
      items: [row('b', '2026-11-02T13:00:00Z', '2026-11-02T13:30:00Z')],
      nextOffset: 50,
    })
    .mockResolvedValueOnce({
      items: [
        row('b', '2026-11-02T13:00:00Z', '2026-11-02T13:30:00Z'),
        row('c', '2026-11-02T14:00:00Z', '2026-11-02T14:30:00Z'),
      ],
      nextOffset: null,
    });
  await open();
  const from = api.upcomingSpaceBookings.mock.calls[0][1];
  buttons(m.bookings_upcoming_more())[0].click();
  flushSync();
  await vi.waitFor(() => expect(document.querySelectorAll('li')).toHaveLength(2));
  expect(api.upcomingSpaceBookings).toHaveBeenLastCalledWith('s1', from, 50, 50);
  expect(buttons(m.bookings_upcoming_more())).toHaveLength(0);
});
