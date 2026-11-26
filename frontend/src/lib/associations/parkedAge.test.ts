import { parkedAgeDays, type WebhookDelivery } from './api';

/** The age `/admin/cercle` shows beside a parked Cercle top-up, in whole days. */
describe('parkedAgeDays', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const parked = (lastAttemptAt: string | null, createdAt = '2026-11-01T10:00:00.000Z') =>
    ({ lastAttemptAt, createdAt }) as WebhookDelivery;
  const NOW = Date.parse('2026-11-27T10:00:00.000Z');

  it('counts from the park, which is the last attempt', () => {
    expect(parkedAgeDays(parked(new Date(NOW - 7 * DAY).toISOString()), NOW)).toBe(7);
    expect(parkedAgeDays(parked(new Date(NOW - 7 * DAY + 1).toISOString()), NOW)).toBe(6);
  });

  it('falls back to the creation for a row with no attempt recorded', () => {
    expect(parkedAgeDays(parked(null), NOW)).toBe(26);
  });

  it('is never negative, whatever the two clocks say', () => {
    expect(parkedAgeDays(parked(new Date(NOW + DAY).toISOString()), NOW)).toBe(0);
  });
});
