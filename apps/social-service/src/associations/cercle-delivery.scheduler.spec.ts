import { Logger } from '@nestjs/common';
import { CercleDeliveryScheduler, LONG_PARKED_DAYS } from './cercle-delivery.scheduler';

/**
 * The daily report of PARKED Cercle top-ups: one line, counts only, a WARN while any has waited
 * longer than LONG_PARKED_DAYS, an ERROR when it cannot count.
 */
describe('CercleDeliveryScheduler.reportLongParked', () => {
  const NOW = new Date('2026-11-27T03:25:00Z');

  function run(countParkedDeliveries: jest.Mock) {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const scheduler = new CercleDeliveryScheduler({ countParkedDeliveries } as never);
    return { scheduler, log, warn, error };
  }

  afterEach(() => jest.restoreAllMocks());

  it('asks for the rows parked since before seven days ago', async () => {
    const count = jest.fn(async () => ({ parked: 0, old: 0 }));
    const { scheduler } = run(count);
    await scheduler.reportLongParked(NOW);
    expect(count).toHaveBeenCalledWith(
      new Date(NOW.getTime() - LONG_PARKED_DAYS * 24 * 60 * 60 * 1000)
    );
  });

  it('prints its counts at log when nothing waits long - the line is its liveness proof', async () => {
    const { scheduler, log, warn } = run(jest.fn(async () => ({ parked: 2, old: 0 })));
    await scheduler.reportLongParked(NOW);
    expect(warn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('[CERCLE_PARKED] parked=2 older_than_7d=0');
  });

  it('warns while any parked top-up is older than seven days, with counts and no names', async () => {
    const { scheduler, warn } = run(jest.fn(async () => ({ parked: 3, old: 1 })));
    await scheduler.reportLongParked(NOW);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain('[CERCLE_PARKED] parked=3 older_than_7d=1');
    expect(line).not.toMatch(/user|@|cents|€/i);
  });

  it('accuses a count it could not take, and never throws out of the cron', async () => {
    const { scheduler, error } = run(
      jest.fn(async () => {
        throw new Error('db down');
      })
    );
    await expect(scheduler.reportLongParked(NOW)).resolves.toBeUndefined();
    expect(String(error.mock.calls[0][0])).toContain('unwatched today');
  });
});
