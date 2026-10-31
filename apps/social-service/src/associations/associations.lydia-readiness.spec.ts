import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { In } from 'typeorm';
import { SECRET_BOX_ENV, openSecret } from '../common/secret-box';
import * as delegation from './payment-delegation.util';
import {
  AssociationsService,
  LYDIA_ACCOUNT_ALREADY_LINKED,
  LYDIA_CASHIER_PHONE_PURPOSE,
  LYDIA_RESPONSABLE_ALREADY_SET,
} from './associations.service';
import { AssociationProduct } from './entities/association-product.entity';
import { LYDIA_ENROLMENT_IN_FLIGHT, LYDIA_READINESS_LOG_TAG } from './lydia-readiness';
import { LydiaPaymentsNotifier } from './lydia-payments-notifier.service';
import { ProductsService } from './products.service';

/**
 * LYDIA READINESS (lot 2): ONE writer, a transition decided by the UPDATE itself, a revert that
 * withholds through the SAME predicate the release reads, and a notice only on a transition. Every
 * vendor token, phone and secret below is a throwaway string made up for the test.
 */
const HOLDER = '0b7e1c52-6a0e-4a43-9a43-111111111111';
const CLUB = '0b7e1c52-6a0e-4a43-9a43-222222222222';
const VENDOR = 'vendor-token-of-the-holder';
const SECRET = 'throwaway-encryption-secret-0123456789abcdef';
const PHONE = '+33612345678';

type Holder = { id: string; ready: boolean; cause: string | null; holders?: number };

/** A manager answering the two statements of `setLydiaReadiness` from one in-memory row. */
function makeReadiness(
  row: Holder | null,
  notifier = { enabled: () => true, tell: jest.fn(async () => 1) }
) {
  const update = jest.fn(async () => ({ affected: 3 }));
  const find = jest.fn(async () => [{ id: CLUB }]);
  const manager = {
    query: jest.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('FOR UPDATE')) {
        if (!row) return [];
        const one = { id: row.id, name: 'BDE', cause: row.cause, at: '2026-10-01T00:00:00.000Z' };
        return Array.from({ length: row.holders ?? 1 }, () => one);
      }
      if (sql.includes('RETURNING id')) {
        const ready = params[1] as boolean;
        if (!row || row.ready === ready) return [[], 0];
        row.ready = ready;
        row.cause = params[2] as string;
        return [[{ id: row.id }], 1];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }),
    update,
    find,
  };
  const assoRepo = {
    manager: { transaction: async (fn: (m: typeof manager) => unknown) => fn(manager), find },
  };
  const listFlagHolders = jest.fn(async () => ['manager-1', 'manager-2']);
  const service = Object.assign(Object.create(AssociationsService.prototype) as object, {
    assoRepo,
    logger: new Logger('AssociationsService'),
    redis: { deleteByPattern: jest.fn(async () => 0) },
    lydiaNotifier: notifier,
    listFlagHolders,
  }) as unknown as AssociationsService;
  return { service, manager, update, notifier, listFlagHolders };
}

function captureLogs() {
  const lines: Record<'log' | 'warn' | 'error' | 'debug', string[]> = {
    log: [],
    warn: [],
    error: [],
    debug: [],
  };
  for (const level of Object.keys(lines) as Array<keyof typeof lines>) {
    jest
      .spyOn(Logger.prototype, level)
      .mockImplementation((...args: unknown[]) => void lines[level].push(String(args[0])));
  }
  return lines;
}

afterEach(() => jest.restoreAllMocks());

describe('AssociationsService.setLydiaReadiness - one writer, the UPDATE decides the transition', () => {
  it('marks ready ONCE: a transition is a WARN and a notice, a replay a debug line and no notice', async () => {
    const logs = captureLogs();
    const row: Holder = { id: HOLDER, ready: false, cause: null };
    const { service, notifier } = makeReadiness(row);
    const first = await service.setLydiaReadiness(VENDOR, true, 'webhook-validated', {
      path: 'webhook',
    });
    expect(first).toMatchObject({ kind: 'transitioned', associationId: HOLDER });
    expect(notifier.tell).toHaveBeenCalledTimes(1);
    expect(notifier.tell).toHaveBeenCalledWith({ id: HOLDER, name: 'BDE' }, 'active', [
      'manager-1',
      'manager-2',
    ]);
    expect(logs.warn.join('|')).toContain(
      `${LYDIA_READINESS_LOG_TAG} holder ${HOLDER} marked READY`
    );

    logs.warn.length = 0;
    for (let i = 0; i < 4; i++) {
      const again = await service.setLydiaReadiness(VENDOR, true, 'webhook-validated', {
        path: 'webhook',
      });
      expect(again.kind).toBe('replay');
    }
    expect(notifier.tell).toHaveBeenCalledTimes(1);
    expect(logs.warn).toHaveLength(0);
    expect(logs.error).toHaveLength(0);
    expect(logs.debug.join('|')).toContain('replay');
  });

  it('a revert withholds ONLY on-sale products of the holder and its APPROVED delegates, at ERROR', async () => {
    const logs = captureLogs();
    const predicate = jest.spyOn(delegation, 'approvedDelegateIds');
    const row: Holder = { id: HOLDER, ready: true, cause: 'webhook-validated' };
    const { service, manager, update, notifier } = makeReadiness(row);
    const outcome = await service.setLydiaReadiness(VENDOR, false, 'request-refused', {
      path: 'shop',
      id: 'checkout-1',
    });
    expect(outcome).toMatchObject({
      kind: 'transitioned',
      previousCause: 'webhook-validated',
    });
    expect(predicate).toHaveBeenCalledWith(manager, HOLDER);
    expect(update).toHaveBeenCalledWith(
      AssociationProduct,
      { associationId: In([HOLDER, CLUB]), isActive: true },
      { isActive: false, activationWithheld: true }
    );
    const error = logs.error.join('|');
    expect(error).toContain(
      `holder ${HOLDER} reverted: request/do answered error 5 (shop checkout-1)`
    );
    expect(error).toContain('marked ready by webhook-validated');
    expect(error).toContain('3 on-sale product(s) withheld');
    expect(notifier.tell).toHaveBeenCalledWith(expect.anything(), 'paused', expect.anything());
  });

  it('error 2701 is named as such, and a revert of a holder already not ready withholds nothing', async () => {
    const logs = captureLogs();
    const blocked: Holder = { id: HOLDER, ready: true, cause: 'admin' };
    await makeReadiness(blocked).service.setLydiaReadiness(VENDOR, false, 'request-blocked', {
      path: 'form',
    });
    expect(logs.error.join('|')).toContain('error 2701');

    const already: Holder = { id: HOLDER, ready: false, cause: 'request-refused' };
    const { service, update, notifier } = makeReadiness(already);
    const outcome = await service.setLydiaReadiness(VENDOR, false, 'request-refused', {
      path: 'shop',
    });
    expect(outcome.kind).toBe('replay');
    expect(update).not.toHaveBeenCalled();
    expect(notifier.tell).not.toHaveBeenCalled();
  });

  it('no holder, or two (never guessed), writes nothing', async () => {
    const logs = captureLogs();
    const none = makeReadiness(null);
    await expect(
      none.service.setLydiaReadiness(VENDOR, true, 'webhook-validated', { path: 'webhook' })
    ).resolves.toEqual({ kind: 'no-holder' });
    const two = makeReadiness({ id: HOLDER, ready: false, cause: null, holders: 2 });
    await expect(
      two.service.setLydiaReadiness(VENDOR, true, 'webhook-validated', { path: 'webhook' })
    ).resolves.toEqual({ kind: 'no-holder' });
    expect(two.manager.query).toHaveBeenCalledTimes(1);
    expect(logs.error.join('|')).toContain('2 associations hold ONE vendor token');
  });

  it('with the switch OFF, a transition writes no notification row and says so', async () => {
    const logs = captureLogs();
    const notifications = { createNotifications: jest.fn() };
    const push = { notifyContent: jest.fn() };
    const real = new LydiaPaymentsNotifier(notifications as never, push as never);
    expect(real.enabled()).toBe(false);
    const { service } = makeReadiness({ id: HOLDER, ready: false, cause: null }, real as never);
    await service.setLydiaReadiness(VENDOR, true, 'admin', { path: 'admin', id: HOLDER });
    expect(notifications.createNotifications).not.toHaveBeenCalled();
    expect(push.notifyContent).not.toHaveBeenCalled();
    expect(logs.warn.join('|')).toContain('LYDIA_PAYMENTS_NOTIFICATIONS_ENABLED is off');
  });

  it('a notice that cannot be written leaves the committed state and is an ERROR, not a throw', async () => {
    const logs = captureLogs();
    const notifier = {
      enabled: () => true,
      tell: jest.fn(async () => Promise.reject(new Error('db down'))),
    };
    const row: Holder = { id: HOLDER, ready: false, cause: null };
    const { service } = makeReadiness(row, notifier as never);
    await expect(
      service.setLydiaReadiness(VENDOR, true, 'admin', { path: 'admin' })
    ).resolves.toMatchObject({ kind: 'transitioned' });
    expect(row.ready).toBe(true);
    expect(logs.error.join('|')).toContain('could not be written');
  });

  it('revertLydiaReadinessAfterRefusal never throws: the payer`s refusal is the answer', async () => {
    const logs = captureLogs();
    const { service } = makeReadiness(null);
    jest.spyOn(service, 'setLydiaReadiness').mockRejectedValue(new Error('db down'));
    await expect(
      service.revertLydiaReadinessAfterRefusal(VENDOR, 'request-refused', { path: 'shop', id: 'c' })
    ).resolves.toBeUndefined();
    expect(logs.error.join('|')).toContain('FAILED - the holder still reads ready');
  });
});

describe('the release and the withhold read ONE delegate predicate', () => {
  it('ProductsService.releaseWithheldForAssociationAndDelegates calls approvedDelegateIds too', async () => {
    const predicate = jest.spyOn(delegation, 'approvedDelegateIds').mockResolvedValue([CLUB]);
    const assoManager = { find: jest.fn() };
    const products = Object.assign(Object.create(ProductsService.prototype) as object, {
      assoRepo: { manager: assoManager },
      logger: new Logger('ProductsService'),
    }) as unknown as ProductsService;
    const release = jest
      .spyOn(
        products as never as { releaseWithheldProducts: (id: string) => Promise<number> },
        'releaseWithheldProducts'
      )
      .mockResolvedValue(1);
    await expect(products.releaseWithheldForAssociationAndDelegates(HOLDER)).resolves.toBe(2);
    expect(predicate).toHaveBeenCalledWith(assoManager, HOLDER);
    expect(release.mock.calls.map(([id]) => id)).toEqual([HOLDER, CLUB]);
  });

  it('markLydiaReady releases on EVERY call, replays included, and never on no holder', async () => {
    const set = jest
      .fn()
      .mockResolvedValueOnce({ kind: 'transitioned', associationId: HOLDER })
      .mockResolvedValueOnce({ kind: 'replay', associationId: HOLDER })
      .mockResolvedValueOnce({ kind: 'no-holder' });
    const products = Object.assign(Object.create(ProductsService.prototype) as object, {
      associationsService: { setLydiaReadiness: set },
      logger: new Logger('ProductsService'),
    }) as unknown as ProductsService;
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    const release = jest
      .spyOn(products, 'releaseWithheldForAssociationAndDelegates')
      .mockResolvedValue(0);
    for (let i = 0; i < 3; i++)
      await products.markLydiaReady(VENDOR, 'webhook-validated', { path: 'webhook' });
    expect(set).toHaveBeenCalledWith(VENDOR, true, 'webhook-validated', { path: 'webhook' });
    expect(release).toHaveBeenCalledTimes(2);
  });
});

describe('AssociationsService - the enrolment-in-flight marker', () => {
  function makeClaim(state: { exists: boolean; linked: string | null; startedAt: Date | null }) {
    const assoRepo = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('"lydiaEnrolmentStartedAt" = now()')) {
          const free = state.exists && !state.linked && !state.startedAt;
          if (free) state.startedAt = new Date();
          return free ? [[{ id: HOLDER }], 1] : [[], 0];
        }
        if (sql.includes('"lydiaEnrolmentStartedAt" = NULL')) {
          state.startedAt = null;
          return [[], 1];
        }
        throw new Error(`unexpected SQL: ${sql}`);
      }),
      findOne: jest.fn(async () =>
        state.exists
          ? { id: HOLDER, lydiaAccountId: state.linked, lydiaEnrolmentStartedAt: state.startedAt }
          : null
      ),
    };
    return Object.assign(Object.create(AssociationsService.prototype) as object, {
      assoRepo,
      logger: new Logger('AssociationsService'),
    }) as unknown as AssociationsService;
  }

  it('one claim wins; the second is the typed 409 IN_FLIGHT until the marker is released', async () => {
    captureLogs();
    const state = { exists: true, linked: null, startedAt: null };
    const service = makeClaim(state);
    await expect(service.claimLydiaEnrolment(HOLDER)).resolves.toBeUndefined();
    await expect(service.claimLydiaEnrolment(HOLDER)).rejects.toMatchObject({
      status: 409,
      response: { code: LYDIA_ENROLMENT_IN_FLIGHT },
    });
    await service.releaseLydiaEnrolment(HOLDER, 'refused');
    await expect(service.claimLydiaEnrolment(HOLDER)).resolves.toBeUndefined();
  });

  it('a linked Business is ALREADY_LINKED, an unknown association a 404', async () => {
    captureLogs();
    await expect(
      makeClaim({ exists: true, linked: VENDOR, startedAt: null }).claimLydiaEnrolment(HOLDER)
    ).rejects.toMatchObject({ status: 409, response: { code: LYDIA_ACCOUNT_ALREADY_LINKED } });
    await expect(
      makeClaim({ exists: false, linked: null, startedAt: null }).claimLydiaEnrolment(HOLDER)
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('AssociationsService.recordLydiaResponsable - the phone sealed, its end alone readable', () => {
  type Cashier = {
    id: string;
    userId: string;
    vendorToken: string;
    phoneSealed: string | null;
    phoneEnd: string;
    removedAt: Date | null;
  };
  let saved: string | undefined;
  beforeAll(() => {
    saved = process.env[SECRET_BOX_ENV];
    process.env[SECRET_BOX_ENV] = SECRET;
  });
  afterAll(() => {
    if (saved === undefined) delete process.env[SECRET_BOX_ENV];
    else process.env[SECRET_BOX_ENV] = saved;
  });

  function makeRecord(linked: string | null, rows: Cashier[]) {
    const query = jest.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('FOR UPDATE')) return rows.filter((r) => r.removedAt === null);
      if (sql.includes('SET "removedAt" = now()')) {
        const r = rows.find((c) => c.id === params[0])!;
        r.removedAt = new Date();
        r.phoneSealed = null;
        return [];
      }
      if (sql.includes('SET "phoneSealed" = $2')) {
        const r = rows.find((c) => c.id === params[0])!;
        r.phoneSealed = params[1] as string;
        r.phoneEnd = params[2] as string;
        return [];
      }
      if (sql.includes('INSERT INTO lydia_cashiers')) {
        rows.push({
          id: `row-${rows.length + 1}`,
          vendorToken: params[1] as string,
          userId: params[2] as string,
          phoneSealed: params[3] as string,
          phoneEnd: params[4] as string,
          removedAt: null,
        });
        return [];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const assoRepo = {
      findOne: jest.fn(async () => ({ id: HOLDER, lydiaAccountId: linked })),
      // The read-back (`lydiaResponsableOf`): the live row of that Business, never the sealed phone.
      query: jest.fn(async (_sql: string, params: unknown[]) =>
        rows
          .filter((r) => r.removedAt === null && r.vendorToken === params[1])
          .map((r) => ({ userId: r.userId, phoneEnd: r.phoneEnd, displayName: 'Ada' }))
      ),
      manager: {
        transaction: async (fn: (m: { query: typeof query }) => unknown) => fn({ query }),
      },
    };
    return Object.assign(Object.create(AssociationsService.prototype) as object, {
      assoRepo,
      logger: new Logger('AssociationsService'),
    }) as unknown as AssociationsService;
  }
  const body = (userId = 'user-1') => ({
    vendorToken: VENDOR,
    userId,
    phone: PHONE,
    addedByUserId: 'treasurer-1',
  });

  it('stores the phone SEALED, answers and logs its last two digits only', async () => {
    const logs = captureLogs();
    const rows: Cashier[] = [];
    const view = await makeRecord(VENDOR, rows).recordLydiaResponsable(HOLDER, body());
    expect(view).toEqual({ userId: 'user-1', name: 'Ada', phoneEnd: '78' });
    expect(rows).toHaveLength(1);
    expect(rows[0].phoneSealed).not.toContain('612345678');
    expect(openSecret(LYDIA_CASHIER_PHONE_PURPOSE, HOLDER, rows[0].phoneSealed!)).toBe(PHONE);
    expect(() => openSecret(LYDIA_CASHIER_PHONE_PURPOSE, CLUB, rows[0].phoneSealed!)).toThrow(
      'authentication failed'
    );
    const all = Object.values(logs).flat().join('|');
    expect(all).not.toContain('612345678');
    expect(all).toContain('phone ending 78');
  });

  it('another person while one is live is the typed 409; the same person replaces the phone', async () => {
    captureLogs();
    const rows: Cashier[] = [];
    const service = makeRecord(VENDOR, rows);
    await service.recordLydiaResponsable(HOLDER, body('user-1'));
    await expect(service.recordLydiaResponsable(HOLDER, body('user-2'))).rejects.toMatchObject({
      status: 409,
      response: { code: LYDIA_RESPONSABLE_ALREADY_SET },
    });
    await service.recordLydiaResponsable(HOLDER, { ...body('user-1'), phone: '+33600000099' });
    expect(rows).toHaveLength(1);
    expect(rows[0].phoneEnd).toBe('99');
  });

  it('a row of an EARLIER Business is closed and its phone cleared', async () => {
    captureLogs();
    const rows: Cashier[] = [
      {
        id: 'old',
        userId: 'user-9',
        vendorToken: 'an-earlier-business',
        phoneSealed: 'sealed',
        phoneEnd: '11',
        removedAt: null,
      },
    ];
    await makeRecord(VENDOR, rows).recordLydiaResponsable(HOLDER, body('user-1'));
    expect(rows[0]).toMatchObject({ phoneSealed: null });
    expect(rows[0].removedAt).not.toBeNull();
    expect(rows[1]).toMatchObject({ userId: 'user-1', vendorToken: VENDOR, removedAt: null });
  });

  it('the Business changed meanwhile: refused, nothing written', async () => {
    captureLogs();
    const rows: Cashier[] = [];
    await expect(
      makeRecord('another-business', rows).recordLydiaResponsable(HOLDER, body())
    ).rejects.toBeInstanceOf(ConflictException);
    expect(rows).toHaveLength(0);
  });
});

describe('AssociationsService - the payer`s refusal and the unlink', () => {
  function makeBare(extra: Record<string, unknown>) {
    return Object.assign(Object.create(AssociationsService.prototype) as object, {
      logger: new Logger('AssociationsService'),
      redis: { deleteByPattern: jest.fn(async () => 0) },
      ...extra,
    }) as unknown as AssociationsService;
  }

  it.each([
    [null, 'PAYMENTS_NOT_ACTIVATED'],
    ['request-refused', 'PAYMENTS_NOT_ACTIVATED'],
    ['request-blocked', 'PAYMENTS_BLOCKED'],
  ])(
    'assertPaymentsReady on a target not ready (cause %s) is the typed 409 %s',
    async (cause, code) => {
      captureLogs();
      const service = makeBare({ assoRepo: { findOne: jest.fn(async () => ({ id: HOLDER })) } });
      jest.spyOn(service, 'resolvePaymentTarget').mockResolvedValue({
        targetAssociationId: HOLDER,
        provider: 'lydia',
        connectAccountId: VENDOR,
        ready: false,
        delegated: true,
        readinessCause: cause,
      } as never);
      await expect(service.assertPaymentsReady(HOLDER)).rejects.toMatchObject({
        status: 409,
        response: { code, delegated: true },
      });
    }
  );

  it('the unlink closes the cashier rows of that Business and clears their phone', async () => {
    captureLogs();
    const query = jest.fn(async (_sql: string, _params: unknown[]) => []);
    const service = makeBare({ assoRepo: { update: jest.fn(async () => ({})), query } });
    await service.clearLydiaAccount(HOLDER);
    const closing = query.mock.calls.find(([sql]) => String(sql).includes('lydia_cashiers'));
    expect(closing?.[0]).toContain('"removedAt" = now(), "phoneSealed" = NULL');
    expect(closing?.[1]).toEqual([HOLDER]);
  });
});
