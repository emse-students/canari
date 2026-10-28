import { Logger } from '@nestjs/common';
import { PaidNotGrantedScheduler } from './paid-not-granted.scheduler';

describe('PaidNotGrantedScheduler - the tiers paid for and not granted, every hour', () => {
  const make = (count: number) => {
    const purchases = { countUnclosedPaidNotGranted: jest.fn().mockResolvedValue(count) };
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

  it('accuses at ERROR while any marked row has no closing', async () => {
    const { scheduler, error } = make(2);
    expect(await scheduler.reportOnce()).toBe(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('count=2'));
    // Any product, not only a tier, and a check before a refund: the mark can over-count.
    expect(error).toHaveBeenCalledWith(expect.stringContaining('NOT delivered'));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('check what each buyer holds now'));
  });

  it('counts only the marked payments nobody has closed', async () => {
    const { scheduler } = make(0);
    await scheduler.reportOnce();
    const purchases = (scheduler as unknown as { purchases: Record<string, jest.Mock> }).purchases;
    expect(purchases.countUnclosedPaidNotGranted).toHaveBeenCalledTimes(1);
  });
});
