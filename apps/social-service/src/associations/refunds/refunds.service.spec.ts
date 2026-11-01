import { readFileSync } from 'fs';
import { join } from 'path';
import { ForbiddenException, Logger } from '@nestjs/common';
import axios from 'axios';
import {
  LYDIA_REFUND_NOTIFICATIONS_ENABLED,
  LydiaRefundNotifier,
} from './lydia-refund-notifier.service';
import {
  CORE_REFUND_CODES,
  LYDIA_REFUND_EXCEEDS_PAID,
  LYDIA_REFUND_IN_FLIGHT,
  LYDIA_REFUND_INVALID,
  LYDIA_REFUND_ISSUED_TYPE,
  LYDIA_REFUND_NOT_PENDING,
  LYDIA_REFUND_NOT_REFUNDABLE,
} from './refund-codes';
import { RefundsService } from './refunds.service';

const CONTRACT = JSON.parse(
  readFileSync(
    join(__dirname, '..', '..', '..', '..', '..', 'libs', 'contracts', 'lydia-refusal-codes.json'),
    'utf8'
  )
) as {
  refund: {
    core: Record<string, string>;
    social: Record<string, string>;
    notificationTypes: { issued: string };
  };
};

/** The service with its collaborators stubbed; the database half is refunds.integration.spec.ts. */
function make(canManage = true) {
  const associations = { canManagePayoutAccount: jest.fn().mockResolvedValue(canManage) };
  const service = new RefundsService(
    { manager: {} } as any,
    associations as any,
    { tell: jest.fn() } as any
  );
  return { service, associations };
}

describe('RefundsService', () => {
  beforeEach(() => {
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });
  afterEach(() => jest.restoreAllMocks());

  it('names the codes the shared contract names', () => {
    expect({
      notRefundable: LYDIA_REFUND_NOT_REFUNDABLE,
      exceedsPaid: LYDIA_REFUND_EXCEEDS_PAID,
      inFlight: LYDIA_REFUND_IN_FLIGHT,
      invalid: LYDIA_REFUND_INVALID,
      notPending: LYDIA_REFUND_NOT_PENDING,
    }).toEqual(CONTRACT.refund.social);
    expect(CORE_REFUND_CODES).toEqual(CONTRACT.refund.core);
    expect(LYDIA_REFUND_ISSUED_TYPE).toBe(CONTRACT.refund.notificationTypes.issued);
  });

  describe('the MANAGE_PAYOUT_ACCOUNT check', () => {
    it('refuses a member without it (403), asked of the route association', async () => {
      const { service, associations } = make(false);
      await expect(service.assertPayoutManager('u1', 'a1', false)).rejects.toBeInstanceOf(
        ForbiddenException
      );
      expect(associations.canManagePayoutAccount).toHaveBeenCalledWith('u1', 'a1', {
        isGlobalAdmin: false,
      });
    });

    it('lets a holder through', async () => {
      const { service } = make(true);
      await expect(service.assertPayoutManager('u1', 'a1', false)).resolves.toBeUndefined();
    });
  });

  describe('a request that is not a refund is refused before anything is read', () => {
    const key = '0b0f6a9e-2f4c-4b8e-9d1a-3c5e7f9a1b2c';
    it.each([
      ['no kind', { reason: 'r', idempotencyKey: key }],
      ['no reason', { kind: 'total', reason: '  ', idempotencyKey: key }],
      ['a reason too long', { kind: 'total', reason: 'x'.repeat(501), idempotencyKey: key }],
      ['no key', { kind: 'total', reason: 'r' }],
      ['a key that is not a uuid', { kind: 'total', reason: 'r', idempotencyKey: 'abc' }],
      ['a partial without amount', { kind: 'partial', reason: 'r', idempotencyKey: key }],
      ['a partial of zero', { kind: 'partial', amountCents: 0, reason: 'r', idempotencyKey: key }],
      [
        'a partial in euros',
        { kind: 'partial', amountCents: 2.5, reason: 'r', idempotencyKey: key },
      ],
    ])('%s', async (_name, input) => {
      const { service } = make();
      await expect(service.refund('a1', 'p1', 'u1', input as any)).rejects.toMatchObject({
        status: 400,
        response: { code: LYDIA_REFUND_INVALID },
      });
    });
  });

  describe("core's answer, classified on its status and code", () => {
    const row = { id: 'r1', vendorToken: 'v', orderRef: 'product:x:y', amountCents: 500 } as any;
    const ask = (service: RefundsService) =>
      (service as unknown as { askLydia(r: unknown): Promise<unknown> }).askLydia(row);
    const failing = (status: number | undefined, code?: string) =>
      Object.assign(new Error('x'), status ? { response: { status, data: { code } } } : {});

    it('a 2xx is a refund Lydia confirmed, asked with the amount in cents', async () => {
      const post = jest.spyOn(axios, 'post').mockResolvedValue({ data: { ok: true } });
      await expect(ask(make().service)).resolves.toEqual({
        status: 'confirmed',
        outcome: 'refunded',
      });
      expect(post.mock.calls[0][1]).toEqual({
        vendorToken: 'v',
        orderRef: 'product:x:y',
        amountCents: 500,
      });
    });

    it('a 409 is a refusal Lydia answered, recorded by its typed code', async () => {
      jest
        .spyOn(axios, 'post')
        .mockRejectedValue(failing(409, CORE_REFUND_CODES.notRefundableAtLydia));
      await expect(ask(make().service)).resolves.toEqual({
        status: 'refused',
        outcome: CORE_REFUND_CODES.notRefundableAtLydia,
      });
    });

    it.each([
      [400, undefined],
      [403, undefined],
      [503, 'PAYMENT_SERVICE_NOT_READY'],
    ])('a %s means core sent nothing', async (status, code) => {
      jest.spyOn(axios, 'post').mockRejectedValue(failing(status, code));
      await expect(ask(make().service)).resolves.toEqual({
        status: 'refused',
        outcome: 'not-sent',
      });
    });

    // A 2xx is a refund only when core says ok: true - any other body is unreadable, never a refund.
    it.each([
      ['an empty object', {}],
      ['an empty string', ''],
      ['null', null],
      ['ok false', { ok: false }],
      ['ok as a string', { ok: 'true' }],
    ])('a 2xx carrying %s is kept pending, never a refund', async (_name, data) => {
      jest.spyOn(axios, 'post').mockResolvedValue({ data });
      await expect(ask(make().service)).resolves.toEqual({
        status: 'pending',
        outcome: 'no-answer',
      });
    });

    it.each([[504], [502], [500], [503], [undefined]])(
      'a %s may have refunded: kept pending, never a refusal',
      async (status) => {
        jest.spyOn(axios, 'post').mockRejectedValue(failing(status));
        await expect(ask(make().service)).resolves.toEqual({
          status: 'pending',
          outcome: 'no-answer',
        });
      }
    );
  });
});

describe('RefundsService - the manager check and the recording of an answer', () => {
  beforeEach(() => {
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });
  afterEach(() => jest.restoreAllMocks());

  /** A service whose repository answers `row` and whose sweep finds nothing. */
  function withRow(row: Record<string, unknown> | null) {
    const refundRepo = {
      manager: { query: jest.fn().mockResolvedValue([]) },
      findOne: jest.fn().mockResolvedValue(row),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const service = new RefundsService(refundRepo as any, {} as any, { tell: jest.fn() } as any);
    const settle = jest
      .spyOn(service as unknown as { settle: () => Promise<unknown> }, 'settle')
      .mockImplementation(async () => ({ ...row, status: 'confirmed', outcome: 'refunded' }));
    return { service, refundRepo, settle };
  }
  const pending = (outcome: string | null) => ({
    id: 'r1',
    associationId: 'a1',
    purchaseRecordId: 'p1',
    kind: 'total',
    amountCents: 500,
    reason: 'r',
    status: 'pending',
    outcome,
    requestedAt: new Date(),
  });

  it.each([[undefined], ['true'], [1], [null]])(
    'a declaration that is not a boolean (%j) is LYDIA_REFUND_INVALID, never "not refunded"',
    async (refunded) => {
      const { service, settle } = withRow(pending('no-answer'));
      await expect(service.resolve('a1', 'r1', 'u1', refunded)).rejects.toMatchObject({
        status: 400,
        response: { code: LYDIA_REFUND_INVALID },
      });
      expect(settle).not.toHaveBeenCalled();
    }
  );

  it('a refund still being asked (no outcome) cannot be declared at all', async () => {
    const { service, settle } = withRow(pending(null));
    for (const refunded of [true, false]) {
      await expect(service.resolve('a1', 'r1', 'u1', refunded)).rejects.toMatchObject({
        status: 409,
        response: { code: LYDIA_REFUND_IN_FLIGHT },
      });
    }
    expect(settle).not.toHaveBeenCalled();
  });

  it('a refund Lydia never answered (no-answer) is declared either way', async () => {
    const { service, settle } = withRow(pending('no-answer'));
    await service.resolve('a1', 'r1', 'u1', false);
    expect(settle).toHaveBeenCalledWith(
      expect.anything(),
      'r1',
      { status: 'refused', outcome: 'declared-not-refunded' },
      'u1'
    );
  });

  it('a refund Lydia confirmed but Canari did not record may only be recorded', async () => {
    const { service, settle } = withRow(pending('refunded-unrecorded'));
    await expect(service.resolve('a1', 'r1', 'u1', false)).rejects.toMatchObject({
      status: 409,
      response: { code: LYDIA_REFUND_NOT_PENDING },
    });
    await service.resolve('a1', 'r1', 'u1', true);
    expect(settle).toHaveBeenCalledWith(
      expect.anything(),
      'r1',
      { status: 'confirmed', outcome: 'refunded' },
      'u1'
    );
  });

  it('a refund of another association is not found, and says so in the log', async () => {
    const { service } = withRow(null);
    const warn = jest.spyOn(Logger.prototype, 'warn');
    await expect(service.resolve('a1', 'r1', 'u1', true)).rejects.toMatchObject({ status: 404 });
    expect(warn.mock.calls.map(String).join(' | ')).toContain('not found');
  });

  it('Lydia confirmed and the write failed: marked refunded-unrecorded on its own, on the SAME connection, logged ERROR', async () => {
    const { service, refundRepo, settle } = withRow(pending(null));
    settle.mockRejectedValueOnce(new Error('deadlock'));
    const error = jest.spyOn(Logger.prototype, 'error');
    // The refund's own connection: the settle and the fallback mark both go through it, never
    // through the repository's pool.
    const runnerManager = { update: jest.fn().mockResolvedValue({ affected: 1 }) };
    const recorded = await (
      service as unknown as {
        record(m: unknown, r: unknown, o: unknown): Promise<{ outcome: string }>;
      }
    ).record(runnerManager, pending(null), { status: 'confirmed', outcome: 'refunded' });
    expect(recorded.outcome).toBe('refunded-unrecorded');
    expect((settle.mock.calls[0] as unknown[])[0]).toBe(runnerManager);
    expect(runnerManager.update).toHaveBeenCalledWith(
      expect.anything(),
      { id: 'r1', status: 'pending' },
      expect.objectContaining({ outcome: 'refunded-unrecorded' })
    );
    expect(refundRepo.update).not.toHaveBeenCalled();
    expect(error.mock.calls.map(String).join(' | ')).toContain('Lydia refunded, recording failed');
  });

  it('a refusal whose write failed is rethrown: the row stays without outcome, for the sweep', async () => {
    const { service, refundRepo, settle } = withRow(pending(null));
    settle.mockRejectedValueOnce(new Error('deadlock'));
    await expect(
      (
        service as unknown as { record(m: unknown, r: unknown, o: unknown): Promise<unknown> }
      ).record({ update: refundRepo.update }, pending(null), {
        status: 'refused',
        outcome: 'LYDIA_REFUND_REJECTED',
      })
    ).rejects.toThrow('deadlock');
    expect(refundRepo.update).not.toHaveBeenCalled();
  });
});

describe('LydiaRefundNotifier', () => {
  const asso = { id: 'asso-12345678', name: 'BDE' };
  function make() {
    const notifications = { createNotifications: jest.fn(async () => 1) };
    const push = { notifyContent: jest.fn(async () => undefined) };
    return {
      notifier: new LydiaRefundNotifier(notifications as any, push as any),
      notifications,
      push,
    };
  }

  // The gate is a deliberate pull request, not a forgotten constant: this fails the day it flips,
  // and that pull request must say the floor covers the release carrying lot 4 on both estates.
  it('ships switched off, until minClientVersion covers the release carrying lot 4', () => {
    expect(LYDIA_REFUND_NOTIFICATIONS_ENABLED).toBe(false);
    expect(make().notifier.enabled()).toBe(false);
  });

  it('writes nothing while switched off', async () => {
    const { notifier, notifications, push } = make();
    await notifier.tell(asso, 'payer');
    expect(notifications.createNotifications).not.toHaveBeenCalled();
    expect(push.notifyContent).not.toHaveBeenCalled();
  });

  it('switched on, tells the payer with the association named, and never throws', async () => {
    const { notifier, notifications, push } = make();
    jest.spyOn(notifier, 'enabled').mockReturnValue(true);
    await notifier.tell(asso, 'payer');
    expect(notifications.createNotifications).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientIds: ['payer'],
        type: LYDIA_REFUND_ISSUED_TYPE,
        postId: asso.id,
        text: 'BDE',
        skipPush: true,
      })
    );
    expect(push.notifyContent).toHaveBeenCalledTimes(1);
    notifications.createNotifications.mockRejectedValueOnce(new Error('db down'));
    await expect(notifier.tell(asso, 'payer')).resolves.toBeUndefined();
  });

  it('a guest payment has nobody to tell', async () => {
    const { notifier, notifications } = make();
    jest.spyOn(notifier, 'enabled').mockReturnValue(true);
    await notifier.tell(asso, null);
    expect(notifications.createNotifications).not.toHaveBeenCalled();
  });
});
