import { Logger } from '@nestjs/common';
import { PaidNotGrantedScheduler } from './paid-not-granted.scheduler';

describe('PaidNotGrantedScheduler - the tiers paid for and not granted, every hour', () => {
  const make = (count: number) => {
    const purchases = { countPaidNotGranted: jest.fn().mockResolvedValue(count) };
    const scheduler = new PaidNotGrantedScheduler(purchases as never);
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    return { scheduler, log, error };
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
});
