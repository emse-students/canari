import { readFileSync } from 'fs';
import { join } from 'path';
import { TREND_WINDOW_HOURS } from './campus-trend';

/**
 * The devices prune the record of the posts they displayed by this window (owner, 2026-11-24, a trend
 * for a post already displayed on the device shows nothing): a post older than the window can never
 * be announced as a trend again. The number is the contract's, so a change here that the devices do
 * not follow fails this test rather than showing up as a trend that was dropped for a post it still
 * could announce.
 */
describe('campus trend window - the devices prune their seen-post record by it', () => {
  it('equals libs/contracts/notification-seen-trend.cases.json', () => {
    const contract = JSON.parse(
      readFileSync(
        join(
          __dirname,
          '..',
          '..',
          '..',
          '..',
          'libs',
          'contracts',
          'notification-seen-trend.cases.json'
        ),
        'utf8'
      )
    ) as { trendWindowHours: number };
    expect(contract.trendWindowHours).toBe(TREND_WINDOW_HOURS);
  });
});
