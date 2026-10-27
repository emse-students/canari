import { Logger } from '@nestjs/common';
import { FormReminderScheduler } from './forms-reminder.scheduler';

/**
 * The 5-minute tick reads at Lydia the online answers whose request has ended (the reconciliation),
 * THEN moves stale online answers to `expired`, THEN forgets the visitor of every guest answer no
 * longer waiting (PP5, `guest-visitor.ts`) - each in its own `try`, so one failing never keeps the
 * others from running.
 */
describe('FormReminderScheduler.expireStalePendingPayments', () => {
  function withForms(
    forms: Record<string, jest.Mock>,
    sweepFormPayments: jest.Mock = jest.fn(async () => undefined)
  ) {
    return new FormReminderScheduler(
      {} as never,
      {} as never,
      {} as never,
      forms as never,
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

/**
 * TWO COPIES OF THIS SERVICE RUN AT ONCE DURING A RELEASE - the new replica starts beside the old one
 * (docs/wiki/cicd.md#a-deploy-replaces-nothing-a-member-is-talking-to) - and a minute boundary in
 * that overlap fires the reminder cron in both. Both read the same unsent reminder; only one may send
 * it. Run against one in-memory `form_reminders` table that both schedulers share, as they share the
 * database.
 */

interface Row {
  id: string;
  formId: string;
  userId: string;
  opensAt: Date;
  notified5min: boolean;
  notifiedOnOpen: boolean;
}

/** A repository over `rows` with the two calls the scheduler makes, `find` and a WHERE-matching `update`. */
function sharedRepo(rows: Row[]) {
  return {
    // Each `find` returns copies, as two processes each hold their own read of the row. The two
    // windows are the scheduler's own: opening within five minutes, or already open.
    find: jest.fn(async ({ where }: { where: Partial<Record<keyof Row, unknown>> }) => {
      const now = Date.now();
      return rows
        .filter((r) =>
          'notified5min' in where
            ? !r.notified5min &&
              r.opensAt.getTime() >= now &&
              r.opensAt.getTime() <= now + 5 * 60_000
            : !r.notifiedOnOpen && r.opensAt.getTime() <= now
        )
        .map((r) => ({ ...r }));
    }),
    update: jest.fn(async (criteria: string | Partial<Row>, patch: Partial<Row>) => {
      const where: Partial<Row> = typeof criteria === 'string' ? { id: criteria } : criteria;
      const matched = rows.filter((r) =>
        (Object.keys(where) as (keyof Row)[]).every((key) => r[key] === where[key])
      );
      for (const r of matched) Object.assign(r, patch);
      return { affected: matched.length };
    }),
  };
}

function scheduler(repo: ReturnType<typeof sharedRepo>, pushes: string[]) {
  const push = { notifyContent: jest.fn(async (userId: string) => void pushes.push(userId)) };
  const notifications = { createNotification: jest.fn(async () => undefined) };
  return new FormReminderScheduler(
    repo as never,
    push as never,
    notifications as never,
    {} as never,
    {} as never
  );
}

describe('FormReminderScheduler.checkReminders', () => {
  it('sends a reminder once when two replicas run the same tick', async () => {
    const rows: Row[] = [
      {
        id: 'aaaaaaaa-0000-0000-0000-000000000001',
        formId: 'ffffffff-0000-0000-0000-000000000001',
        userId: 'user-1-xxxxxxxx',
        // Already open: the "at open" reminder is due, the 5-minute one is past.
        opensAt: new Date(Date.now() - 1000),
        notified5min: true,
        notifiedOnOpen: false,
      },
    ];
    const repo = sharedRepo(rows);
    const pushes: string[] = [];

    await Promise.all([
      scheduler(repo, pushes).checkReminders(),
      scheduler(repo, pushes).checkReminders(),
    ]);

    expect(pushes).toEqual(['user-1-xxxxxxxx']);
    expect(rows[0].notifiedOnOpen).toBe(true);
  });

  it('still sends every due reminder when only one replica runs', async () => {
    const rows: Row[] = [
      {
        id: 'aaaaaaaa-0000-0000-0000-000000000002',
        formId: 'ffffffff-0000-0000-0000-000000000002',
        userId: 'user-2-xxxxxxxx',
        opensAt: new Date(Date.now() + 60_000),
        notified5min: false,
        notifiedOnOpen: false,
      },
    ];
    const repo = sharedRepo(rows);
    const pushes: string[] = [];

    await scheduler(repo, pushes).checkReminders();

    expect(pushes).toEqual(['user-2-xxxxxxxx']);
    expect(rows[0].notified5min).toBe(true);
    expect(rows[0].notifiedOnOpen).toBe(false);
  });
});
