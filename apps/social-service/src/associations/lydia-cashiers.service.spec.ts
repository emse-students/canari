import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import {
  LYDIA_CASHIER_ALREADY_SET,
  LYDIA_CASHIER_IN_FLIGHT,
  LYDIA_CASHIER_RESPONSABLE_NUMBER,
  LYDIA_CASHIER_NO_RESPONSABLE,
  LYDIA_CASHIER_NOT_A_MEMBER,
  LYDIA_CASHIER_NOT_FOUND,
  LYDIA_CASHIER_PHONE_IN_USE,
  LYDIA_CASHIER_ROLE_FIXED,
  LYDIA_NO_BUSINESS,
  LydiaCashiersService,
  LYDIA_CASHIERS_LIVE,
  ERASURE_REVOKE_TIMEOUT_MS,
} from './lydia-cashiers.service';
import {
  LYDIA_CASHIER_ADDED_TYPE,
  LYDIA_RESPONSABLE_HANDED_OVER_TYPE,
  LYDIA_CASHIER_NOTIFICATIONS_ENABLED,
  LydiaCashierNotifier,
} from './lydia-payments-notifier.service';
import { LYDIA_CASHIER_PHONE_PURPOSE } from './associations.service';
import { LYDIA_RESPONSABLE_HANDOVER_DISABLED } from './lydia-responsable-handover';
import { SECRET_BOX_ENV, sealSecret } from '../common/secret-box';
import {
  LYDIA_CASHIER_CLAIM_LOST,
  LYDIA_CASHIER_CONFIRMED_REQUIRED,
  LYDIA_CASHIER_NUMBER_CHANGED,
} from './lydia-cashier-claim';

const CONTRACT = JSON.parse(
  readFileSync(
    join(__dirname, '..', '..', '..', '..', 'libs', 'contracts', 'lydia-refusal-codes.json'),
    'utf8'
  )
) as {
  core: Record<string, string>;
  social: Record<string, string>;
  notificationTypes: Record<string, string>;
  timeouts: { cashierRemovalWaitMs: number };
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
      cashierNoResponsable: LYDIA_CASHIER_NO_RESPONSABLE,
      cashierResponsableNumber: LYDIA_CASHIER_RESPONSABLE_NUMBER,
      cashierNotFound: LYDIA_CASHIER_NOT_FOUND,
      cashierRoleFixed: LYDIA_CASHIER_ROLE_FIXED,
      cashierClaimLost: LYDIA_CASHIER_CLAIM_LOST,
      cashierNumberChanged: LYDIA_CASHIER_NUMBER_CHANGED,
      cashierConfirmedRequired: LYDIA_CASHIER_CONFIRMED_REQUIRED,
      cashiersLiveOnDelete: LYDIA_CASHIERS_LIVE,
    }).toEqual(
      Object.fromEntries(
        Object.entries(CONTRACT.social).filter(([key]) => key.startsWith('cashier'))
      )
    );
    expect(LYDIA_NO_BUSINESS).toBe(CONTRACT.core.noBusiness);
    expect(LYDIA_CASHIER_ADDED_TYPE).toBe(CONTRACT.notificationTypes.cashierAdded);
    expect(LYDIA_RESPONSABLE_HANDED_OVER_TYPE).toBe(
      CONTRACT.notificationTypes.responsableHandedOver
    );
  });

  it('waits for core exactly as long as core bounds a removal under (its three calls answer first)', () => {
    expect(ERASURE_REVOKE_TIMEOUT_MS).toBe(CONTRACT.timeouts.cashierRemovalWaitMs);
  });
});

describe('LydiaCashierNotifier - the gate', () => {
  it('ships ON since the 1.7.0 floor; the kill switch off writes nothing', async () => {
    expect(LYDIA_CASHIER_NOTIFICATIONS_ENABLED).toBe(true);
    expect(new LydiaCashierNotifier({} as never).enabled()).toBe(true);
    const notifications = { createNotifications: jest.fn() };
    const notifier = new LydiaCashierNotifier(notifications as never);
    jest.spyOn(notifier, 'enabled').mockReturnValue(false);
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
  const TOKEN = '7d0c3b1a-5e2f-4a6b-9c8d-0e1f2a3b4c5d';
  const STRANGER = '11111111-2222-4333-8444-555555555555';

  type Row = {
    id: string;
    userId: string;
    role: string;
    phoneSealed: string | null;
    previousPhoneSealed: string | null;
    confirmedAt: Date | null;
    revokeUnconfirmedAt?: Date | null;
    previousRevokeUnconfirmedAt?: Date | null;
    removedAt?: Date | null;
  };
  /** The association row: its Business and the one cashier claim with its token. */
  type Asso = { vendorToken: string | null; claimed: boolean; token: string | null };

  /**
   * An in-memory association row and its cashier rows answering the SQL the service sends, in a
   * transaction or not (the fake does not roll back: a test that needs that asserts no write came
   * before the refusal).
   */
  function make(
    rows: Row[],
    opts: {
      member?: boolean;
      core?: unknown;
      asso?: Partial<Asso>;
      notifier?: unknown;
      /** The users who are no longer members of the association (the departure debt). */
      departed?: string[];
    } = {}
  ) {
    const asso: Asso = { vendorToken: 'vendor-1', claimed: false, token: null, ...opts.asso };
    const live = () => rows.filter((r) => !r.removedAt);
    const byId = (id: unknown) => rows.find((r) => r.id === id && !r.removedAt);
    const query = jest.fn(async (sql: string, params: unknown[] = []): Promise<unknown> => {
      if (sql.includes('WHERE a.id = $1 FOR UPDATE OF a')) {
        return [
          {
            vendorToken: asso.vendorToken,
            startedAt: asso.claimed ? new Date() : null,
            claimToken: asso.token,
          },
        ];
      }
      if (sql.includes('"lydiaResponsableStartedAt" = now(), "lydiaCashierClaimToken" = $2')) {
        asso.claimed = true;
        asso.token = params[1] as string;
        return [];
      }
      if (sql.includes('"lydiaResponsableStartedAt" = NULL, "lydiaCashierClaimToken" = NULL')) {
        if (asso.token === null || asso.token !== params[1]) return [];
        asso.claimed = false;
        asso.token = null;
        return [{ id: ASSO }];
      }
      if (sql.includes('AS "hasPrevious"')) {
        return live()
          .filter((r) => (opts.departed ?? []).includes(r.userId))
          .map((r) => ({
            id: r.id,
            userId: r.userId,
            role: r.role,
            hasPrevious: r.previousPhoneSealed !== null,
            currentUntried: r.role !== 'responsable' && !r.revokeUnconfirmedAt,
            previousUntried: r.previousPhoneSealed !== null && !r.previousRevokeUnconfirmedAt,
          }));
      }
      if (sql.includes('SELECT 1 FROM association_members WHERE')) {
        return (opts.departed ?? []).includes(params[1] as string) ? [] : [{ '?column?': 1 }];
      }
      if (sql.includes('INSERT INTO lydia_cashiers')) {
        rows.push({
          id: 'n1',
          userId: params[2] as string,
          role: params[5] as string,
          phoneSealed: params[3] as string,
          previousPhoneSealed: null,
          confirmedAt: params[7] ? new Date() : null,
        });
        return [{ id: 'n1' }];
      }
      if (sql.includes('SELECT name FROM associations')) return [{ name: 'BDE' }];
      if (sql.includes('ORDER BY id') && sql.includes('FOR UPDATE')) return live();
      if (sql.includes('WHERE c."userId" = $1')) {
        return live()
          .filter((r) => r.userId === params[0])
          .map((r) => ({ id: r.id, associationId: ASSO, vendorToken: 'vendor-1' }));
      }
      if (sql.includes(`AND role <> 'responsable'`)) {
        const r = byId(params[0]);
        return r && r.role !== 'responsable' ? [{ phoneSealed: r.phoneSealed }] : [];
      }
      if (sql.includes('SELECT "phoneSealed", "previousPhoneSealed" FROM lydia_cashiers')) {
        const r = byId(params[0]);
        return r
          ? [{ phoneSealed: r.phoneSealed, previousPhoneSealed: r.previousPhoneSealed }]
          : [];
      }
      if (sql.includes('SET role = $3')) {
        Object.assign(byId(params[0])!, {
          role: params[2],
          confirmedAt: params[3] ? new Date() : null,
          revokeUnconfirmedAt: null,
        });
        return [];
      }
      if (sql.includes('SET "removedAt" = now()')) {
        Object.assign(byId(params[0])!, {
          removedAt: new Date(),
          phoneSealed: null,
          previousPhoneSealed: null,
        });
        return [{ id: params[0] }];
      }
      if (sql.includes('SET "revokeUnconfirmedAt" = now()')) {
        byId(params[0])!.revokeUnconfirmedAt = new Date();
        return [{ id: params[0] }];
      }
      if (sql.includes('SET "previousRevokeUnconfirmedAt" = now()')) {
        byId(params[0])!.previousRevokeUnconfirmedAt = new Date();
        return [{ id: params[0] }];
      }
      if (sql.includes('SET "previousPhoneSealed" = NULL')) {
        byId(params[0])!.previousPhoneSealed = null;
        return [{ id: params[0] }];
      }
      if (sql.includes('LEFT JOIN users a')) {
        return live().map((r) => ({
          id: r.id,
          userId: r.userId,
          role: r.role,
          phoneEnd: '00',
          previousPhoneEnd: null,
          addedAt: new Date().toISOString(),
          confirmed: r.confirmedAt != null,
          revokeUnconfirmed: r.revokeUnconfirmedAt != null,
        }));
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const associations = { isMember: jest.fn(async () => opts.member ?? true) };
    const httpService = {
      post: jest.fn(() =>
        opts.core instanceof Error ? throwError(() => opts.core) : of({ data: opts.core })
      ),
    };
    const service = new LydiaCashiersService(
      {
        query,
        manager: { transaction: async (fn: (m: unknown) => unknown) => fn({ query }) },
      } as never,
      associations as never,
      (opts.notifier ?? { tellAdded: jest.fn() }) as never,
      httpService as never
    );
    return { service, query, httpService, asso };
  }
  const writes = (query: jest.Mock) =>
    query.mock.calls.filter(([sql]) => /UPDATE lydia_cashiers|INSERT/.test(String(sql)));

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
  const add = { userId: 'u3', phone: '+33600000001', role: 'vendeur' };

  it('an add of a member is claimed in the locking transaction and answers the Business and a token', async () => {
    const { service, asso } = make([responsable()]);
    const claim = await service.claimAdd(ASSO, add);
    expect(claim).toEqual({ vendorToken: 'vendor-1', claimToken: asso.token });
    expect(claim.claimToken).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('a non-member, a member already a cashier, and a number already used are each refused, typed, nothing claimed', async () => {
    const cases: Array<[ReturnType<typeof make>, typeof add, string]> = [
      [make([responsable()], { member: false }), add, LYDIA_CASHIER_NOT_A_MEMBER],
      [make([responsable(), vendeur()]), { ...add, userId: 'u2' }, LYDIA_CASHIER_ALREADY_SET],
      // The Responsable's own number is refused.
      [make([responsable()]), { ...add, phone: HOLDER_PHONE }, LYDIA_CASHIER_PHONE_IN_USE],
      // ... and the Responsable's OTHER number too.
      [
        make([responsable({ previousPhoneSealed: seal(OLD) })]),
        { ...add, phone: OLD },
        LYDIA_CASHIER_PHONE_IN_USE,
      ],
    ];
    for (const [{ service, asso }, input, code] of cases) {
      await expect(service.claimAdd(ASSO, input)).rejects.toMatchObject({ response: { code } });
      expect(asso.claimed).toBe(false);
    }
  });

  it('no confirmed Responsable: no add', async () => {
    await expect(
      make([responsable({ confirmedAt: null })]).service.claimAdd(ASSO, add)
    ).rejects.toMatchObject({ response: { code: LYDIA_CASHIER_NO_RESPONSABLE } });
  });

  it('no Business linked: the typed NO_BUSINESS', async () => {
    await expect(
      make([], { asso: { vendorToken: null } }).service.claimAdd(ASSO, add)
    ).rejects.toMatchObject({ response: { code: LYDIA_NO_BUSINESS } });
  });

  it('another operation holds the claim: the typed IN_FLIGHT, its token untouched', async () => {
    const { service, asso } = make([responsable()], {
      asso: { claimed: true, token: STRANGER },
    });
    await expect(service.claimAdd(ASSO, add)).rejects.toMatchObject({
      response: { code: LYDIA_CASHIER_IN_FLIGHT },
    });
    expect(asso.token).toBe(STRANGER);
  });

  it('a release clears the claim only with ITS token', async () => {
    const { service, asso } = make([], { asso: { claimed: true, token: TOKEN } });
    await expect(service.release(ASSO, STRANGER)).resolves.toBe(false);
    expect(asso.claimed).toBe(true);
    await expect(service.release(ASSO, TOKEN)).resolves.toBe(true);
    expect(asso).toMatchObject({ claimed: false, token: null });
  });

  it("the Responsable's current number is never removed", async () => {
    const { service, query, asso } = make([responsable()]);
    await expect(
      service.claimRevoke(ASSO, { cashierId: 'r1', number: 'current' })
    ).rejects.toMatchObject({ response: { code: LYDIA_CASHIER_RESPONSABLE_NUMBER } });
    expect(asso.claimed).toBe(false);
    expect(writes(query)).toHaveLength(0);
  });

  it('a Vendeur and the Responsable other number are each claimed with the confirmed Responsable number', async () => {
    const rows = [responsable({ previousPhoneSealed: seal(OLD) }), vendeur()];
    const { service, asso } = make(rows);
    const first = await service.claimRevoke(ASSO, { cashierId: 'v1', number: 'current' });
    expect(first).toEqual({
      vendorToken: 'vendor-1',
      cashierPhone: PHONE,
      contextPhone: HOLDER_PHONE,
      claimToken: asso.token,
    });
    await service.release(ASSO, first.claimToken);
    await expect(
      service.claimRevoke(ASSO, { cashierId: 'r1', number: 'previous' })
    ).resolves.toMatchObject({ cashierPhone: OLD, contextPhone: HOLDER_PHONE });
  });

  it('a role change of a row holding one of the Responsable numbers is PHONE_IN_USE, nothing claimed', async () => {
    for (const rows of [
      [responsable(), vendeur({ phoneSealed: seal(HOLDER_PHONE) })],
      [responsable({ previousPhoneSealed: seal(PHONE) }), vendeur()],
    ]) {
      const { service, asso } = make(rows);
      await expect(
        service.claimRoleChange(ASSO, { cashierId: 'v1', role: 'tresorier' })
      ).rejects.toMatchObject({ response: { code: LYDIA_CASHIER_PHONE_IN_USE } });
      expect(asso.claimed).toBe(false);
    }
  });

  it('a role change of a cashier who left the association is NOT_A_MEMBER, the claim released', async () => {
    const { service, asso } = make([responsable(), vendeur()], { member: false });
    await expect(
      service.claimRoleChange(ASSO, { cashierId: 'v1', role: 'tresorier' })
    ).rejects.toMatchObject({ response: { code: LYDIA_CASHIER_NOT_A_MEMBER } });
    expect(asso).toMatchObject({ claimed: false, token: null });
  });

  it('the Responsable role is never changed through a role change', async () => {
    await expect(
      make([responsable()]).service.claimRoleChange(ASSO, { cashierId: 'r1', role: 'vendeur' })
    ).rejects.toMatchObject({ response: { code: LYDIA_CASHIER_ROLE_FIXED } });
  });

  const roleRecord = (phone = PHONE, claimToken: unknown = TOKEN, confirmed: unknown = true) => ({
    vendorToken: 'vendor-1',
    userId: 'u2',
    phone,
    role: 'tresorier',
    addedByUserId: 'u1',
    confirmed,
    cashierId: 'v1',
    claimToken,
  });

  it('a confirmed add with the cashier kill switch off logs nothing at WARN or ERROR', async () => {
    // The beforeEach spies, read back (spyOn on a spied method answers the same spy).
    const warn = jest.spyOn(Logger.prototype, 'warn');
    const error = jest.spyOn(Logger.prototype, 'error');
    const log = jest.spyOn(Logger.prototype, 'log');
    const rows = [responsable()];
    const notifications = { createNotifications: jest.fn() };
    const notifier = new LydiaCashierNotifier(notifications as never);
    jest.spyOn(notifier, 'enabled').mockReturnValue(false);
    const { service, asso } = make(rows, {
      asso: { claimed: true, token: TOKEN },
      notifier,
    });
    await expect(
      service.record(ASSO, { ...roleRecord(PHONE), role: 'vendeur', cashierId: undefined })
    ).resolves.toMatchObject({ id: 'n1', role: 'vendeur', state: 'confirmed' });
    expect(notifications.createNotifications).not.toHaveBeenCalled();
    expect(asso).toMatchObject({ claimed: false, token: null });
    // A switched-off notice is a designed state, said at debug: no line at WARN or ERROR.
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(String(log.mock.calls)).toContain('[AUDIT] Lydia cashier added');
  });

  it('a role change recorded on the same number clears the removal flag and the claim', async () => {
    const rows = [responsable(), vendeur({ revokeUnconfirmedAt: new Date() })];
    const { service, asso } = make(rows, { asso: { claimed: true, token: TOKEN } });
    await expect(service.record(ASSO, roleRecord())).resolves.toMatchObject({
      id: 'v1',
      role: 'tresorier',
      state: 'confirmed',
    });
    expect(rows[1]).toMatchObject({ role: 'tresorier', revokeUnconfirmedAt: null });
    expect(asso).toMatchObject({ claimed: false, token: null });
  });

  it('a role change whose row no longer holds the number Lydia was asked about is NUMBER_CHANGED, nothing written, claim released', async () => {
    const rows = [responsable(), vendeur()];
    const { service, query, asso } = make(rows, { asso: { claimed: true, token: TOKEN } });
    await expect(service.record(ASSO, roleRecord('+33600000077'))).rejects.toMatchObject({
      status: 409,
      response: { code: LYDIA_CASHIER_NUMBER_CHANGED },
    });
    expect(writes(query)).toHaveLength(0);
    expect(asso.claimed).toBe(false);
  });

  it('a record whose claim token is not the association`s is CLAIM_LOST, nothing written, the other claim kept', async () => {
    const { service, query, asso } = make([responsable(), vendeur()], {
      asso: { claimed: true, token: STRANGER },
    });
    await expect(service.record(ASSO, roleRecord())).rejects.toMatchObject({
      status: 409,
      response: { code: LYDIA_CASHIER_CLAIM_LOST },
    });
    expect(writes(query)).toHaveLength(0);
    expect(asso.token).toBe(STRANGER);
  });

  it.each([
    ['absent', undefined],
    ['not a boolean', 'true'],
  ])(
    'a record whose `confirmed` is %s is the typed 400 CONFIRMED_REQUIRED, the claim released',
    async (_w, value) => {
      const { service, query, asso } = make([responsable(), vendeur()], {
        asso: { claimed: true, token: TOKEN },
      });
      await expect(
        service.record(ASSO, { ...roleRecord(), confirmed: value })
      ).rejects.toMatchObject({
        status: 400,
        response: { code: LYDIA_CASHIER_CONFIRMED_REQUIRED },
      });
      expect(writes(query)).toHaveLength(0);
      expect(asso).toMatchObject({ claimed: false, token: null });
    }
  );

  const revoke = (over: Record<string, unknown> = {}) => ({
    cashierId: 'v1',
    number: 'current' as const,
    verified: true,
    actorId: 'u1',
    cashierPhone: PHONE,
    claimToken: TOKEN,
    ...over,
  });

  it('a verified removal closes the row and releases the claim', async () => {
    const rows = [responsable(), vendeur()];
    const { service, asso } = make(rows, { asso: { claimed: true, token: TOKEN } });
    await service.recordRevoke(ASSO, revoke());
    expect(rows[1].removedAt).toBeInstanceOf(Date);
    expect(asso.claimed).toBe(false);
  });

  it('a removal recorded against a number the row no longer holds is NUMBER_CHANGED, nothing written, claim released', async () => {
    const rows = [responsable({ previousPhoneSealed: seal(OLD) }), vendeur()];
    const { service, query, asso } = make(rows, { asso: { claimed: true, token: TOKEN } });
    await expect(
      service.recordRevoke(
        ASSO,
        revoke({ cashierId: 'r1', number: 'previous', cashierPhone: PHONE })
      )
    ).rejects.toMatchObject({ response: { code: LYDIA_CASHIER_NUMBER_CHANGED } });
    expect(writes(query)).toHaveLength(0);
    expect(rows[0].previousPhoneSealed).not.toBeNull();
    expect(asso.claimed).toBe(false);
  });

  it('a removal recorded under a lost claim is CLAIM_LOST, nothing written', async () => {
    const rows = [responsable(), vendeur()];
    const { service, query } = make(rows, { asso: { claimed: true, token: STRANGER } });
    await expect(service.recordRevoke(ASSO, revoke())).rejects.toMatchObject({
      response: { code: LYDIA_CASHIER_CLAIM_LOST },
    });
    expect(writes(query)).toHaveLength(0);
  });

  describe('settleDepartures - a membership that ended owes its Lydia rights', () => {
    const levels = () => ({
      log: jest.spyOn(Logger.prototype, 'log'),
      warn: jest.spyOn(Logger.prototype, 'warn'),
      error: jest.spyOn(Logger.prototype, 'error'),
    });
    const corePosts = (httpService: { post: jest.Mock }) =>
      httpService.post.mock.calls.map(([, body]) => body as Record<string, string>);

    it('a departed Vendeur: the verified removal, reason departure, the row closed, the claim released', async () => {
      const spy = levels();
      const rows = [responsable(), vendeur()];
      const { service, httpService, asso } = make(rows, {
        core: { verified: true, held: 0 },
        departed: ['u2'],
      });
      await service.settleDepartures(ASSO, 'departure');
      expect(corePosts(httpService)).toEqual([
        expect.objectContaining({
          associationId: ASSO,
          contextPhone: HOLDER_PHONE,
          cashierPhone: PHONE,
          reason: 'departure',
        }),
      ]);
      expect(rows[1].removedAt).toBeInstanceOf(Date);
      expect(rows[0].removedAt).toBeUndefined();
      expect(asso).toMatchObject({ claimed: false, token: null });
      expect(spy.error).not.toHaveBeenCalled();
      expect(String(spy.log.mock.calls)).toContain('confirmed by Lydia (0 rights)');
    });

    it('Lydia still shows rights: the row stays live, FLAGGED, at ERROR - a card read does not ask again, a new departure does', async () => {
      const spy = levels();
      const rows = [responsable(), vendeur()];
      const { service, httpService, asso } = make(rows, {
        core: { verified: false, held: 1 },
        departed: ['u2'],
      });
      await service.settleDepartures(ASSO, 'departure');
      expect(rows[1].removedAt).toBeUndefined();
      expect(rows[1].revokeUnconfirmedAt).toBeInstanceOf(Date);
      expect(asso.claimed).toBe(false);
      expect(String(spy.error.mock.calls)).toContain('NOT confirmed by Lydia');
      // Flagged on the card: a read or a release never calls Lydia, nor holds the claim, for it.
      await service.settleDepartures(ASSO, 'payout-read');
      await service.settleDepartures(ASSO, 'claim-released');
      expect(httpService.post).toHaveBeenCalledTimes(1);
      await service.settleDepartures(ASSO, 'departure');
      expect(httpService.post).toHaveBeenCalledTimes(2);
    });

    it('core does not answer: the outcome is unknown, so it is recorded NOT confirmed, never as removed', async () => {
      const rows = [responsable(), vendeur()];
      const { service } = make(rows, { core: new Error('socket hang up'), departed: ['u2'] });
      await service.settleDepartures(ASSO, 'departure');
      expect(rows[1].removedAt).toBeUndefined();
      expect(rows[1].revokeUnconfirmedAt).toBeInstanceOf(Date);
    });

    it('core refuses (an HTTP answer): recorded NOT confirmed so the card shows it, the claim released, still owed', async () => {
      const spy = levels();
      const refusal = Object.assign(new Error('409'), { response: { status: 409, data: {} } });
      const rows = [responsable(), vendeur()];
      const { service, httpService, asso } = make(rows, { core: refusal, departed: ['u2'] });
      await service.settleDepartures(ASSO, 'departure');
      expect(rows[1].removedAt).toBeUndefined();
      expect(rows[1].revokeUnconfirmedAt).toBeInstanceOf(Date);
      expect(asso).toMatchObject({ claimed: false, token: null });
      expect(String(spy.warn.mock.calls)).toContain('core refused the removal (HTTP 409)');
      // One accusation at ERROR (the record's), never a second one for the same refusal.
      expect(spy.error).toHaveBeenCalledTimes(1);
      // Asked once per run: the run does not loop on a number it already attempted.
      expect(httpService.post).toHaveBeenCalledTimes(1);
    });

    it('the person joined again before the claim: no longer owed, nothing asked, nothing written', async () => {
      const rows = [responsable(), vendeur()];
      const departed = ['u2'];
      const { service, httpService, query, asso } = make(rows, {
        core: { verified: true, held: 0 },
        departed,
      });
      // The debt is read while u2 is gone; they join again before the claim re-reads membership.
      const fake = query.getMockImplementation()!;
      query.mockImplementation(async (sql: string, params?: unknown[]) => {
        const answer = await fake(sql, params);
        if (sql.includes('AS "hasPrevious"')) departed.length = 0;
        return answer;
      });
      await service.settleDepartures(ASSO, 'departure');
      expect(httpService.post).not.toHaveBeenCalled();
      expect(rows[1].removedAt).toBeUndefined();
      expect(rows[1].revokeUnconfirmedAt).toBeUndefined();
      expect(asso).toMatchObject({ claimed: false, token: null });
    });

    it('the other number was removed by another run before the claim: no longer owed, nothing asked, nothing accused', async () => {
      const spy = levels();
      const rows = [responsable({ previousPhoneSealed: seal(OLD) })];
      const { service, httpService, query } = make(rows, {
        core: { verified: true, held: 0 },
        departed: ['u1'],
      });
      const fake = query.getMockImplementation()!;
      query.mockImplementation(async (sql: string, params?: unknown[]) => {
        const answer = await fake(sql, params);
        if (sql.includes('AS "hasPrevious"')) rows[0].previousPhoneSealed = null;
        return answer;
      });
      await service.settleDepartures(ASSO, 'payout-read');
      expect(httpService.post).not.toHaveBeenCalled();
      expect(spy.error).not.toHaveBeenCalled();
      expect(spy.warn).not.toHaveBeenCalled();
    });

    it('the row was closed before the claim: no longer owed, nothing asked', async () => {
      const rows = [responsable(), vendeur()];
      const { service, httpService, query } = make(rows, {
        core: { verified: true, held: 0 },
        departed: ['u2'],
      });
      const fake = query.getMockImplementation()!;
      query.mockImplementation(async (sql: string, params?: unknown[]) => {
        const answer = await fake(sql, params);
        if (sql.includes('AS "hasPrevious"')) rows[1].removedAt = new Date();
        return answer;
      });
      await service.settleDepartures(ASSO, 'departure');
      expect(httpService.post).not.toHaveBeenCalled();
    });

    it('another cashier operation holds the claim: nothing asked, nothing written, said at INFO, its claim untouched', async () => {
      const spy = levels();
      const rows = [responsable(), vendeur()];
      const { service, httpService, query, asso } = make(rows, {
        core: { verified: true, held: 0 },
        departed: ['u2'],
        asso: { claimed: true, token: STRANGER },
      });
      await service.settleDepartures(ASSO, 'payout-read');
      expect(httpService.post).not.toHaveBeenCalled();
      expect(writes(query)).toEqual([]);
      expect(asso).toMatchObject({ claimed: true, token: STRANGER });
      expect(spy.error).not.toHaveBeenCalled();
      expect(String(spy.log.mock.calls)).toContain('in flight - still owed');
    });

    it('a departed Responsable: the other number removed, the current one KEPT, and the departure says so at ERROR', async () => {
      const spy = levels();
      const rows = [responsable({ previousPhoneSealed: seal(OLD) })];
      const current = rows[0].phoneSealed;
      const { service, httpService } = make(rows, {
        core: { verified: true, held: 0 },
        departed: ['u1'],
      });
      await service.settleDepartures(ASSO, 'departure', 'u1');
      expect(corePosts(httpService).map((b) => b.cashierPhone)).toEqual([OLD]);
      expect(rows[0]).toMatchObject({ previousPhoneSealed: null });
      expect(rows[0].removedAt).toBeUndefined();
      expect(rows[0].phoneSealed).toBe(current);
      expect(String(spy.error.mock.calls)).toContain('the Business needs a new Responsable');
    });

    it('a departed Responsable with nothing else owed: no call to Lydia, and a card read does not accuse again', async () => {
      const spy = levels();
      const { service, httpService } = make([responsable()], { departed: ['u1'] });
      await service.settleDepartures(ASSO, 'payout-read');
      expect(httpService.post).not.toHaveBeenCalled();
      expect(spy.error).not.toHaveBeenCalled();
    });

    it('nobody departed: nothing asked', async () => {
      const { service, httpService } = make([responsable(), vendeur()], { departed: [] });
      await service.settleDepartures(ASSO, 'departure');
      expect(httpService.post).not.toHaveBeenCalled();
    });
  });

  it('erasure: the cashier numbers are asked removed under a claim, released after, a confirmed one reported cleared', async () => {
    const { service, httpService, asso } = make([responsable(), vendeur()], {
      core: { verified: true, held: 0 },
    });
    const cleared = await service.revokeBeforeErasure('u2');
    expect(httpService.post).toHaveBeenCalledTimes(1);
    const [url, body] = httpService.post.mock.calls[0] as unknown as [
      string,
      Record<string, string>,
    ];
    expect(url).toContain('/api/internal/lydia-cashiers/revoke');
    expect(body).toMatchObject({
      contextPhone: HOLDER_PHONE,
      cashierPhone: PHONE,
      vendorToken: 'vendor-1',
    });
    expect(cleared).toEqual(new Set([`${ASSO}:vendor-1`]));
    expect(asso.claimed).toBe(false);
  });

  it('erasure while another cashier operation is in flight: that association is skipped, its claim untouched', async () => {
    const { service, httpService, asso } = make([responsable(), vendeur()], {
      core: { verified: true, held: 0 },
      asso: { claimed: true, token: STRANGER },
    });
    await expect(service.revokeBeforeErasure('u2')).resolves.toEqual(new Set());
    expect(httpService.post).not.toHaveBeenCalled();
    expect(asso.token).toBe(STRANGER);
  });

  it('erasure never removes a number another live row holds', async () => {
    // A Vendeur row whose number is also the Responsable's other number: that number is skipped.
    const rows = [responsable({ previousPhoneSealed: seal(PHONE) }), vendeur()];
    const { service, httpService } = make(rows, { core: { verified: true, held: 0 } });
    await expect(service.revokeBeforeErasure('u2')).resolves.toEqual(new Set());
    expect(httpService.post).not.toHaveBeenCalled();
  });

  it('erasure removes nothing when another live row has a seal that does not open', async () => {
    // A Tresorier row whose number cannot be read: it might be the Vendeur's, so nothing is removed.
    const rows = [
      responsable(),
      vendeur(),
      vendeur({ id: 't1', userId: 'u3', role: 'tresorier', phoneSealed: 'not-a-seal' }),
    ];
    const { service, httpService } = make(rows, { core: { verified: true, held: 0 } });
    await expect(service.revokeBeforeErasure('u2')).resolves.toEqual(new Set());
    expect(httpService.post).not.toHaveBeenCalled();
  });

  it('erasure NEVER blocks: core unreachable resolves, nothing reported cleared, claim released', async () => {
    const { service, asso } = make([responsable(), vendeur()], {
      core: new Error('ECONNREFUSED'),
    });
    await expect(service.revokeBeforeErasure('u2')).resolves.toEqual(new Set());
    expect(asso.claimed).toBe(false);
  });

  it('erasure of the Responsable: its current number is NOT removed, its other number is', async () => {
    const { service, httpService } = make([responsable()], { core: { verified: true, held: 0 } });
    await expect(service.revokeBeforeErasure('u1')).resolves.toEqual(new Set());
    expect(httpService.post).not.toHaveBeenCalled();
    const withOther = make([responsable({ previousPhoneSealed: seal(OLD) })], {
      core: { verified: true, held: 0 },
    });
    await expect(withOther.service.revokeBeforeErasure('u1')).resolves.toEqual(new Set());
    expect(withOther.httpService.post).toHaveBeenCalledTimes(1);
    const [, body] = withOther.httpService.post.mock.calls[0] as unknown as [
      string,
      Record<string, string>,
    ];
    expect(body).toMatchObject({ contextPhone: HOLDER_PHONE, cashierPhone: OLD });
  });
});

describe('LydiaCashiersService - the hand-over switch, social side (defence in depth)', () => {
  /** A service whose database must never be read: the switch refuses before. */
  function shut() {
    const query = jest.fn();
    const service = new LydiaCashiersService(
      { query, manager: { transaction: jest.fn() } } as never,
      {} as never,
      { tellAdded: jest.fn(), tellResponsable: jest.fn() } as never,
      {} as never
    );
    return { service, query };
  }

  it('ships OFF: the claim is the typed 409 DISABLED, nothing read or claimed', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service, query } = shut();
    expect(service.handoverEnabled()).toBe(false);
    await expect(
      service.claimHandover('asso-1', {
        actorId: 'holder',
        globalAdmin: false,
        userId: 'heir',
        phone: '+33611112222',
      })
    ).rejects.toMatchObject({ response: { code: LYDIA_RESPONSABLE_HANDOVER_DISABLED } });
    expect(query).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a record reaching it while off is refused the same way, its claim released', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service } = shut();
    const release = jest
      .spyOn(service as unknown as { release: () => Promise<void> }, 'release')
      .mockResolvedValue(undefined);
    await expect(
      service.recordHandover('asso-1', {
        vendorToken: 'vendor-1',
        userId: 'heir',
        phone: '+33611112222',
        previousResponsableId: 'row-1',
        actorId: 'holder',
        confirmed: true,
        claimToken: '3e1c8d7b-4a5f-4e6d-8c9b-0a1f2e3d4c5b',
      })
    ).rejects.toMatchObject({ response: { code: LYDIA_RESPONSABLE_HANDOVER_DISABLED } });
    expect(release).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
