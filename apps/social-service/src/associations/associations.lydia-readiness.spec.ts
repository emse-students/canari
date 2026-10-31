import { Logger, NotFoundException } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import { In } from 'typeorm';
import { SECRET_BOX_ENV, openSecret, sealSecret } from '../common/secret-box';
import * as delegation from './payment-delegation.util';
import {
  AssociationsService,
  LYDIA_ACCOUNT_ALREADY_LINKED,
  LYDIA_BUSINESS_CHANGED,
  LYDIA_CASHIER_PHONE_PURPOSE,
  LYDIA_RESPONSABLE_ALREADY_SET,
  LYDIA_RESPONSABLE_IN_FLIGHT,
  LYDIA_RESPONSABLE_PHONE_LOCKED,
} from './associations.service';
import { AssociationProduct } from './entities/association-product.entity';
import { LYDIA_ENROLMENT_IN_FLIGHT, LYDIA_READINESS_LOG_TAG } from './lydia-readiness';
import {
  LYDIA_PAYMENTS_PAUSED_TYPE,
  LydiaPaymentsNotifier,
} from './lydia-payments-notifier.service';
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

/** The statements of `setLydiaReadiness`, answered from one in-memory row (and the global admins). */
function makeReadiness(
  row: Holder | null,
  notifier = { enabled: () => true, tell: jest.fn(async () => 1) },
  world: { enrolmentsInFlight?: number; admins?: string[] } = {}
) {
  const update = jest.fn(async () => ({ affected: 3 }));
  const find = jest.fn(async () => [{ id: CLUB }]);
  const saved: Array<Record<string, unknown>> = [];
  const manager = {
    query: jest.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('FOR UPDATE')) {
        if (!row) return [];
        const one = {
          id: row.id,
          name: 'BDE',
          ready: row.ready,
          cause: row.cause,
          at: '2026-10-01T00:00:00.000Z',
        };
        return Array.from({ length: row.holders ?? 1 }, () => one);
      }
      if (sql.includes('"lydiaEnrolmentStartedAt" IS NOT NULL')) {
        return [{ n: world.enrolmentsInFlight ?? 0 }];
      }
      if (sql.includes('RETURNING id')) {
        const ready = params[1] as boolean;
        if (!row || row.ready === ready) return [[], 0];
        row.ready = ready;
        row.cause = params[2] as string;
        return [[{ id: row.id }], 1];
      }
      if (sql.includes('SET "lydiaReadinessCause" = $2')) {
        row!.cause = params[1] as string;
        return [[], 1];
      }
      if (sql.includes('FROM users WHERE admin = true')) {
        return (world.admins ?? ['admin-1']).map((id) => ({ id }));
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }),
    update,
    find,
    create: jest.fn((_entity: unknown, fields: Record<string, unknown>) => fields),
    save: jest.fn(async (_entity: unknown, rows: Array<Record<string, unknown>>) => {
      saved.push(...rows);
      return rows;
    }),
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
  return { service, manager, update, notifier, listFlagHolders, saved };
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
    expect(error).toContain('1 global admin(s) told');
    expect(notifier.tell).toHaveBeenCalledWith(expect.anything(), 'paused', expect.anything());
  });

  it('a revert writes a bell row to EVERY global admin in its own transaction, whatever the switch', async () => {
    captureLogs();
    const off = { enabled: () => false, tell: jest.fn(async () => 0) };
    const row: Holder = { id: HOLDER, ready: true, cause: 'webhook-validated' };
    const { service, manager, saved } = makeReadiness(row, off, { admins: ['admin-1', 'admin-2'] });
    await service.setLydiaReadiness(VENDOR, false, 'request-refused', { path: 'shop' });
    expect(saved.map((r) => r.recipientId)).toEqual(['admin-1', 'admin-2']);
    expect(saved[0]).toMatchObject({
      type: LYDIA_PAYMENTS_PAUSED_TYPE,
      postId: HOLDER,
      text: 'BDE',
      meta: expect.objectContaining({ cause: 'request-refused', audience: 'global-admin' }),
    });
    // The same manager as the revert's UPDATE: one transaction, so state and report commit together.
    expect(manager.save).toHaveBeenCalledTimes(1);
    // A replay of the same refusal reports nothing again.
    await service.setLydiaReadiness(VENDOR, false, 'request-refused', { path: 'shop' });
    expect(saved).toHaveLength(2);
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

  it('a 2701 after an error-5 revert updates the cause, with no transition and no second notice', async () => {
    captureLogs();
    const row: Holder = { id: HOLDER, ready: false, cause: 'request-refused' };
    const { service, update, notifier, saved } = makeReadiness(row);
    const outcome = await service.setLydiaReadiness(VENDOR, false, 'request-blocked', {
      path: 'form',
    });
    expect(outcome.kind).toBe('replay');
    expect(row.cause).toBe('request-blocked');
    expect(update).not.toHaveBeenCalled();
    expect(notifier.tell).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
  });

  it.each(['request-refused', 'request-blocked'])(
    'an unsigned VALIDATED never clears %s: 200-style outcome, nothing written, a WARN',
    async (cause) => {
      const logs = captureLogs();
      const row: Holder = { id: HOLDER, ready: false, cause };
      const { service, manager, notifier } = makeReadiness(row);
      const outcome = await service.setLydiaReadiness(VENDOR, true, 'webhook-validated', {
        path: 'webhook',
      });
      expect(outcome).toMatchObject({ kind: 'held-by-lydia', associationId: HOLDER });
      expect(row).toMatchObject({ ready: false, cause });
      expect(manager.query).toHaveBeenCalledTimes(1);
      expect(notifier.tell).not.toHaveBeenCalled();
      expect(logs.warn.join('|')).toContain(`does not clear Lydia's own ${cause}`);
      // The global admin's validation does clear it.
      await expect(
        service.setLydiaReadiness(VENDOR, true, 'admin', { path: 'admin' })
      ).resolves.toMatchObject({ kind: 'transitioned' });
      expect(row).toMatchObject({ ready: true, cause: 'admin' });
    }
  );

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

  it('no holder while an enrolment is in flight is its own outcome (the route answers 503)', async () => {
    captureLogs();
    const { service } = makeReadiness(null, undefined, { enrolmentsInFlight: 1 });
    await expect(
      service.setLydiaReadiness(VENDOR, true, 'webhook-validated', { path: 'webhook' })
    ).resolves.toEqual({ kind: 'no-holder-enrolment-in-flight' });
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

  it('markLydiaReady releases on EVERY ready call, replays included, never when nothing is ready', async () => {
    const set = jest
      .fn()
      .mockResolvedValueOnce({ kind: 'transitioned', associationId: HOLDER })
      .mockResolvedValueOnce({ kind: 'replay', associationId: HOLDER })
      .mockResolvedValueOnce({ kind: 'no-holder' })
      .mockResolvedValueOnce({ kind: 'held-by-lydia', associationId: HOLDER })
      .mockResolvedValueOnce({ kind: 'no-holder-enrolment-in-flight' });
    const products = Object.assign(Object.create(ProductsService.prototype) as object, {
      associationsService: { setLydiaReadiness: set },
      logger: new Logger('ProductsService'),
    }) as unknown as ProductsService;
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    const release = jest
      .spyOn(products, 'releaseWithheldForAssociationAndDelegates')
      .mockResolvedValue(0);
    for (let i = 0; i < 5; i++)
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
    phoneEnd: string | null;
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

  function makeRecord(
    linked: string | null,
    rows: Cashier[],
    state = { marker: true as boolean, insertFails: false }
  ) {
    const query = jest.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM associations WHERE id = $1 FOR UPDATE')) {
        return [{ vendorToken: linked }];
      }
      if (sql.includes('FOR UPDATE')) return rows.filter((r) => r.removedAt === null);
      if (sql.includes('SET "removedAt" = now()')) {
        const r = rows.find((c) => c.id === params[0])!;
        r.removedAt = new Date();
        r.phoneSealed = null;
        r.phoneEnd = null;
        return [];
      }
      if (sql.includes('SET "confirmedAt" = now()')) return [];
      if (sql.includes('INSERT INTO lydia_cashiers')) {
        if (state.insertFails) throw Object.assign(new Error('duplicate key'), { code: '23505' });
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
      if (sql.includes('"lydiaResponsableStartedAt" = NULL')) {
        state.marker = false;
        return [];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const assoRepo = {
      // The read-back (`lydiaResponsableOf`) and the release of the step's claim.
      query: jest.fn(async (sql: string, params: unknown[]) => {
        if (sql.includes('"lydiaResponsableStartedAt" = NULL')) {
          state.marker = false;
          return [];
        }
        return rows
          .filter((r) => r.removedAt === null && r.vendorToken === params[1])
          .map((r) => ({ userId: r.userId, phoneEnd: r.phoneEnd, displayName: 'Ada' }));
      }),
      manager: {
        transaction: async (fn: (m: { query: typeof query }) => unknown) => fn({ query }),
      },
    };
    return Object.assign(Object.create(AssociationsService.prototype) as object, {
      assoRepo,
      logger: new Logger('AssociationsService'),
    }) as unknown as AssociationsService;
  }
  const body = (userId = 'user-1', phone = PHONE) => ({
    vendorToken: VENDOR,
    userId,
    phone,
    addedByUserId: 'treasurer-1',
  });

  it('stores the phone SEALED, answers and logs its last two digits only, and clears the claim', async () => {
    const logs = captureLogs();
    const rows: Cashier[] = [];
    const state = { marker: true, insertFails: false };
    const view = await makeRecord(VENDOR, rows, state).recordLydiaResponsable(HOLDER, body());
    expect(view).toEqual({ userId: 'user-1', name: 'Ada', phoneEnd: '78' });
    expect(rows).toHaveLength(1);
    expect(state.marker).toBe(false);
    expect(rows[0].phoneSealed).not.toContain('612345678');
    expect(openSecret(LYDIA_CASHIER_PHONE_PURPOSE, HOLDER, rows[0].phoneSealed!)).toBe(PHONE);
    expect(() => openSecret(LYDIA_CASHIER_PHONE_PURPOSE, CLUB, rows[0].phoneSealed!)).toThrow(
      'authentication failed'
    );
    const all = Object.values(logs).flat().join('|');
    expect(all).not.toContain('612345678');
    expect(all).toContain('phone ending 78');
  });

  it('another person is ALREADY_SET; the same person with ANOTHER number is PHONE_LOCKED, nothing replaced', async () => {
    const logs = captureLogs();
    const rows: Cashier[] = [];
    const service = makeRecord(VENDOR, rows);
    await service.recordLydiaResponsable(HOLDER, body('user-1'));
    const sealedBefore = rows[0].phoneSealed;
    await expect(service.recordLydiaResponsable(HOLDER, body('user-2'))).rejects.toMatchObject({
      status: 409,
      response: { code: LYDIA_RESPONSABLE_ALREADY_SET },
    });
    await expect(
      service.recordLydiaResponsable(HOLDER, body('user-1', '+33600000099'))
    ).rejects.toMatchObject({ status: 409, response: { code: LYDIA_RESPONSABLE_PHONE_LOCKED } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ phoneEnd: '78', phoneSealed: sealedBefore });
    // The same person and number again (a re-sent SMS) is accepted and replaces nothing.
    await expect(service.recordLydiaResponsable(HOLDER, body('user-1'))).resolves.toMatchObject({
      phoneEnd: '78',
    });
    expect(rows).toHaveLength(1);
    expect(Object.values(logs).flat().join('|')).not.toContain('600000099');
  });

  it('a concurrent insert refused by the unique index is the typed ALREADY_SET, never a bare 500', async () => {
    captureLogs();
    const state = { marker: true, insertFails: true };
    await expect(
      makeRecord(VENDOR, [], state).recordLydiaResponsable(HOLDER, body())
    ).rejects.toMatchObject({ status: 409, response: { code: LYDIA_RESPONSABLE_ALREADY_SET } });
    expect(state.marker).toBe(false);
  });

  it('a row of an EARLIER Business is closed, its phone and its end cleared', async () => {
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
    expect(rows[0]).toMatchObject({ phoneSealed: null, phoneEnd: null });
    expect(rows[0].removedAt).not.toBeNull();
    expect(rows[1]).toMatchObject({ userId: 'user-1', vendorToken: VENDOR, removedAt: null });
  });

  it('the Business changed meanwhile: the typed BUSINESS_CHANGED, nothing written, claim released', async () => {
    captureLogs();
    const rows: Cashier[] = [];
    const state = { marker: true, insertFails: false };
    await expect(
      makeRecord('another-business', rows, state).recordLydiaResponsable(HOLDER, body())
    ).rejects.toMatchObject({ status: 409, response: { code: LYDIA_BUSINESS_CHANGED } });
    expect(rows).toHaveLength(0);
    expect(state.marker).toBe(false);
  });
});

describe('AssociationsService.claimLydiaResponsable - the checks and the claim of the step', () => {
  let saved: string | undefined;
  beforeAll(() => {
    saved = process.env[SECRET_BOX_ENV];
    process.env[SECRET_BOX_ENV] = SECRET;
  });
  afterAll(() => {
    if (saved === undefined) delete process.env[SECRET_BOX_ENV];
    else process.env[SECRET_BOX_ENV] = saved;
  });

  function makeClaimant(state: {
    linked: string | null;
    member: boolean;
    live: { userId: string; phone: string } | null;
    marker: boolean;
    switchBusinessOnClaim?: boolean;
  }) {
    const assoRepo = {
      findOne: jest.fn(async () => ({ id: HOLDER, lydiaAccountId: state.linked })),
      query: jest.fn(async (sql: string, params: unknown[]) => {
        if (sql.includes('FROM lydia_cashiers')) {
          return state.live
            ? [
                {
                  userId: state.live.userId,
                  phoneSealed: sealSecret(LYDIA_CASHIER_PHONE_PURPOSE, HOLDER, state.live.phone),
                },
              ]
            : [];
        }
        if (sql.includes('"lydiaResponsableStartedAt" = now()')) {
          if (state.switchBusinessOnClaim) state.linked = 'another-business';
          const free = !state.marker && state.linked === params[1];
          if (free) state.marker = true;
          return free ? [[{ id: HOLDER }], 1] : [[], 0];
        }
        throw new Error(`unexpected SQL: ${sql}`);
      }),
    };
    const service = Object.assign(Object.create(AssociationsService.prototype) as object, {
      assoRepo,
      logger: new Logger('AssociationsService'),
    }) as unknown as AssociationsService;
    jest.spyOn(service, 'isMember').mockImplementation(async () => state.member);
    return service;
  }

  it('one claim wins; the second is the typed 409 RESPONSABLE_IN_FLIGHT', async () => {
    captureLogs();
    const state = { linked: VENDOR, member: true, live: null, marker: false };
    const service = makeClaimant(state);
    await expect(service.claimLydiaResponsable(HOLDER, 'user-1', PHONE)).resolves.toMatchObject({
      vendorToken: VENDOR,
      claimed: true,
      phoneMatches: true,
    });
    await expect(service.claimLydiaResponsable(HOLDER, 'user-1', PHONE)).rejects.toMatchObject({
      status: 409,
      response: { code: LYDIA_RESPONSABLE_IN_FLIGHT },
    });
  });

  it('the Business changing between the read and the claim is the typed BUSINESS_CHANGED', async () => {
    captureLogs();
    const state = {
      linked: VENDOR,
      member: true,
      live: null,
      marker: false,
      switchBusinessOnClaim: true,
    };
    await expect(
      makeClaimant(state).claimLydiaResponsable(HOLDER, 'user-1', PHONE)
    ).rejects.toMatchObject({ status: 409, response: { code: LYDIA_BUSINESS_CHANGED } });
  });

  it('the live Responsable with ANOTHER number is answered phoneMatches=false and NOT claimed', async () => {
    const logs = captureLogs();
    const state = {
      linked: VENDOR,
      member: true,
      live: { userId: 'user-1', phone: PHONE },
      marker: false,
    };
    const service = makeClaimant(state);
    await expect(
      service.claimLydiaResponsable(HOLDER, 'user-1', '+33600000099')
    ).resolves.toMatchObject({ currentUserId: 'user-1', phoneMatches: false, claimed: false });
    expect(state.marker).toBe(false);
    // The same number is a resend: claimed.
    await expect(service.claimLydiaResponsable(HOLDER, 'user-1', PHONE)).resolves.toMatchObject({
      phoneMatches: true,
      claimed: true,
    });
    expect(Object.values(logs).flat().join('|')).not.toContain('612345678');
  });

  it('another person, a non-member or no Business is answered and never claimed', async () => {
    captureLogs();
    for (const state of [
      { linked: VENDOR, member: true, live: { userId: 'user-2', phone: PHONE }, marker: false },
      { linked: VENDOR, member: false, live: null, marker: false },
      { linked: null, member: true, live: null, marker: false },
    ]) {
      await expect(
        makeClaimant(state).claimLydiaResponsable(HOLDER, 'user-1', PHONE)
      ).resolves.toMatchObject({ claimed: false });
      expect(state.marker).toBe(false);
    }
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
    expect(closing?.[0]).toContain('"removedAt" = now(), "phoneSealed" = NULL, "phoneEnd" = NULL');
    expect(closing?.[1]).toEqual([HOLDER]);
  });
});

describe('the Responsable codes social-service answers follow the shared contract', () => {
  it('equal libs/contracts/lydia-refusal-codes.json', () => {
    const contract = JSON.parse(
      readFileSync(
        join(__dirname, '..', '..', '..', '..', 'libs', 'contracts', 'lydia-refusal-codes.json'),
        'utf8'
      )
    ) as { social: Record<string, string> };
    expect({
      responsableAlreadySet: LYDIA_RESPONSABLE_ALREADY_SET,
      responsablePhoneLocked: LYDIA_RESPONSABLE_PHONE_LOCKED,
      responsableInFlight: LYDIA_RESPONSABLE_IN_FLIGHT,
      businessChanged: LYDIA_BUSINESS_CHANGED,
    }).toEqual({
      responsableAlreadySet: contract.social.responsableAlreadySet,
      responsablePhoneLocked: contract.social.responsablePhoneLocked,
      responsableInFlight: contract.social.responsableInFlight,
      businessChanged: contract.social.businessChanged,
    });
  });
});
