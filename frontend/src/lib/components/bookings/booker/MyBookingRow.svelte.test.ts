// @vitest-environment happy-dom
/**
 * A BOOKING ROW OF THE RESERVATIONS HOME: it carries nothing destructive; tapping it opens the
 * booking's detail in a modal, where a cancel closes the modal and tells the list, and closing the
 * modal any other way re-reads the list too (a reminder changed inside shows on the row's chip).
 */
import { it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import type { MyBooking } from '$lib/bookings/api';
import { m } from '$lib/paraglide/messages';

const actions = vi.hoisted(() => ({
  cancelWithConfirm: vi.fn(async () => true),
  withdrawWithConfirm: vi.fn(async () => true),
  bookingCalendarEvent: vi.fn(() => ({})),
  bookingIcsUrl: vi.fn(async () => ''),
}));
vi.mock('$lib/bookings/bookingActions', () => actions);
vi.mock('$lib/bookings/api', () => ({ setBookingReminder: vi.fn(async () => ({})) }));
vi.mock('$app/paths', () => ({ resolve: (p: string) => p }));
vi.mock('$lib/components/calendar/AddEventToCalendarButton.svelte', () => ({
  default: () => {},
}));

import MyBookingRow from './MyBookingRow.svelte';

const NOW = Date.parse('2026-11-02T10:00:00Z');
const BOOKING = {
  id: 'b1',
  resourceId: 'r1',
  startsAt: '2026-11-02T16:00:00Z',
  endsAt: '2026-11-02T17:00:00Z',
  cancelled: false,
  withdrawn: false,
  mine: true,
  holder: true,
  linked: false,
  space: { id: 's1', name: 'Salle de musique', timeZone: 'Europe/Paris' },
  resource: { id: 'r1', name: 'Salle de musique' },
  privateInfo: null,
  reminderMinutes: 60,
  participantNames: ['Lea M.'],
} as unknown as MyBooking;

const mounted: (() => void)[] = [];
const onChanged = vi.fn();

function open() {
  const app = mount(MyBookingRow, {
    target: document.body,
    props: { booking: BOOKING, nowMs: NOW, onChanged },
  });
  mounted.push(() => unmount(app, { outro: false }));
  flushSync();
}
const settle = async () => {
  for (let i = 0; i < 5; i++) await tick();
  flushSync();
};
const row = () => document.querySelector('button') as HTMLButtonElement;
const dialog = () => document.querySelector('[role="dialog"]');

beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  onChanged.mockClear();
  actions.cancelWithConfirm.mockClear();
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

it('reads when, where and who on the row, and names the reminder for a screen reader', () => {
  open();
  const text = row().textContent!;
  expect(text).toContain('17:00 - 18:00');
  expect(text).toContain('avec Lea M.');
  expect(text).toContain(`${m.bookings_row_reminder()}`);
  expect(text).toContain('16:00');
  expect(row().textContent).not.toContain(m.bookings_cancel_action());
});

it('opens the detail in a modal, where cancel lives, and a cancel closes it and tells the list', async () => {
  open();
  expect(dialog()).toBeNull();
  row().click();
  await settle();
  expect(dialog()).not.toBeNull();
  const cancel = [...document.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(m.bookings_cancel_action())
  )!;
  cancel.click();
  await settle();
  expect(actions.cancelWithConfirm).toHaveBeenCalledWith('b1', false);
  expect(onChanged).toHaveBeenCalledTimes(1);
  expect(dialog()).toBeNull();
});

it('re-reads the list when the modal is closed without a cancel', async () => {
  open();
  row().click();
  await settle();
  const close = document.querySelector('[role="dialog"] button[aria-label]') as HTMLButtonElement;
  close.click();
  await settle();
  expect(dialog()).toBeNull();
  expect(onChanged).toHaveBeenCalledTimes(1);
});
