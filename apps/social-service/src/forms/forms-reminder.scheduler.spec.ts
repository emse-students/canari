import { Logger } from '@nestjs/common';
import { FormReminderScheduler } from './forms-reminder.scheduler';

/**
 * The 5-minute tick reads at Lydia the online answers whose request has ended (the reconciliation),
 * THEN moves stale online answers to `expired`, THEN forgets the visitor of every guest answer no
 * longer waiting (PP5, `guest-visitor.ts`) - each in its own `try`, so one failing never keeps the
 * others from running.
 */
describe('FormReminderScheduler.expireStalePendingPayments', () => {
  const CUTOFF = new Date('2026-10-27T12:00:00Z');

  function withForms(
    forms: Record<string, jest.Mock>,
    sweepFormPayments: jest.Mock = jest.fn(async () => undefined)
  ) {
    return new FormReminderScheduler(
      {} as never,
      {} as never,
      {} as never,
      { pendingHoldCutoff: jest.fn(async () => CUTOFF), ...forms } as never,
      { sweepFormPayments } as never
    );
  }

  it('reads ended requests at Lydia BEFORE the expiry, then forgets settled guest visitors', async () => {
    const calls: string[] = [];
    await withForms(
      {
        expireStalePendingPayments: jest.fn(async () => void calls.push('expire')),
        forgetSettledGuestVisitors: jest.fn(async () => void calls.push('forget')),
      },
      jest.fn(async () => void calls.push('reconcile'))
    ).expireStalePendingPayments();
    // Control: with the sweep after the expiry, a row due for its read is already `expired`.
    expect(calls).toEqual(['reconcile', 'expire', 'forget']);
  });

  // With a clock each, a row whose hold ended between the read's SELECT and the expiry's UPDATE was
  // expired without the read: both must be handed the SAME instant, read once.
  it('hands the read and the expiry ONE cutoff, read once per tick', async () => {
    const cutoff = jest.fn(async () => CUTOFF);
    const expire = jest.fn(async () => 0);
    const sweep = jest.fn(async () => undefined);
    await withForms(
      {
        pendingHoldCutoff: cutoff,
        expireStalePendingPayments: expire,
        forgetSettledGuestVisitors: jest.fn(async () => 0),
      },
      sweep
    ).expireStalePendingPayments();
    expect(cutoff).toHaveBeenCalledTimes(1);
    expect(sweep).toHaveBeenCalledWith(CUTOFF);
    expect(expire).toHaveBeenCalledWith(CUTOFF);
  });

  it('neither reads nor expires when the cutoff cannot be read, and still forgets', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const expire = jest.fn(async () => 0);
    const sweep = jest.fn(async () => undefined);
    const forget = jest.fn(async () => 0);
    await withForms(
      {
        pendingHoldCutoff: jest.fn(async () => {
          throw new Error('db down');
        }),
        expireStalePendingPayments: expire,
        forgetSettledGuestVisitors: forget,
      },
      sweep
    ).expireStalePendingPayments();
    expect(sweep).not.toHaveBeenCalled();
    expect(expire).not.toHaveBeenCalled();
    expect(forget).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('still expires when the reconciliation sweep fails, and logs the failure at ERROR', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const expire = jest.fn(async () => 0);
    await withForms(
      { expireStalePendingPayments: expire, forgetSettledGuestVisitors: jest.fn(async () => 0) },
      jest.fn(async () => {
        throw new Error('db down');
      })
    ).expireStalePendingPayments();
    expect(expire).toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      '[RECONCILE] form sweep failed before reading any row',
      expect.any(Error)
    );
    error.mockRestore();
  });

  // Control (2026-10-22): the expiry's own `try` removed -> a failed expiry skipped the forget,
  // and this test failed.
  it('still forgets when the expiry fails, and logs the failure', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const forget = jest.fn(async () => 0);
    await withForms({
      expireStalePendingPayments: jest.fn(async () => {
        throw new Error('db down');
      }),
      forgetSettledGuestVisitors: forget,
    }).expireStalePendingPayments();
    expect(forget).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[PENDING] Error expiring stale online payments',
      expect.any(Error)
    );
    warn.mockRestore();
  });
});

// The reminder claim itself (two replicas, one push) runs against a real PostgreSQL in
// `openings/opening-reminders.integration.spec.ts`, where the claim is a statement, not a mock.
