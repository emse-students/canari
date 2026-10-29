// @vitest-environment happy-dom
/**
 * THE ORGANISER'S WORD ON A CANCEL (Q-R3, WP-N): once the notices are live, the in-place cancel
 * offers an optional message, says who is told, and sends the trimmed word - never a blank one.
 * The switch is mocked ON here; `UpcomingBookings.svelte.test.ts` covers it off.
 */
import { it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { BookerSpace, OrganiserBooking } from '$lib/bookings/api';
import { m } from '$lib/paraglide/messages';

const api = vi.hoisted(() => ({
  upcomingSpaceBookings: vi.fn(),
  cancelBooking: vi.fn(async () => ({ ok: true })),
}));
vi.mock('$lib/bookings/api', () => api);
vi.mock('$lib/stores/toast.svelte', () => ({ showToast: vi.fn() }));
vi.mock('$lib/bookings/notified', () => ({ BOOKING_NOTIFICATIONS_LIVE: true }));

import UpcomingBookings from './UpcomingBookings.svelte';

const NOW = Date.parse('2026-11-02T10:15:00Z');
const SPACE = {
  id: 's1',
  name: 'Salle',
  timeZone: 'UTC',
  resources: [{ id: 'r1', name: 'Salle' }],
} as unknown as BookerSpace;

const ROW = {
  id: 'b',
  resourceId: 'r1',
  startsAt: '2026-11-02T13:00:00Z',
  endsAt: '2026-11-02T13:30:00Z',
  cancelled: false,
  mine: false,
  holderName: 'Alice',
  participantNames: [],
  bookedOnBehalf: false,
  cancelledByHolder: false,
} as unknown as OrganiserBooking;

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

const buttons = (label: string) =>
  [...document.querySelectorAll('button')].filter((b) => b.textContent?.includes(label));

async function openConfirm() {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  api.upcomingSpaceBookings
    .mockResolvedValueOnce({ items: [ROW], nextOffset: null })
    .mockResolvedValueOnce({ items: [], nextOffset: null });
  const app = mount(UpcomingBookings, {
    target: document.body,
    props: { space: SPACE, nowMs: NOW, onChanged: vi.fn() },
  });
  mounted.push(() => unmount(app, { outro: false }));
  await vi.waitFor(() => expect(document.querySelectorAll('li').length).toBeGreaterThan(0));
  buttons(m.bookings_upcoming_cancel())[0].click();
  flushSync();
}

function type(text: string) {
  const area = document.querySelector('textarea')!;
  area.value = text;
  area.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

it('says the holder is told, and sends the trimmed word', async () => {
  await openConfirm();
  expect(document.body.textContent).toContain(
    m.bookings_upcoming_cancel_notified({ name: 'Alice' })
  );
  expect(document.body.textContent).not.toContain(m.bookings_cancel_confirm_organiser());
  type('  Salle fermee  ');
  buttons(m.bookings_cancel_action())[0].click();
  await vi.waitFor(() => expect(api.cancelBooking).toHaveBeenCalledWith('b', 'Salle fermee'));
});

it('a blank word is no message at all', async () => {
  await openConfirm();
  type('   ');
  buttons(m.bookings_cancel_action())[0].click();
  await vi.waitFor(() => expect(api.cancelBooking).toHaveBeenCalledWith('b', undefined));
});
