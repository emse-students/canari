import { Logger } from '@nestjs/common';
import { DUE_HEADS_UP_SQL } from '../openings/opening-reminders';
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

/**
 * The hourly cash tick tells each member ONCE that their cash hold is about to expire
 * (`cash-reminder.ts`), THEN expires what is past - a claim per answer before its bell row, and a
 * release when the row could not be written. The claim's SQL is proven on PostgreSQL in
 * `cash-reminder.integration.spec.ts`.
 */
describe('FormReminderScheduler.expireStaleCashPayments - the one notice before a cash hold expires', () => {
  const due = (id: string) => ({
    submissionId: id,
    userId: `user-${id}`,
    formId: 'form-1',
    formTitle: 'Gala',
    associationId: 'asso-1',
    associationName: 'BDE',
    associationLogoUrl: null,
  });

  function scheduler(forms: Record<string, jest.Mock>, createNotification: jest.Mock) {
    return new FormReminderScheduler(
      {} as never,
      {} as never,
      { createNotification } as never,
      {
        dueCashReminders: jest.fn(async () => []),
        claimCashReminder: jest.fn(async () => true),
        releaseCashReminder: jest.fn(async () => undefined),
        expireStalecashPayments: jest.fn(async () => 0),
        ...forms,
      } as never,
      {} as never
    );
  }

  it('tells the member once, by a bell row with no push, BEFORE the expiry runs', async () => {
    const calls: string[] = [];
    const create = jest.fn(async () => void calls.push('notice'));
    await scheduler(
      {
        dueCashReminders: jest.fn(async () => [due('a')]),
        expireStalecashPayments: jest.fn(async () => (calls.push('expire'), 0)),
      },
      create
    ).expireStaleCashPayments();
    expect(calls).toEqual(['notice', 'expire']);
    expect(create).toHaveBeenCalledWith({
      recipientId: 'user-a',
      type: 'form_cash_expiring',
      postId: 'form-1',
      actorId: 'system',
      actorName: 'BDE',
      associationId: 'asso-1',
      associationLogoUrl: null,
      text: 'Gala',
      skipPush: true,
    });
  });

  // Control: without the claim check, a second replica (or a validation landing meanwhile) told
  // the member a second time.
  it('tells nobody whose claim another run won', async () => {
    const create = jest.fn(async () => undefined);
    await scheduler(
      {
        dueCashReminders: jest.fn(async () => [due('a')]),
        claimCashReminder: jest.fn(async () => false),
      },
      create
    ).expireStaleCashPayments();
    expect(create).not.toHaveBeenCalled();
  });

  it('releases a claim whose notice failed, at ERROR, and still tells the others', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const release = jest.fn(async () => undefined);
    const create = jest
      .fn()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce(undefined);
    await scheduler(
      {
        dueCashReminders: jest.fn(async () => [due('a'), due('b')]),
        releaseCashReminder: release,
      },
      create
    ).expireStaleCashPayments();
    expect(release).toHaveBeenCalledWith('a');
    expect(create).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('reminder NOT written for a'),
      expect.any(Error)
    );
    error.mockRestore();
  });

  it('still expires when the reminders cannot be read', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const expire = jest.fn(async () => 0);
    await scheduler(
      {
        dueCashReminders: jest.fn(async () => {
          throw new Error('db down');
        }),
        expireStalecashPayments: expire,
      },
      jest.fn()
    ).expireStaleCashPayments();
    expect(expire).toHaveBeenCalled();
    warn.mockRestore();
  });
});

/**
 * THE LOCK SCREEN SAYS WHAT THE BELL SAYS (reading of 2026-11-23, Mi 9T): a form opening pushed
 * "Formulaire ouvert !" with no picture while its bell row named the association and carried its
 * logo. Both come from the same statement's row, and the push carries the association as the actor,
 * its logo as the picture and the form's title.
 */
describe('FormReminderScheduler.checkReminders - the push carries the facts of the bell row', () => {
  const facts = {
    associationId: 'asso-1',
    associationName: 'Club photo',
    associationLogoUrl: '/api/media/public/logo-1?v=1',
    associationLogoMediaId: 'logo-1',
    targetName: 'Sortie macro',
  };
  const opening = {
    id: 'rem-1',
    kind: 'form',
    targetId: 'form-1',
    userId: 'user-1',
    origin: 'asked',
    targetLive: true,
    stillOwed: true,
    linkOnly: false,
    bellWithholds: false,
    ...facts,
  };

  async function run(due: { headsUp?: object[]; openings?: object[] }) {
    const query = jest.fn(async (sql: string) =>
      sql === DUE_HEADS_UP_SQL ? (due.headsUp ?? []) : (due.openings ?? [])
    );
    const notifyContent = jest.fn(async () => undefined);
    const createNotification = jest.fn(async () => undefined);
    const scheduler = new FormReminderScheduler(
      { manager: { query }, update: jest.fn(async () => ({ affected: 1 })) } as never,
      { notifyContent } as never,
      { createNotification } as never,
      {} as never,
      {} as never
    );
    await scheduler.checkReminders();
    return { notifyContent, createNotification };
  }

  it('an opening pushes the association, its logo and the form title - as the bell row does', async () => {
    const { notifyContent, createNotification } = await run({ openings: [opening] });
    const content = notifyContent.mock.calls[0][1] as Record<string, unknown>;
    expect(content).toMatchObject({
      key: 'form_open',
      actorName: 'Club photo',
      arg: 'Sortie macro',
      icon: { kind: 'publicMedia', mediaId: 'logo-1' },
    });
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        actorName: 'Club photo',
        associationId: 'asso-1',
        associationLogoUrl: '/api/media/public/logo-1?v=1',
      })
    );
  });

  it('the heads-up carries them too', async () => {
    const { notifyContent } = await run({ headsUp: [opening] });
    expect(notifyContent.mock.calls[0][1]).toMatchObject({
      key: 'form_opening_soon',
      actorName: 'Club photo',
      arg: 'Sortie macro',
      icon: { kind: 'publicMedia', mediaId: 'logo-1' },
    });
  });

  it('a personal form pushes no picture, never a member face', async () => {
    const { notifyContent } = await run({
      openings: [
        {
          ...opening,
          associationId: null,
          associationName: null,
          associationLogoUrl: null,
          associationLogoMediaId: null,
        },
      ],
    });
    const content = notifyContent.mock.calls[0][1] as Record<string, unknown>;
    expect(content.actorName).toBe('');
    expect(content).not.toHaveProperty('icon');
  });
});
