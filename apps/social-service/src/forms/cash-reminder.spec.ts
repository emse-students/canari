import { CASH_REMINDER_LEAD_MS, cashReminderDueAt } from './cash-reminder';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-21T12:00:00Z');
const after = (ms: number) => new Date(NOW.getTime() + ms);

describe('cashReminderDueAt - when the one notice before a cash hold expires is owed', () => {
  it('is 24 hours before the expiry for a hold of two days or more', () => {
    expect(cashReminderDueAt(after(7 * DAY), NOW)).toEqual(after(6 * DAY));
    expect(cashReminderDueAt(after(2 * DAY), NOW)).toEqual(after(DAY));
    expect(CASH_REMINDER_LEAD_MS).toBe(DAY);
  });

  // A one-day hold announced the moment it is taken would tell the member nothing new.
  it('is halfway through a hold shorter than two days, never at its start', () => {
    expect(cashReminderDueAt(after(DAY), NOW)).toEqual(after(DAY / 2));
    expect(cashReminderDueAt(after(DAY), NOW).getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('is the expiry itself for a hold that already ended (nothing to announce ahead)', () => {
    expect(cashReminderDueAt(after(-DAY), NOW)).toEqual(after(-DAY));
  });
});
