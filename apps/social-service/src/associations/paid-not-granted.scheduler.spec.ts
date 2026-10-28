import { Logger } from '@nestjs/common';
import { PaidNotGrantedScheduler } from './paid-not-granted.scheduler';

describe('PaidNotGrantedScheduler - the tiers paid for and not granted, every hour', () => {
  const make = (count: number, orphans = 0) => {
    const purchases = { countPaidNotGranted: jest.fn().mockResolvedValue(count) };
    const tags = { countOrphanTierTags: jest.fn().mockResolvedValue(orphans) };
    const scheduler = new PaidNotGrantedScheduler(purchases as never, tags as never);
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    return { scheduler, log, warn, error, purchases, tags };
  };

  afterEach(() => jest.restoreAllMocks());

  it('prints count=0 at log level, its own liveness proof', async () => {
    const { scheduler, log, error } = make(0);
    expect(await scheduler.reportOnce()).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('count=0'));
    expect(error).not.toHaveBeenCalled();
  });

  it('accuses at ERROR while any row carries the marker', async () => {
    const { scheduler, error } = make(2);
    expect(await scheduler.reportOnce()).toBe(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('count=2'));
  });

  it('counts the tags of deleted tiers: count=0 at log, a WARN while any is held', async () => {
    const quiet = make(0, 0);
    expect(await quiet.scheduler.reportOrphansOnce()).toBe(0);
    expect(quiet.log).toHaveBeenCalledWith(expect.stringContaining('[ORPHAN_TIER_TAGS] count=0'));
    jest.restoreAllMocks();
    const held = make(0, 3);
    expect(await held.scheduler.reportOrphansOnce()).toBe(3);
    expect(held.warn).toHaveBeenCalledWith(expect.stringContaining('count=3'));
  });

  it('one reading failing does not silence the other', async () => {
    const { scheduler, purchases, tags, error } = make(0, 0);
    purchases.countPaidNotGranted.mockRejectedValue(new Error('down'));
    await scheduler.report();
    expect(tags.countOrphanTierTags).toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('[PAID_NOT_GRANTED]'));
  });
});
