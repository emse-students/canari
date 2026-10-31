/**
 * LYDIA CASHIERS AGAINST A REAL POSTGRESQL (enrolment lot 3, migration 119).
 *
 * What a mocked manager cannot prove: that migration 119 runs twice, that a confirmed removal
 * closes the row and clears every number while an unconfirmed one keeps it live and flagged, that a
 * Responsable number change keeps BOTH numbers tracked until the old one's removal is confirmed,
 * and - under concurrency (`Promise.all`, the pool's connections) - that two adds of the same member
 * give ONE claim and ONE typed refusal, two records of the same member ONE row (the unique index),
 * and an add racing a removal ONE winner.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; CI's
 * `test-social-integration` sets it. Locally, against a throwaway PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- lydia-cashiers.integration
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpException, Logger } from '@nestjs/common';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { AssociationProduct } from './entities/association-product.entity';
import { Association } from './entities/association.entity';
import { AssociationAudience } from '../spaces/association-audience.entity';
import { Space } from '../spaces/space.entity';
import { PurchaseRecord } from '../users/entities/purchase-record.entity';
import { UserTag } from '../users/entities/user-tag.entity';
import { PostNotification } from '../posts/entities/post-notification.entity';
import { SECRET_BOX_ENV, openSecret, sealSecret } from '../common/secret-box';
import { AssociationsService, LYDIA_CASHIER_PHONE_PURPOSE } from './associations.service';
import { LYDIA_CASHIER_IN_FLIGHT, LydiaCashiersService } from './lydia-cashiers.service';
import { listLydiaCashiers } from './lydia-cashiers-list';
import {
  LYDIA_CASHIER_CLAIM_LOST,
  LYDIA_CASHIER_NUMBER_CHANGED,
  LYDIA_CASHIER_PHONE_IN_USE,
} from './lydia-cashier-claim';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const ASSO = '00000000-0000-4000-8000-0000000003c1';
const VENDOR = 'vendor-token-of-the-cashiers-it';
const HOLDER_PHONE = '+33698765432';
const migration = (name: string) => readFileSync(join(__dirname, '../migrations', name), 'utf8');

maybe('Lydia cashiers: rows, numbers and one claim (PostgreSQL)', () => {
  const schema = `lydia_cash_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let associations: AssociationsService;
  let cashiers: LydiaCashiersService;
  const tellAdded = jest.fn(async () => 1);
  let savedSecret: string | undefined;

  const options = (synchronize: boolean, entities: Function[]) => ({
    type: 'postgres' as const,
    url: URL,
    entities,
    synchronize,
    uuidExtension: 'pgcrypto' as const,
    installExtensions: false,
    extra: { options: `-c search_path=${schema},public`, application_name: schema },
  });

  beforeAll(async () => {
    for (const level of ['log', 'warn', 'debug', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema},public`);
    const entities = [
      PurchaseRecord,
      AssociationProduct,
      UserTag,
      Association,
      AssociationAudience,
      Space,
      PostNotification,
    ];
    ds = new DataSource(options(true, entities));
    await ds.initialize();
    await admin.query(migration('118_lydia_cashiers_and_readiness.sql'));
    // TWICE each: CD may replay them, and every statement is IF NOT EXISTS.
    await admin.query(migration('119_lydia_cashiers_lot3.sql'));
    await admin.query(migration('119_lydia_cashiers_lot3.sql'));
    await admin.query('RESET lock_timeout');
    await admin.query(
      `CREATE TABLE users (id varchar(255) PRIMARY KEY, "firstName" text, "lastName" text,
         "displayName" text, admin boolean NOT NULL DEFAULT false)`
    );
    await admin.query(
      `INSERT INTO users (id, "firstName") VALUES ('holder', 'Ada'), ('member-2', 'Bob'),
         ('member-3', 'Cy'), ('treasurer', 'Tess')`
    );
    savedSecret = process.env[SECRET_BOX_ENV];
    process.env[SECRET_BOX_ENV] = 'throwaway-encryption-secret-0123456789abcdef';

    const assoRepo = ds.getRepository(Association);
    await assoRepo.save(
      assoRepo.create({
        id: ASSO,
        name: 'Asso cashiers',
        slug: 'asso-cashiers',
        createdBy: 'it',
        lydiaAccountId: VENDOR,
      } as Partial<Association>)
    );
    associations = Object.assign(Object.create(AssociationsService.prototype) as object, {
      assoRepo,
      logger: new Logger('AssociationsService'),
      isMember: async () => true,
    }) as unknown as AssociationsService;
    cashiers = new LydiaCashiersService(
      assoRepo,
      associations,
      { tellAdded } as never,
      {} as never
    );
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    if (savedSecret === undefined) delete process.env[SECRET_BOX_ENV];
    else process.env[SECRET_BOX_ENV] = savedSecret;
    await ds?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  /** A clean association: no cashier, no claim, and a CONFIRMED Responsable. */
  const reset = async () => {
    await ds.query(`DELETE FROM lydia_cashiers`);
    await ds.query(
      `UPDATE associations SET "lydiaResponsableStartedAt" = NULL, "lydiaCashierClaimToken" = NULL
        WHERE id = $1`,
      [ASSO]
    );
    await ds.query(
      `INSERT INTO lydia_cashiers ("associationId", "vendorToken", "userId", "phoneSealed",
         "phoneEnd", role, "addedByUserId", "confirmedAt")
       VALUES ($1, $2, 'holder', $3, '32', 'responsable', 'treasurer', now())`,
      [ASSO, VENDOR, sealSecret(LYDIA_CASHIER_PHONE_PURPOSE, ASSO, HOLDER_PHONE)]
    );
  };
  const recordUnder = (claimToken: string, userId: string, phone: string, confirmed = true) =>
    cashiers.record(ASSO, {
      vendorToken: VENDOR,
      userId,
      phone,
      role: 'vendeur',
      addedByUserId: 'treasurer',
      confirmed,
      claimToken,
    });
  /** An add as core-service runs it: the claim, then the record carrying its token. */
  const record = async (userId: string, phone: string, confirmed = true) => {
    const { claimToken } = await cashiers.claimAdd(ASSO, { userId, phone, role: 'vendeur' });
    return recordUnder(claimToken, userId, phone, confirmed);
  };
  /** A removal as core-service runs it: the claim, then the record of what Lydia's re-read showed. */
  const revoke = async (cashierId: string, number: 'current' | 'previous', verified: boolean) => {
    const target = await cashiers.claimRevoke(ASSO, { cashierId, number });
    await cashiers.recordRevoke(ASSO, {
      cashierId,
      number,
      verified,
      actorId: 'treasurer',
      cashierPhone: target.cashierPhone,
      claimToken: target.claimToken,
    });
    return target;
  };
  /** The Responsable asking for `phone`, as core-service runs it: the claim, then the record. */
  const responsableTo = async (phone: string, confirmed: boolean) => {
    const claim = await associations.claimLydiaResponsable(ASSO, 'holder', phone, {
      mode: 'add',
      allowNumberChange: true,
    });
    expect(claim.claimed).toBe(true);
    return associations.recordLydiaResponsable(ASSO, {
      vendorToken: VENDOR,
      userId: 'holder',
      phone,
      addedByUserId: 'treasurer',
      confirmed,
      claimToken: claim.claimToken,
    });
  };
  const responsableNumbers = async () => {
    const [row] = await ds.query(
      `SELECT id, "phoneSealed", "previousPhoneSealed" FROM lydia_cashiers
        WHERE role = 'responsable' AND "removedAt" IS NULL`
    );
    const open = (sealed: string | null) =>
      sealed && openSecret(LYDIA_CASHIER_PHONE_PURPOSE, ASSO, sealed);
    return {
      id: row.id as string,
      current: open(row.phoneSealed),
      other: open(row.previousPhoneSealed),
    };
  };
  const claimHeld = async () =>
    (
      await ds.query(`SELECT "lydiaResponsableStartedAt" AS at FROM associations WHERE id = $1`, [
        ASSO,
      ])
    )[0].at !== null;

  it('migration 119 ran twice and made what it says', async () => {
    const [cols] = await ds.query(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'lydia_cashiers'
          AND column_name IN ('revokeUnconfirmedAt', 'previousPhoneSealed', 'previousPhoneEnd',
                              'previousRevokeUnconfirmedAt')`,
      [schema]
    );
    expect(cols.n).toBe(4);
    const [token] = await ds.query(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'associations'
          AND column_name = 'lydiaCashierClaimToken'`,
      [schema]
    );
    expect(token.n).toBe(1);
    const [idx] = await ds.query(
      `SELECT count(*)::int AS n FROM pg_indexes
        WHERE schemaname = $1 AND indexname = 'lydia_cashiers_one_live_member'`,
      [schema]
    );
    expect(idx.n).toBe(1);
  });

  it('an add is recorded with the number sealed, listed confirmed, and the member told', async () => {
    await reset();
    tellAdded.mockClear();
    const view = await record('member-2', '+33600000002');
    expect(view).toMatchObject({ role: 'vendeur', phoneEnd: '02', state: 'confirmed' });
    expect(view.addedByName).toBe('Tess');
    expect(await claimHeld()).toBe(false);
    expect(tellAdded).toHaveBeenCalledTimes(1);
  });

  it('the claim is cleared only by its token: a stale release or record never clears a claim taken since', async () => {
    await reset();
    const first = await cashiers.claimAdd(ASSO, {
      userId: 'member-2',
      phone: '+33600000002',
      role: 'vendeur',
    });
    // A global admin clears it; another operation claims; the first operation's late answers arrive.
    await ds.query(
      `UPDATE associations SET "lydiaResponsableStartedAt" = NULL, "lydiaCashierClaimToken" = NULL
        WHERE id = $1`,
      [ASSO]
    );
    const second = await cashiers.claimAdd(ASSO, {
      userId: 'member-3',
      phone: '+33600000003',
      role: 'vendeur',
    });
    await expect(cashiers.release(ASSO, first.claimToken)).resolves.toBe(false);
    await expect(recordUnder(first.claimToken, 'member-2', '+33600000002')).rejects.toMatchObject({
      response: { code: LYDIA_CASHIER_CLAIM_LOST },
    });
    expect(await claimHeld()).toBe(true);
    expect(
      await ds.query(`SELECT count(*)::int AS n FROM lydia_cashiers WHERE "userId" = 'member-2'`)
    ).toEqual([{ n: 0 }]);
    await expect(cashiers.release(ASSO, second.claimToken)).resolves.toBe(true);
    expect(await claimHeld()).toBe(false);
  });

  it('a role change clears the removal flag; one recorded against a number the row no longer holds writes nothing', async () => {
    await reset();
    const view = await record('member-2', '+33600000002');
    await revoke(view.id, 'current', false);
    const change = await cashiers.claimRoleChange(ASSO, { cashierId: view.id, role: 'tresorier' });
    const after = await cashiers.record(ASSO, {
      vendorToken: VENDOR,
      userId: 'member-2',
      phone: change.phone,
      role: 'tresorier',
      addedByUserId: 'treasurer',
      confirmed: true,
      cashierId: view.id,
      claimToken: change.claimToken,
    });
    expect(after).toMatchObject({ role: 'tresorier', state: 'confirmed' });
    const again = await cashiers.claimRoleChange(ASSO, { cashierId: view.id, role: 'vendeur' });
    await expect(
      cashiers.record(ASSO, {
        vendorToken: VENDOR,
        userId: 'member-2',
        phone: '+33600000077',
        role: 'vendeur',
        addedByUserId: 'treasurer',
        confirmed: true,
        cashierId: view.id,
        claimToken: again.claimToken,
      })
    ).rejects.toMatchObject({ response: { code: LYDIA_CASHIER_NUMBER_CHANGED } });
    const [row] = await listLydiaCashiers((s, p) => ds.query(s, p), ASSO, VENDOR).then((l) =>
      l.filter((c) => c.id === view.id)
    );
    expect(row.role).toBe('tresorier');
    expect(await claimHeld()).toBe(false);
  });

  it('a removal Lydia confirmed closes the row and clears every number; an unconfirmed one keeps it live, flagged', async () => {
    await reset();
    const view = await record('member-2', '+33600000002');
    await revoke(view.id, 'current', false);
    let list = await listLydiaCashiers((s, p) => ds.query(s, p), ASSO, VENDOR);
    expect(list.find((c) => c.id === view.id)?.state).toBe('revoke-unconfirmed');
    expect(await claimHeld()).toBe(false);

    await revoke(view.id, 'current', true);
    list = await listLydiaCashiers((s, p) => ds.query(s, p), ASSO, VENDOR);
    expect(list.map((c) => c.id)).not.toContain(view.id);
    const [closed] = await ds.query(
      `SELECT "removedAt", "phoneSealed", "phoneEnd", "revokeUnconfirmedAt" FROM lydia_cashiers WHERE id = $1`,
      [view.id]
    );
    expect(closed.removedAt).not.toBeNull();
    expect(closed).toMatchObject({ phoneSealed: null, phoneEnd: null, revokeUnconfirmedAt: null });
  });

  it('a Responsable number change keeps BOTH numbers until the old one is confirmed removed; halfway nothing is lost', async () => {
    await reset();
    await expect(responsableTo('+33611111111', true)).resolves.toMatchObject({
      removeOther: true,
    });
    const numbers = await responsableNumbers();
    expect(numbers).toMatchObject({ current: '+33611111111', other: HOLDER_PHONE });
    // The removal of the old number.
    const target = await revoke(numbers.id, 'previous', false);
    expect(target).toMatchObject({ cashierPhone: HOLDER_PHONE, contextPhone: '+33611111111' });
    // Halfway: Lydia did not confirm - the old number stays, listed, flagged.
    let [responsable] = await listLydiaCashiers((s, p) => ds.query(s, p), ASSO, VENDOR);
    expect(responsable).toMatchObject({ phoneEnd: '11', previousPhoneEnd: '32' });
    // The retry is confirmed: the old number is gone, the new one stays.
    await revoke(numbers.id, 'previous', true);
    [responsable] = await listLydiaCashiers((s, p) => ds.query(s, p), ASSO, VENDOR);
    expect(responsable).toMatchObject({
      phoneEnd: '11',
      previousPhoneEnd: null,
      state: 'confirmed',
    });
  });

  it('a new Responsable number Lydia did NOT confirm: the old number stays the live one, the removal step acts only on the new one', async () => {
    await reset();
    await expect(responsableTo('+33611111111', false)).resolves.toMatchObject({
      view: { phoneEnd: '32', confirmed: true },
      removeOther: false,
    });
    const numbers = await responsableNumbers();
    expect(numbers).toMatchObject({ current: HOLDER_PHONE, other: '+33611111111' });
    // Removing "the other number" now removes the unproven new one, never the live one.
    const target = await revoke(numbers.id, 'previous', true);
    expect(target).toMatchObject({ cashierPhone: '+33611111111', contextPhone: HOLDER_PHONE });
    expect(await responsableNumbers()).toMatchObject({ current: HOLDER_PHONE, other: null });
  });

  it('going BACK to the old number while it is tracked: re-confirmed, then the new one is the one to remove', async () => {
    await reset();
    await responsableTo('+33611111111', true);
    // A third number is not a change while the old one is tracked.
    await expect(
      associations.claimLydiaResponsable(ASSO, 'holder', '+33622222222', {
        mode: 'add',
        allowNumberChange: true,
      })
    ).resolves.toMatchObject({ claimed: false, numberChange: false });
    await expect(responsableTo(HOLDER_PHONE, true)).resolves.toMatchObject({ removeOther: true });
    const numbers = await responsableNumbers();
    expect(numbers).toMatchObject({ current: HOLDER_PHONE, other: '+33611111111' });
    const target = await revoke(numbers.id, 'previous', true);
    expect(target).toMatchObject({ cashierPhone: '+33611111111', contextPhone: HOLDER_PHONE });
    expect(await responsableNumbers()).toMatchObject({ current: HOLDER_PHONE, other: null });
  });

  it('the Responsable never takes a number another live cashier holds, and a role change never re-adds a Responsable number', async () => {
    await reset();
    const vendeur = await record('member-2', '+33600000002');
    // A number change onto the Vendeur's number: refused, nothing claimed or written.
    await expect(
      associations.claimLydiaResponsable(ASSO, 'holder', '+33600000002', {
        mode: 'add',
        allowNumberChange: true,
      })
    ).rejects.toMatchObject({ response: { code: LYDIA_CASHIER_PHONE_IN_USE } });
    expect(await claimHeld()).toBe(false);
    expect(await responsableNumbers()).toMatchObject({ current: HOLDER_PHONE, other: null });
    // A row left on the Responsable's number (an older state): its role change is refused.
    await ds.query(`UPDATE lydia_cashiers SET "phoneSealed" = $2 WHERE id = $1`, [
      vendeur.id,
      sealSecret(LYDIA_CASHIER_PHONE_PURPOSE, ASSO, HOLDER_PHONE),
    ]);
    await expect(
      cashiers.claimRoleChange(ASSO, { cashierId: vendeur.id, role: 'tresorier' })
    ).rejects.toMatchObject({ response: { code: LYDIA_CASHIER_PHONE_IN_USE } });
    expect(await claimHeld()).toBe(false);
    // The Responsable erased: a new Responsable on a live Vendeur's number is refused too.
    await ds.query(`DELETE FROM lydia_cashiers WHERE role = 'responsable'`);
    await expect(
      associations.claimLydiaResponsable(ASSO, 'member-3', HOLDER_PHONE, { mode: 'add' })
    ).rejects.toMatchObject({ response: { code: LYDIA_CASHIER_PHONE_IN_USE } });
    expect(await claimHeld()).toBe(false);
  });

  describe('under concurrency (Promise.all, one connection each)', () => {
    it('two adds of the same member: ONE claim, ONE typed IN_FLIGHT', async () => {
      await reset();
      const settled = await Promise.allSettled([
        cashiers.claimAdd(ASSO, { userId: 'member-3', phone: '+33600000003', role: 'vendeur' }),
        cashiers.claimAdd(ASSO, { userId: 'member-3', phone: '+33600000003', role: 'tresorier' }),
      ]);
      expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const [lost] = settled.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect((lost.reason as HttpException).getResponse()).toMatchObject({
        code: LYDIA_CASHIER_IN_FLIGHT,
      });
    });

    it('two RECORDS under one claim: ONE row, the other the typed CLAIM_LOST', async () => {
      await reset();
      const { claimToken } = await cashiers.claimAdd(ASSO, {
        userId: 'member-3',
        phone: '+33600000003',
        role: 'vendeur',
      });
      const settled = await Promise.allSettled([
        recordUnder(claimToken, 'member-3', '+33600000003'),
        recordUnder(claimToken, 'member-3', '+33600000004'),
      ]);
      expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const [lost] = settled.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect((lost.reason as HttpException).getResponse()).toMatchObject({
        code: LYDIA_CASHIER_CLAIM_LOST,
      });
      expect(
        await ds.query(
          `SELECT count(*)::int AS n FROM lydia_cashiers WHERE "userId" = 'member-3' AND "removedAt" IS NULL`
        )
      ).toEqual([{ n: 1 }]);
    });

    it('an add racing a removal: ONE wins the claim, the other is the typed IN_FLIGHT', async () => {
      await reset();
      const view = await record('member-2', '+33600000002');
      const settled = await Promise.allSettled([
        cashiers.claimAdd(ASSO, { userId: 'member-3', phone: '+33600000003', role: 'vendeur' }),
        cashiers.claimRevoke(ASSO, { cashierId: view.id, number: 'current' }),
      ]);
      expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const [lost] = settled.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect((lost.reason as HttpException).getResponse()).toMatchObject({
        code: LYDIA_CASHIER_IN_FLIGHT,
      });
    });
  });
});
