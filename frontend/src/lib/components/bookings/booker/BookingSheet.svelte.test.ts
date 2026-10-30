// @vitest-environment happy-dom
/**
 * THE BOOKING SHEET (D07): a summary card, the length as a stepper, the reminder as a radio chip
 * row. Pinned: the stepper's bounds keep focus (`aria-disabled`, never `disabled`), `initialCount`
 * sets the first length, the request ends at the LAST unit chosen, the chips render only while
 * notices are live and not for a booking on behalf, show the space's default (or a non-preset
 * value as an extra chip), send the picked delay in the POST body, and are native radios sharing
 * one name (the browser gives them one tab stop and the arrow keys), and "block instead" exists
 * only when the page offers it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';

const book = vi.hoisted(() => vi.fn());
const showToast = vi.hoisted(() => vi.fn());

vi.mock('$lib/bookings/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/bookings/api')>()),
  book: (...a: unknown[]) => book(...a),
}));
vi.mock('$lib/stores/toast.svelte', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));

import { setLocale } from '$lib/paraglide/runtime';
import { m } from '$lib/paraglide/messages';
import type { BookerResource, BookerSpace, SlotUnit } from '$lib/bookings/api';
import BookingSheet from './BookingSheet.svelte';

const START = Date.parse('2026-11-02T09:00:00Z');
const HALF = 30 * 60_000;
const unit = (i: number): SlotUnit =>
  ({
    date: '2026-11-02',
    startMs: START + i * HALF,
    endMs: START + (i + 1) * HALF,
    state: 'free',
  }) as SlotUnit;
const run = [0, 1, 2].map(unit);
const resource = { id: 'r1', name: 'Salle' } as BookerResource;
const baseSpace = {
  id: 'space-1',
  name: 'Salle',
  timeZone: 'Europe/Paris',
  associationId: 'asso',
  items: [],
  hiddenItemIds: [],
  maxPeople: 1,
  canManage: false,
  reminderMinutes: 60,
  retentionDays: 7,
} as unknown as BookerSpace;

const mounted: ReturnType<typeof mount>[] = [];

function render(
  over: {
    space?: Partial<BookerSpace>;
    run?: SlotUnit[];
    initialCount?: number;
    onBlockInstead?: () => void;
  } = {}
) {
  const onClose = vi.fn();
  mounted.push(
    mount(BookingSheet, {
      target: document.body,
      props: {
        space: { ...baseSpace, ...over.space },
        resource,
        run: over.run ?? run,
        initialCount: over.initialCount,
        onBlockInstead: over.onBlockInstead,
        windowNote: false,
        onReread: vi.fn(() => Promise.resolve()),
        onClose,
      },
    })
  );
  flushSync();
  return { onClose };
}

const button = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const status = () => document.querySelector('[role="status"]')?.textContent?.trim();
const chips = () => [
  ...document.querySelectorAll<HTMLInputElement>('input[name="booking-reminder"]'),
];
const checked = () => chips().find((c) => c.checked)?.value;
const submitButton = () =>
  [...document.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === m.bookings_sheet_submit()
  )!;

beforeEach(() => {
  setLocale('en', { reload: false });
  book.mockReset();
  book.mockResolvedValue({ id: 'booking-1' });
  showToast.mockReset();
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});
afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!, { outro: false });
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('BookingSheet - the length stepper', () => {
  it('starts at one unit, names its buttons in words and says the range it holds', () => {
    render();
    expect(button(m.bookings_sheet_length_less()).getAttribute('aria-label')).toBe(
      'Shorten the booking'
    );
    expect(button(m.bookings_sheet_length_more()).getAttribute('aria-label')).toBe(
      'Extend the booking'
    );
    expect(status()).toMatch(/10:00 - 10:30/);
  });

  it('starts at initialCount, clamped to the run', () => {
    render({ initialCount: 2 });
    expect(status()).toMatch(/10:00 - 11:00/);
    unmount(mounted.pop()!, { outro: false });
    document.body.innerHTML = '';
    render({ initialCount: 9 });
    expect(status()).toMatch(/10:00 - 11:30/);
  });

  it('stops at both bounds with aria-disabled, and the button keeps its focus', () => {
    render();
    const less = button(m.bookings_sheet_length_less());
    const more = button(m.bookings_sheet_length_more());
    expect(less.getAttribute('aria-disabled')).toBe('true');
    expect(less.disabled).toBe(false);
    less.click();
    flushSync();
    expect(status()).toMatch(/10:00 - 10:30/);
    more.click();
    more.click();
    flushSync();
    expect(status()).toMatch(/10:00 - 11:30/);
    expect(more.getAttribute('aria-disabled')).toBe('true');
    more.focus();
    more.click();
    flushSync();
    expect(status()).toMatch(/10:00 - 11:30/);
    expect(document.activeElement).toBe(more);
    expect(less.getAttribute('aria-disabled')).toBe('false');
  });

  it('draws no stepper for a single unit', () => {
    render({ run: [unit(0)] });
    expect(button(m.bookings_sheet_length_less())).toBeNull();
  });

  it('books up to the END of the last unit chosen', async () => {
    render({ initialCount: 1 });
    button(m.bookings_sheet_length_more()).click();
    flushSync();
    submitButton().click();
    await tick();
    const request = book.mock.calls[0][1];
    expect(request.startsAt).toBe(new Date(run[0].startMs).toISOString());
    expect(request.endsAt).toBe(new Date(run[1].endMs).toISOString());
  });
});

describe('BookingSheet - the reminder chips', () => {
  it("shows the space's default delay checked, among the presets and no reminder", () => {
    render();
    expect(chips().map((c) => c.value)).toEqual(['15', '60', '1440', 'none']);
    expect(checked()).toBe('60');
    expect(new Set(chips().map((c) => c.name)).size).toBe(1);
    expect(chips().every((c) => c.type === 'radio')).toBe(true);
  });

  it('leaves the tab stop and the arrow keys to the browser: native radios in labels, no tabindex', () => {
    // happy-dom does not move a radio group's selection on an arrow key, so what is pinned is the
    // markup that gives it in a real browser: one name, native inputs, nothing overriding focus.
    render();
    for (const chip of chips()) {
      expect(chip.hasAttribute('tabindex')).toBe(false);
      expect(chip.closest('label')).not.toBeNull();
    }
    expect(document.querySelector('[role="radio"]')).toBeNull();
    expect(document.querySelector('[role="radiogroup"]')).not.toBeNull();
  });

  it('adds a delay that is no preset as its own chip, checked', () => {
    render({ space: { reminderMinutes: 45 } });
    expect(chips().map((c) => c.value)).toEqual(['15', '45', '60', '1440', 'none']);
    expect(checked()).toBe('45');
  });

  it('sends the picked delay in the request body', async () => {
    render();
    const chip = chips().find((c) => c.value === '15')!;
    chip.click();
    flushSync();
    expect(checked()).toBe('15');
    submitButton().click();
    await tick();
    expect(book.mock.calls[0][1].reminderMinutes).toBe(15);
  });

  it('sends null for "no reminder"', async () => {
    render();
    chips()
      .find((c) => c.value === 'none')!
      .click();
    flushSync();
    submitButton().click();
    await tick();
    expect(book.mock.calls[0][1].reminderMinutes).toBeNull();
  });

  it('is not drawn when booking on behalf', () => {
    render({ space: { canManage: true } });
    expect(chips().length).toBe(4);
    const toggle = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    toggle.click();
    flushSync();
    expect(chips().length).toBe(0);
  });
});

describe('BookingSheet - block instead', () => {
  it('offers it only when the page passes onBlockInstead', () => {
    render();
    const labelled = () =>
      [...document.querySelectorAll('button')].some(
        (b) => b.textContent?.trim() === m.bookings_block_action()
      );
    expect(labelled()).toBe(false);
    unmount(mounted.pop()!, { outro: false });
    document.body.innerHTML = '';
    const onBlockInstead = vi.fn();
    render({ onBlockInstead });
    expect(labelled()).toBe(true);
    [...document.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === m.bookings_block_action())!
      .click();
    expect(onBlockInstead).toHaveBeenCalledOnce();
  });
});
