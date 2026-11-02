// @vitest-environment happy-dom
/**
 * THE BOOKING SHEET IN EDIT MODE (owner, 2026-11-02, "Modifier la reservation"). Pinned: it opens
 * pre-filled - the booking's own length on the "Jusqu'a" stepper, its other people as chips - and
 * shows nothing an edit cannot change (no "on behalf", no reminder, no questions); it sends ONE
 * `PATCH` with the new range and the WHOLE set of people; a refusal reads its family and its rule
 * and says the booking has not changed; a conflict closes the sheet on a stale grid.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';

const book = vi.hoisted(() => vi.fn());
const editBooking = vi.hoisted(() => vi.fn());
const showToast = vi.hoisted(() => vi.fn());

vi.mock('$lib/bookings/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/bookings/api')>()),
  book: (...a: unknown[]) => book(...a),
  editBooking: (...a: unknown[]) => editBooking(...a),
}));
vi.mock('$lib/stores/toast.svelte', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));

import { setLocale } from '$lib/paraglide/runtime';
import { m } from '$lib/paraglide/messages';
import {
  BookingsApiError,
  type BookerResource,
  type BookerSpace,
  type BookingView,
  type SlotUnit,
} from '$lib/bookings/api';
import { editChoices } from '$lib/bookings/editRange';
import BookingSheet from './BookingSheet.svelte';

const DAY = '2026-11-02';
const START = Date.parse(`${DAY}T09:00:00Z`);
const HALF = 30 * 60_000;
const at = (i: number) => START + i * HALF;
const iso = (i: number) => new Date(at(i)).toISOString();

const own: BookingView = {
  id: 'b-1',
  resourceId: 'r1',
  startsAt: iso(0),
  endsAt: iso(2),
  cancelled: false,
  mine: true,
};
/** Four units from 09:00: the booking holds the first two, the rest are free. */
const units: SlotUnit[] = [0, 1, 2, 3].map(
  (i) =>
    ({
      date: DAY,
      startMs: at(i),
      endMs: at(i + 1),
      ...(i < 2 ? { state: 'booked', booking: own } : { state: 'free' }),
    }) as SlotUnit
);
const resource = { id: 'r1', name: 'Salle' } as BookerResource;
const space = {
  id: 'space-1',
  name: 'Salle',
  timeZone: 'UTC',
  associationId: 'asso',
  slotMode: 'step',
  maxSteps: 4,
  opensAt: null,
  minNoticeMinutes: null,
  horizonDays: null,
  items: [{ id: 'q1', type: 'text', label: 'Question', required: true }],
  hiddenItemIds: [],
  maxPeople: null,
  canManage: true,
  reminderMinutes: 60,
  retentionDays: 7,
} as unknown as BookerSpace;

const mounted: ReturnType<typeof mount>[] = [];

function render() {
  const onClose = vi.fn();
  const onStale = vi.fn(() => Promise.resolve());
  const choices = editChoices(units, own, space, Date.parse('2026-11-01T12:00:00Z'), null)!;
  mounted.push(
    mount(BookingSheet, {
      target: document.body,
      props: {
        space,
        resource,
        run: choices.runOf(choices.starts[choices.startIndex]),
        editing: {
          bookingId: own.id,
          choices,
          participants: [{ id: 'bob', displayName: 'Bob' }],
          revision: 'rev-1',
          onStale,
        },
        onReread: vi.fn(() => Promise.resolve()),
        onClose,
      },
    })
  );
  flushSync();
  return { onClose, onStale };
}

const button = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const status = () => document.querySelector('[role="status"]')?.textContent?.trim();
const save = () =>
  [...document.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === m.bookings_edit_submit()
  )!;
const alertText = () => document.querySelector('[role="alert"]')?.textContent?.trim();

beforeEach(() => {
  setLocale('en', { reload: false });
  book.mockReset();
  editBooking.mockReset();
  editBooking.mockResolvedValue({ ok: true, changed: true });
  showToast.mockReset();
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});
afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!, { outro: false });
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('BookingSheet in edit mode', () => {
  it('opens on the booking: its length, its people, and nothing an edit cannot change', () => {
    render();
    expect(document.body.textContent).toContain(m.bookings_edit_title());
    expect(status()).toBe('09:00 - 10:00');
    expect(document.body.textContent).toContain('Bob');
    expect(document.querySelectorAll('input[name="booking-reminder"]')).toHaveLength(0);
    expect(document.body.textContent).not.toContain(m.bookings_sheet_on_behalf_label());
    expect(document.body.textContent).not.toContain('Question');
    expect(document.body.textContent).toContain(m.bookings_edit_note());
  });

  it('sends one PATCH: the new range and the whole set of people, never a booking', async () => {
    const { onClose } = render();
    button(m.bookings_sheet_length_more()).click();
    flushSync();
    expect(status()).toBe('09:00 - 10:30');
    button(m.bookings_sheet_person_remove({ name: 'Bob' })).click();
    flushSync();
    save().click();
    await tick();
    await Promise.resolve();
    expect(book).not.toHaveBeenCalled();
    expect(editBooking).toHaveBeenCalledWith('b-1', {
      startsAt: iso(0),
      endsAt: iso(3),
      participantIds: [],
      revision: 'rev-1',
    });
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
    expect(showToast).toHaveBeenCalledWith(m.bookings_edit_done(), 'info');
  });

  it('a request that changes nothing says so and leaves the grid alone', async () => {
    editBooking.mockResolvedValue({ ok: true, changed: false });
    const { onClose } = render();
    save().click();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith(false));
    expect(showToast).toHaveBeenCalledWith(m.bookings_edit_unchanged(), 'info');
  });

  it('a booking changed meanwhile (`stale`): says so, and reopens on the booking as it is now', async () => {
    editBooking.mockRejectedValue(
      new BookingsApiError('dev text', 'BOOKING_EDIT_CONFLICT', 409, [], null, 'stale')
    );
    const { onClose, onStale } = render();
    save().click();
    await vi.waitFor(() => expect(onStale).toHaveBeenCalledTimes(1));
    expect(showToast).toHaveBeenCalledWith(m.bookings_edit_refusal_stale(), 'error');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('words a refusal by its rule, says the booking has not changed, and stays open', async () => {
    editBooking.mockRejectedValue(
      new BookingsApiError('dev text', 'BOOKING_EDIT_QUOTA', 409, [], null, 'minutes-per-period')
    );
    const { onClose } = render();
    save().click();
    await vi.waitFor(() =>
      expect(alertText()).toBe(
        `${m.bookings_refusal_minutes_per_period()} ${m.bookings_edit_refusal_unchanged()}`
      )
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a conflict closes the sheet on a grid known stale', async () => {
    editBooking.mockRejectedValue(
      new BookingsApiError('dev text', 'BOOKING_EDIT_CONFLICT', 409, [], null, 'slot-taken')
    );
    const { onClose } = render();
    save().click();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
    expect(showToast).toHaveBeenCalledWith(
      `${m.bookings_edit_refusal_conflict()} ${m.bookings_edit_refusal_unchanged()}`,
      'error'
    );
  });
});
