import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import {
  LYDIA_CASHIER_ALREADY_SET,
  LYDIA_CASHIER_IN_FLIGHT,
  LYDIA_CASHIER_LAST_HOLDER,
  LYDIA_CASHIER_NO_HOLDER,
  LYDIA_CASHIER_NOT_A_MEMBER,
  LYDIA_CASHIER_NOT_FOUND,
  LYDIA_CASHIER_PHONE_IN_USE,
  LYDIA_CASHIER_ROLE_FIXED,
  LYDIA_NO_BUSINESS,
  LydiaCashiersService,
} from './lydia-cashiers.service';
import {
  LYDIA_CASHIER_ADDED_TYPE,
  LYDIA_CASHIER_NOTIFICATIONS_ENABLED,
  LydiaCashierNotifier,
} from './lydia-payments-notifier.service';
import { LYDIA_CASHIER_PHONE_PURPOSE } from './associations.service';
import { SECRET_BOX_ENV, sealSecret } from '../common/secret-box';

const CONTRACT = JSON.parse(
  readFileSync(
    join(__dirname, '..', '..', '..', '..', 'libs', 'contracts', 'lydia-refusal-codes.json'),
    'utf8'
  )
) as {
  core: Record<string, string>;
  social: Record<string, string>;
  notificationTypes: Record<string, string>;
};

const ASSO = '00000000-0000-4000-8000-0000000000c1';
const HOLDER_PHONE = '+33698765432';
const PHONE = '+33612345678';
const OLD = '+33612345600';

describe('the lot 3 codes social-service answers follow the shared contract', () => {
  it('every cashier code, and the notification type', () => {
    expect({
      cashierInFlight: LYDIA_CASHIER_IN_FLIGHT,
      cashierNotAMember: LYDIA_CASHIER_NOT_A_MEMBER,
      cashierAlreadySet: LYDIA_CASHIER_ALREADY_SET,
      cashierPhoneInUse: LYDIA_CASHIER_PHONE_IN_USE,
      cashierNoHolder: LYDIA_CASHIER_NO_HOLDER,
      cashierLastHolder: LYDIA_CASHIER_LAST_HOLDER,
      cashierNotFound: LYDIA_CASHIER_NOT_FOUND,
      cashierRoleFixed: LYDIA_CASHIER_ROLE_FIXED,
    }).toEqual(
      Object.fromEntries(
        Object.entries(CONTRACT.social).filter(([key]) => key.startsWith('cashier'))
      )
    );
    expect(LYDIA_NO_BUSINESS).toBe(CONTRACT.core.noBusiness);
    expect(LYDIA_CASHIER_ADDED_TYPE).toBe(CONTRACT.notificationTypes.cashierAdded);
  });
});

describe('LydiaCashierNotifier - the gate', () => {
  it('ships OFF until the floor version serves the new type: nothing written', async () => {
    expect(LYDIA_CASHIER_NOTIFICATIONS_ENABLED).toBe(false);
    const notifications = { createNotifications: jest.fn() };
    const notifier = new LydiaCashierNotifier(notifications as never);
    await expect(notifier.tellAdded({ id: ASSO, name: 'BDE' }, 'u2')).resolves.toBe(0);
    expect(notifications.createNotifications).not.toHaveBeenCalled();
  });

  it('switched on: ONE bell row to the added member, naming the association, no push', async () => {
    const notifications = { createNotifications: jest.fn(async () => 1) };
    const notifier = new LydiaCashierNotifier(notifications as never);
    jest.spyOn(notifier, 'enabled').mockReturnValue(true);
    await notifier.tellAdded({ id: ASSO, name: 'BDE' }, 'u2');
    expect(notifications.createNotifications).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientIds: ['u2'],
        type: LYDIA_CASHIER_ADDED_TYPE,
        postId: ASSO,
        text: 'BDE',
        skipPush: true,
      })
    );
  });
});

describe('LydiaCashiersService - the checks, with a mocked database', () => {
  let saved: string | undefined;
  beforeAll(() => {
    saved = process.env[SECRET_BOX_ENV];
    process.env[SECRET_BOX_ENV] = 'unit-test-secret-0123456789abcdefghij';
  });
  afterAll(() => {
    if (saved === undefined) delete process.env[SECRET_BOX_ENV];
    else process.env[SECRET_BOX_ENV] = saved;
  });
  beforeEach(() => {
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });
  afterEach(() => jest.restoreAllMocks());

  const seal = (phone: string) => sealSecret(LYDIA_CASHIER_PHONE_PURPOSE, ASSO, phone);

  type Row = {
    id: string;
    userId: string;
    role: string;
    phoneSealed: string | null;
    previousPhoneSealed: string | null;
    confirmedAt: Date | null;
    associationId?: string;
    vendorToken?: string;
  };

  function make(rows: Row[], opts: { member?: boolean; claimWins?: boolean; core?: unknown } = {}) {
    const query = jest.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM lydia_cashiers') && sql.includes('"vendorToken" = $2')) return rows;
      if (sql.includes('FROM lydia_cashiers c') && sql.includes('"userId" = $1')) {
        return rows
          .filter((r) => r.userId === params[0])
          .map((r) => ({ ...r, associationId: ASSO, vendorToken: 'vendor-1' }));
      }
      if (sql.includes('"lydiaResponsableStartedAt" = now()')) {
        return opts.claimWins === false ? [] : [{ id: ASSO }];
      }
      return [];
    });
    const associations = {
      lydiaVendorTokenOf: jest.fn(async () => 'vendor-1'),
      isMember: jest.fn(async () => opts.member ?? true),
    };
    const httpService = {
      post: jest.fn(() =>
        opts.core instanceof Error ? throwError(() => opts.core) : of({ data: opts.core })
      ),
    };
    const service = new LydiaCashiersService(
      { query, manager: { transaction: jest.fn() } } as never,
      associations as never,
      { tellAdded: jest.fn() } as never,
      httpService as never
    );
    return { service, query, httpService };
  }

  const responsable = (over: Partial<Row> = {}): Row => ({
    id: 'r1',
    userId: 'u1',
    role: 'responsable',
    phoneSealed: seal(HOLDER_PHONE),
    previousPhoneSealed: null,
    confirmedAt: new Date(),
    ...over,
  });
  const vendeur = (over: Partial<Row> = {}): Row => ({
    id: 'v1',
    userId: 'u2',
    role: 'vendeur',
    phoneSealed: seal(PHONE),
    previousPhoneSealed: null,
    confirmedAt: new Date(),
    ...over,
  });

  it('an add of a member is claimed and answers the Business', async () => {
    const { service } = make([responsable()]);
    await expect(
      service.claimAdd(ASSO, { userId: 'u3', phone: '+33600000001', role: 'vendeur' })
    ).resolves.toEqual({ vendorToken: 'vendor-1' });
  });

  it('a non-member, a member already a cashier, and a number already used are each refused, typed', async () => {
    await expect(
      make([responsable()], { member: false }).service.claimAdd(ASSO, {
        userId: 'u3',
        phone: '+33600000001',
        role: 'vendeur',
      })
    ).rejects.toMatchObject({ response: { code: LYDIA_CASHIER_NOT_A_MEMBER } });
    await expect(
      make([responsable(), vendeur()]).service.claimAdd(ASSO, {
        userId: 'u2',
        phone: '+33600000001',
        role: 'tresorier',
      })
    ).rejects.toMatchObject({ response: { code: LYDIA_CASHIER_ALREADY_SET } });
    // The Responsable's own number: Lydia would REPLACE their 13 rights with a Vendeur's.
    await expect(
      make([responsable()]).service.claimAdd(ASSO, {
        userId: 'u3',
        phone: HOLDER_PHONE,
        role: 'vendeur',
      })
    ).rejects.toMatchObject({ response: { code: LYDIA_CASHIER_PHONE_IN_USE } });
  });

  it('no confirmed Responsable: nobody could remove the cashier, so no add', async () => {
    await expect(
      make([responsable({ confirmedAt: null })]).service.claimAdd(ASSO, {
        userId: 'u3',
        phone: '+33600000001',
        role: 'vendeur',
      })
    ).rejects.toMatchObject({ response: { code: LYDIA_CASHIER_NO_HOLDER } });
  });

  it('another operation holds the claim: the typed IN_FLIGHT', async () => {
    await expect(
      make([responsable()], { claimWins: false }).service.claimAdd(ASSO, {
        userId: 'u3',
        phone: '+33600000001',
        role: 'vendeur',
      })
    ).rejects.toMatchObject({ response: { code: LYDIA_CASHIER_IN_FLIGHT } });
  });

  it('the last-holder guard: the Responsable CURRENT number is never removed', async () => {
    const { service, query } = make([responsable()]);
    await expect(
      service.claimRevoke(ASSO, { cashierId: 'r1', number: 'current' })
    ).rejects.toMatchObject({
      response: { code: LYDIA_CASHIER_LAST_HOLDER },
    });
    expect(query.mock.calls.some(([sql]) => String(sql).includes('= now()'))).toBe(false);
  });

  it('a Vendeur and the Responsable old number are each claimed with the confirmed Responsable number', async () => {
    const rows = [responsable({ previousPhoneSealed: seal(OLD) }), vendeur()];
    const { service } = make(rows);
    await expect(
      service.claimRevoke(ASSO, { cashierId: 'v1', number: 'current' })
    ).resolves.toEqual({
      vendorToken: 'vendor-1',
      cashierPhone: PHONE,
      actorPhone: HOLDER_PHONE,
    });
    await expect(
      service.claimRevoke(ASSO, { cashierId: 'r1', number: 'previous' })
    ).resolves.toEqual({
      vendorToken: 'vendor-1',
      cashierPhone: OLD,
      actorPhone: HOLDER_PHONE,
    });
  });

  it('the Responsable role is never changed through a role change', async () => {
    await expect(
      make([responsable()]).service.claimRoleChange(ASSO, { cashierId: 'r1', role: 'vendeur' })
    ).rejects.toMatchObject({ response: { code: LYDIA_CASHIER_ROLE_FIXED } });
  });

  it('erasure: the cashier numbers are asked removed, a confirmed one is reported cleared', async () => {
    const { service, httpService } = make([responsable(), vendeur()], {
      core: { verified: true, held: 0 },
    });
    const cleared = await service.revokeBeforeErasure('u2');
    expect(httpService.post).toHaveBeenCalled();
    const [, body] = httpService.post.mock.calls[0] as unknown as [string, Record<string, string>];
    expect(body).toMatchObject({ actorPhone: HOLDER_PHONE, vendorToken: 'vendor-1' });
    expect(cleared).toEqual(new Set([`${ASSO}:vendor-1`]));
  });

  it('erasure NEVER blocks: core unreachable resolves, nothing reported cleared', async () => {
    const { service } = make([responsable(), vendeur()], { core: new Error('ECONNREFUSED') });
    await expect(service.revokeBeforeErasure('u2')).resolves.toEqual(new Set());
  });

  it('erasure of the Responsable: its current number is NOT removed (nobody else manages the Business)', async () => {
    const { service, httpService } = make([responsable()], { core: { verified: true, held: 0 } });
    await expect(service.revokeBeforeErasure('u1')).resolves.toEqual(new Set());
    expect(httpService.post).not.toHaveBeenCalled();
  });
});
