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
import {
  LYDIA_CASHIER_ALREADY_SET,
  LYDIA_CASHIER_IN_FLIGHT,
  LydiaCashiersService,
} from './lydia-cashiers.service';
import { listLydiaCashiers } from './lydia-cashiers-list';

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
    await ds.query(`UPDATE associations SET "lydiaResponsableStartedAt" = NULL WHERE id = $1`, [
      ASSO,
    ]);
    await ds.query(
      `INSERT INTO lydia_cashiers ("associationId", "vendorToken", "userId", "phoneSealed",
         "phoneEnd", role, "addedByUserId", "confirmedAt")
       VALUES ($1, $2, 'holder', $3, '32', 'responsable', 'treasurer', now())`,
      [ASSO, VENDOR, sealSecret(LYDIA_CASHIER_PHONE_PURPOSE, ASSO, HOLDER_PHONE)]
    );
  };
  const record = (userId: string, phone: string, confirmed = true) =>
    cashiers.record(ASSO, {
      vendorToken: VENDOR,
      userId,
      phone,
      role: 'vendeur',
      addedByUserId: 'treasurer',
      confirmed,
    });
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
    await cashiers.claimAdd(ASSO, { userId: 'member-2', phone: '+33600000002', role: 'vendeur' });
    const view = await record('member-2', '+33600000002');
    expect(view).toMatchObject({ role: 'vendeur', phoneEnd: '02', state: 'confirmed' });
    expect(view.addedByName).toBe('Tess');
    expect(await claimHeld()).toBe(false);
    expect(tellAdded).toHaveBeenCalledTimes(1);
  });

  it('a removal Lydia confirmed closes the row and clears every number; an unconfirmed one keeps it live, flagged', async () => {
    await reset();
    const view = await record('member-2', '+33600000002');
    await cashiers.claimRevoke(ASSO, { cashierId: view.id, number: 'current' });
    await cashiers.recordRevoke(ASSO, {
      cashierId: view.id,
      number: 'current',
      verified: false,
      actorId: 'treasurer',
    });
    let list = await listLydiaCashiers((s, p) => ds.query(s, p), ASSO, VENDOR);
    expect(list.find((c) => c.id === view.id)?.state).toBe('revoke-unconfirmed');
    expect(await claimHeld()).toBe(false);

    await cashiers.claimRevoke(ASSO, { cashierId: view.id, number: 'current' });
    await cashiers.recordRevoke(ASSO, {
      cashierId: view.id,
      number: 'current',
      verified: true,
      actorId: 'treasurer',
    });
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
    await associations.recordLydiaResponsable(ASSO, {
      vendorToken: VENDOR,
      userId: 'holder',
      phone: '+33611111111',
      addedByUserId: 'treasurer',
      confirmed: true,
    });
    const [row] = await ds.query(
      `SELECT id, "phoneSealed", "previousPhoneSealed", "previousPhoneEnd" FROM lydia_cashiers
        WHERE role = 'responsable' AND "removedAt" IS NULL`
    );
    expect(openSecret(LYDIA_CASHIER_PHONE_PURPOSE, ASSO, row.phoneSealed)).toBe('+33611111111');
    expect(openSecret(LYDIA_CASHIER_PHONE_PURPOSE, ASSO, row.previousPhoneSealed)).toBe(
      HOLDER_PHONE
    );
    // The removal of the old number.
    const target = await cashiers.claimRevoke(ASSO, { cashierId: row.id, number: 'previous' });
    expect(target).toMatchObject({ cashierPhone: HOLDER_PHONE, actorPhone: '+33611111111' });
    // Halfway: Lydia did not confirm - the old number stays, listed, flagged.
    await cashiers.recordRevoke(ASSO, {
      cashierId: row.id,
      number: 'previous',
      verified: false,
      actorId: 'treasurer',
    });
    let [responsable] = await listLydiaCashiers((s, p) => ds.query(s, p), ASSO, VENDOR);
    expect(responsable).toMatchObject({ phoneEnd: '11', previousPhoneEnd: '32' });
    // The retry is confirmed: the old number is gone, the new one stays.
    await cashiers.claimRevoke(ASSO, { cashierId: row.id, number: 'previous' });
    await cashiers.recordRevoke(ASSO, {
      cashierId: row.id,
      number: 'previous',
      verified: true,
      actorId: 'treasurer',
    });
    [responsable] = await listLydiaCashiers((s, p) => ds.query(s, p), ASSO, VENDOR);
    expect(responsable).toMatchObject({
      phoneEnd: '11',
      previousPhoneEnd: null,
      state: 'confirmed',
    });
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

    it('two RECORDS of the same member (past any claim): ONE row, the other the typed ALREADY_SET', async () => {
      await reset();
      const settled = await Promise.allSettled([
        record('member-3', '+33600000003'),
        record('member-3', '+33600000004'),
      ]);
      expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const [lost] = settled.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect((lost.reason as HttpException).getResponse()).toMatchObject({
        code: LYDIA_CASHIER_ALREADY_SET,
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
