import { parkedAgeDays, type WebhookDelivery } from './api';

/** The age `/admin/cercle` shows beside a parked Cercle top-up, in whole days since the payment. */
describe('parkedAgeDays', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = Date.parse('2026-11-27T10:00:00.000Z');
  const parked = (createdAt: number, lastAttemptAt: string | null = null) =>
    ({ createdAt: new Date(createdAt).toISOString(), lastAttemptAt }) as WebhookDelivery;

  it('counts from the payment, in whole days', () => {
    expect(parkedAgeDays(parked(NOW - 7 * DAY), NOW)).toBe(7);
    expect(parkedAgeDays(parked(NOW - 7 * DAY + 1), NOW)).toBe(6);
  });

  it('ignores the last attempt, which every re-send moves', () => {
    expect(parkedAgeDays(parked(NOW - 26 * DAY, new Date(NOW - DAY).toISOString()), NOW)).toBe(26);
  });

  it('is never negative, whatever the two clocks say', () => {
    expect(parkedAgeDays(parked(NOW + DAY), NOW)).toBe(0);
  });
});
