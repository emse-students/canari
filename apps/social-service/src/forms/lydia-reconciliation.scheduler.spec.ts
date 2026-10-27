import { Logger } from '@nestjs/common';
import { LydiaReconciliationScheduler } from './lydia-reconciliation.scheduler';

/**
 * THE SWITCH (`LYDIA_RECONCILE_ENABLED`): off by default and on production until the signed amount
 * format is measured. Off, the scheduler says so ONCE at startup and the hourly line is skipped;
 * on, it says so once and reports every hour.
 */
describe('LydiaReconciliationScheduler and its switch', () => {
  const saved = process.env.LYDIA_RECONCILE_ENABLED;
  afterEach(() => {
    jest.restoreAllMocks();
    if (saved === undefined) delete process.env.LYDIA_RECONCILE_ENABLED;
    else process.env.LYDIA_RECONCILE_ENABLED = saved;
  });

  function make() {
    const reconciliation = {
      sweepProductCheckouts: jest.fn(async () => undefined),
      takeCounts: jest.fn(() => ({ forms: {}, products: {} })),
      openWithoutKey: jest.fn(async () => 0),
    };
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    return {
      scheduler: new LydiaReconciliationScheduler(reconciliation as never),
      reconciliation,
      log,
    };
  }

  it('OFF: one startup line says so, and the hourly report reads nothing', async () => {
    delete process.env.LYDIA_RECONCILE_ENABLED;
    const { scheduler, reconciliation, log } = make();
    scheduler.onModuleInit();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('sweep OFF'));
    await scheduler.reportHourly();
    expect(reconciliation.openWithoutKey).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('ON: one startup line says so, and the hourly report is written', async () => {
    process.env.LYDIA_RECONCILE_ENABLED = 'true';
    const { scheduler, log } = make();
    scheduler.onModuleInit();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('sweep ON'));
    await scheduler.reportHourly();
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining('[RECONCILE] last hour'));
  });
});
