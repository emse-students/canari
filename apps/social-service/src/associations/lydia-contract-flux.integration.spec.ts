/**
 * THE PLATFORM'S LYDIA FLUX, AGAINST A REAL POSTGRESQL (lydia-contract-flux.ts, migration 168).
 *
 * What a mocked query cannot prove: that migration 168's backfill takes the enrolled Businesses and
 * NEVER a bridge's historical account, whatever the bridge's state; that a payment counts by the
 * Business ITS row names (a boutique attempt's vendor token, a form answer's), so one taken on a
 * historical account is excluded even after the switch; that a refund counts on the day Lydia
 * executed it, in that year and not the payment's; that the year's bounds are Paris midnights; and
 * that the link writes the ledger. Migration 168 runs twice.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; CI's
 * `test-social-integration` sets it. Locally, against a throwaway PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- lydia-contract-flux.integration
 *
 * Every vendor token, amount and date below is made up for the test.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { PurchaseRecord } from '../users/entities/purchase-record.entity';
import { ProductCheckout } from './entities/product-checkout.entity';
import { Submission } from '../forms/entities/submission.entity';
import { measureLydiaFlux, recordEnrolledBusiness } from './lydia-contract-flux';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const PLAIN = '00000000-0000-4000-8000-0000000003c1'; // enrolled, no bridge
const WAITING = '00000000-0000-4000-8000-0000000003c2'; // bridge 'historical', enrolled one pending
const SWITCHED = '00000000-0000-4000-8000-0000000003c3'; // bridge 'switched'
const LATE = '00000000-0000-4000-8000-0000000003c4'; // links after the migration
// A historical account collecting with NO bridge row yet (bridges are opened by hand, after
// migration 167 ships with 168): no dashboard URL, the proof `business/create` leaves.
const UNBRIDGED = '00000000-0000-4000-8000-0000000003c5';
const T_PLAIN = 'vendor-token-plain';
const T_WAITING_HIST = 'vendor-token-waiting-historical';
const T_WAITING_NEW = 'vendor-token-waiting-enrolled';
const T_SWITCHED_HIST = 'vendor-token-switched-historical';
const T_SWITCHED_NEW = 'vendor-token-switched-enrolled';
const T_LATE = 'vendor-token-late';
const T_UNBRIDGED_HIST = 'vendor-token-unbridged-historical';

/** The made-up contract year of these tests: [2031-03-05, 2032-03-05), Paris midnights. */
const FROM = '2031-03-05';
const TO = '2032-03-05';

const migration = (name: string) => readFileSync(join(__dirname, '../migrations', name), 'utf8');

maybe('the platform Lydia flux (PostgreSQL)', () => {
  const schema = `lydia_flux_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  const logger = new Logger('LydiaContractFluxIT');

  const options = (synchronize: boolean, entities: Function[]) => ({
    type: 'postgres' as const,
    url: URL,
    entities,
    synchronize,
    extra: { options: `-c search_path=${schema},public` },
  });

  const measure = () => measureLydiaFlux((sql, params) => ds.query(sql, params), FROM, TO, logger);

  /** A boutique payment: the record and its paid attempt naming the Business that took it. */
  async function boutique(amount: number, vendorToken: string, paidAt: string, status = 'paid') {
    const id = randomUUID();
    await ds.query(
      `INSERT INTO purchase_records (id, "userId", source, "productId", "amountCents", "paymentMethod",
         status, "associationId", "productName", "paidAt")
       VALUES ($1, 'buyer', 'product', $2, $3, 'online', $4, $5, 'Product', $6)`,
      [id, randomUUID(), amount, status, PLAIN, paidAt]
    );
    await ds.query(
      `INSERT INTO product_checkouts ("productId", "userId", "associationId", "paymentAssociationId",
         "vendorToken", "amountCents", "productName", status, "expiresAt", "purchaseRecordId")
       VALUES ($1, 'buyer', $2, $2, $3, $4, 'Product', 'paid', now(), $5)`,
      [randomUUID(), PLAIN, vendorToken, amount, id]
    );
    return id;
  }

  /** A form payment: the answer naming the Business its request went to, and its record. */
  async function form(amount: number, vendorToken: string | null, paidAt: string) {
    const formId = randomUUID();
    const submission = await ds.getRepository(Submission).save(
      ds.getRepository(Submission).create({
        formId,
        userId: 'buyer',
        answers: {},
        totalPaid: amount,
        paymentStatus: 'paid',
      })
    );
    await ds.query(`UPDATE submissions SET "lydiaVendorToken" = $2 WHERE id = $1`, [
      submission.id,
      vendorToken,
    ]);
    const id = randomUUID();
    await ds.query(
      `INSERT INTO purchase_records (id, "userId", source, "formId", "submissionId", "amountCents",
         "paymentMethod", status, "associationId", "productName", "paidAt")
       VALUES ($1, 'buyer', 'form', $2, $3, $4, 'online', 'paid', $5, 'Form', $6)`,
      [id, formId, submission.id, amount, PLAIN, paidAt]
    );
    return id;
  }

  /** A refund of `recordId` on `vendorToken`, answered by Lydia at `answeredAt`. */
  async function refund(
    recordId: string,
    vendorToken: string,
    amount: number,
    answeredAt: string,
    status = 'confirmed',
    outcome: string | null = 'refunded'
  ) {
    await ds.query(
      `INSERT INTO lydia_refunds ("purchaseRecordId", "associationId", "vendorToken", "orderRef", kind,
         "amountCents", reason, "idempotencyKey", status, outcome, "requestedByUserId", "answeredAt")
       VALUES ($1, $2, $3, 'order', 'partial', $4, 'test', $5, $6, $7, 'manager', $8)`,
      [recordId, PLAIN, vendorToken, amount, randomUUID(), status, outcome, answeredAt]
    );
  }

  beforeAll(async () => {
    for (const level of ['log', 'warn', 'debug', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema},public`);
    const others = new DataSource(options(true, [PurchaseRecord, ProductCheckout, Submission]));
    await others.initialize();
    await others.destroy();
    await admin.query(
      `CREATE TABLE associations (id uuid PRIMARY KEY, name text NOT NULL, type varchar NOT NULL DEFAULT 'association', "lydiaAccountId" varchar NULL,
         "lydiaDashboardUrl" varchar NULL)`
    );
    await admin.query(migration('120_lydia_refunds.sql'));
    await admin.query(migration('167_lydia_account_bridge.sql'));
    await admin.query(
      `INSERT INTO associations (id, name, "lydiaAccountId", "lydiaDashboardUrl") VALUES
         ($1, 'Plain', $5, 'https://dashboard.example/plain'), ($2, 'Waiting', $6, NULL),
         ($3, 'Switched', $7, 'https://dashboard.example/switched'), ($4, 'Late', NULL, NULL),
         ($8, 'Unbridged', $9, NULL)`,
      [
        PLAIN,
        WAITING,
        SWITCHED,
        LATE,
        T_PLAIN,
        T_WAITING_HIST,
        T_SWITCHED_NEW,
        UNBRIDGED,
        T_UNBRIDGED_HIST,
      ]
    );
    await admin.query(
      `INSERT INTO lydia_account_bridges ("associationId", "historicalVendorToken", "enrolledVendorToken", state)
       VALUES ($1, $2, $3, 'historical'), ($4, $5, $6, 'switched')`,
      [WAITING, T_WAITING_HIST, T_WAITING_NEW, SWITCHED, T_SWITCHED_HIST, T_SWITCHED_NEW]
    );
    // TWICE: CD may replay it; IF NOT EXISTS and ON CONFLICT DO NOTHING.
    await admin.query(migration('168_lydia_enrolled_businesses.sql'));
    await admin.query(migration('168_lydia_enrolled_businesses.sql'));
    await admin.query('RESET lock_timeout');
    ds = new DataSource(options(false, [PurchaseRecord, ProductCheckout, Submission]));
    await ds.initialize();
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await ds?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    await ds.query(`DELETE FROM lydia_refunds`);
    await ds.query(`DELETE FROM submissions`);
    await ds.query(`DELETE FROM product_checkouts`);
    await ds.query(`DELETE FROM purchase_records`);
  });

  it('backfills the enrolled Businesses and never a historical account, bridged or not', async () => {
    const rows = (await ds.query(
      `SELECT "vendorToken", source FROM lydia_enrolled_businesses ORDER BY "vendorToken"`
    )) as Array<{ vendorToken: string; source: string }>;
    expect(rows.map((r) => r.vendorToken)).toEqual([T_PLAIN, T_SWITCHED_NEW, T_WAITING_NEW].sort());
    expect(rows.every((r) => r.source === 'backfill')).toBe(true);
    // The historical account with no bridge row yet is left out: no dashboard URL, no proof.
    expect(rows.map((r) => r.vendorToken)).not.toContain(T_UNBRIDGED_HIST);
  });

  it('excludes a payment on a historical account no bridge names yet', async () => {
    await form(900, T_UNBRIDGED_HIST, '2031-06-01T10:00:00Z');
    expect(await measure()).toMatchObject({ paidCents: 0, excludedCents: 900, excludedCount: 1 });
  });

  it('counts payments on enrolled Businesses and excludes the historical accounts, switched or not', async () => {
    await boutique(1_000, T_PLAIN, '2031-06-01T10:00:00Z');
    await form(2_000, T_SWITCHED_NEW, '2031-06-02T10:00:00Z');
    await boutique(4_000, T_WAITING_HIST, '2031-06-03T10:00:00Z');
    await form(8_000, T_SWITCHED_HIST, '2031-06-04T10:00:00Z');
    expect(await measure()).toMatchObject({
      paidCents: 3_000,
      paymentCount: 2,
      fluxCents: 3_000,
      excludedCents: 12_000,
      excludedCount: 2,
      untraceableCount: 0,
    });
  });

  it('a payment refunded in full since still counts as paid, and its refund on its own date', async () => {
    const id = await boutique(5_000, T_PLAIN, '2031-06-01T10:00:00Z', 'refunded');
    await refund(id, T_PLAIN, 5_000, '2031-07-01T10:00:00Z');
    expect(await measure()).toMatchObject({
      paidCents: 5_000,
      refundedCents: 5_000,
      refundCount: 1,
      fluxCents: 0,
    });
  });

  it('counts a refund in the year Lydia executed it, not the payment year', async () => {
    // Paid in the year before, refunded in this one: only the refund falls in [FROM, TO).
    const before = await boutique(3_000, T_PLAIN, '2031-01-15T10:00:00Z');
    await refund(before, T_PLAIN, 1_000, '2031-04-01T10:00:00Z');
    // Paid in this year, refunded after it: only the payment falls in.
    const inYear = await boutique(7_000, T_PLAIN, '2031-12-01T10:00:00Z');
    await refund(inYear, T_PLAIN, 2_000, '2032-04-01T10:00:00Z');
    expect(await measure()).toMatchObject({
      paidCents: 7_000,
      refundedCents: 1_000,
      fluxCents: 6_000,
    });
  });

  it('counts only refunds Lydia executed, on an enrolled Business', async () => {
    const id = await boutique(9_000, T_PLAIN, '2031-06-01T10:00:00Z');
    await refund(id, T_PLAIN, 100, '2031-06-02T10:00:00Z', 'refused', 'some-refusal');
    await ds.query(`DELETE FROM lydia_refunds`);
    await refund(id, T_PLAIN, 200, '2031-06-02T10:00:00Z', 'pending', 'refunded-unrecorded');
    const hist = await boutique(9_000, T_WAITING_HIST, '2031-06-01T10:00:00Z');
    await refund(hist, T_WAITING_HIST, 400, '2031-06-02T10:00:00Z');
    expect(await measure()).toMatchObject({ refundedCents: 200, refundCount: 1 });
  });

  it('bounds the year at Paris midnights', async () => {
    // 23:30 UTC on 4 March is 00:30 on 5 March in Paris: inside. 22:30 UTC is 23:30 in Paris: outside.
    await boutique(1, T_PLAIN, '2031-03-04T23:30:00Z');
    await boutique(10, T_PLAIN, '2031-03-04T22:30:00Z');
    // 22:30 UTC on 4 March 2032 is 23:30 in Paris, the last minutes of the year: inside.
    await boutique(100, T_PLAIN, '2032-03-04T22:30:00Z');
    // 23:30 UTC on 4 March 2032 is 00:30 on 5 March in Paris: the next year.
    await boutique(1_000, T_PLAIN, '2032-03-04T23:30:00Z');
    expect(await measure()).toMatchObject({ paidCents: 101 });
  });

  it('reports a payment no row ties to a Business, counted nowhere', async () => {
    await form(500, null, '2031-06-01T10:00:00Z');
    expect(await measure()).toMatchObject({ paidCents: 0, excludedCents: 0, untraceableCount: 1 });
  });

  it('migration 169 copies each payment trace onto its record, which then survives the answer', async () => {
    // Written before 169: the Business is only on the answer and on the paid attempt.
    const formRecord = await form(1_500, T_PLAIN, '2031-06-01T10:00:00Z');
    const shopRecord = await boutique(2_500, T_SWITCHED_NEW, '2031-06-02T10:00:00Z');
    await admin.query(migration('169_purchase_record_vendor_token.sql'));
    await admin.query('RESET lock_timeout');
    const rows = (await ds.query(
      `SELECT id, "lydiaVendorToken" FROM purchase_records WHERE id = ANY($1::uuid[]) ORDER BY "amountCents"`,
      [[formRecord, shopRecord]]
    )) as Array<{ id: string; lydiaVendorToken: string }>;
    expect(rows.map((r) => r.lydiaVendorToken)).toEqual([T_PLAIN, T_SWITCHED_NEW]);
    // The manager deletes the answer (as a pre-2026-11-14 build could) - its form goes with it, or
    // is soft-deleted: the record keeps the Business, and the payment still counts.
    await ds.query(
      `DELETE FROM submissions WHERE id = (SELECT "submissionId" FROM purchase_records WHERE id = $1)`,
      [formRecord]
    );
    expect(await measure()).toMatchObject({
      paidCents: 4_000,
      paymentCount: 2,
      untraceableCount: 0,
    });
  });

  it('a record that carries its own Business counts with no answer and no attempt left', async () => {
    const id = await form(800, null, '2031-06-01T10:00:00Z');
    await ds.query(`UPDATE purchase_records SET "lydiaVendorToken" = $2 WHERE id = $1`, [
      id,
      T_PLAIN,
    ]);
    await ds.query(
      `DELETE FROM submissions WHERE id = (SELECT "submissionId" FROM purchase_records WHERE id = $1)`,
      [id]
    );
    expect(await measure()).toMatchObject({ paidCents: 800, untraceableCount: 0 });
  });

  it('splits the flux by association, and the total is the sum of the rows', async () => {
    const plain = await boutique(6_000, T_PLAIN, '2031-06-01T10:00:00Z');
    await refund(plain, T_PLAIN, 1_000, '2031-06-02T10:00:00Z');
    const other = await form(3_000, T_SWITCHED_NEW, '2031-06-03T10:00:00Z');
    const hist = await boutique(4_000, T_WAITING_HIST, '2031-06-04T10:00:00Z');
    await ds.query(`UPDATE purchase_records SET "associationId" = $2 WHERE id = $1`, [
      other,
      SWITCHED,
    ]);
    await ds.query(`UPDATE purchase_records SET "associationId" = $2 WHERE id = $1`, [
      hist,
      WAITING,
    ]);
    const m = await measure();
    expect(m.byAssociation.map((s) => [s.name, s.fluxCents, s.excludedCents])).toEqual([
      ['Plain', 5_000, 0],
      ['Switched', 3_000, 0],
      ['Waiting', 0, 4_000],
    ]);
    for (const k of [
      'paidCents',
      'paymentCount',
      'refundedCents',
      'refundCount',
      'fluxCents',
      'excludedCents',
      'excludedCount',
      'untraceableCount',
    ] as const) {
      expect(m.byAssociation.reduce((n, s) => n + s[k], 0)).toBe(m[k]);
    }
    expect(m).toMatchObject({ fluxCents: 8_000, excludedCents: 4_000 });
  });

  it('a bridge historical account never counts, even if a ledger row names it by mistake', async () => {
    await recordEnrolledBusiness((sql, params) => ds.query(sql, params), WAITING, T_WAITING_HIST);
    try {
      await boutique(700, T_WAITING_HIST, '2031-06-01T10:00:00Z');
      expect(await measure()).toMatchObject({ paidCents: 0, excludedCents: 700 });
    } finally {
      await ds.query(`DELETE FROM lydia_enrolled_businesses WHERE "vendorToken" = $1`, [
        T_WAITING_HIST,
      ]);
    }
  });

  it('the link records a Business linked after the migration', async () => {
    await recordEnrolledBusiness((sql, params) => ds.query(sql, params), LATE, T_LATE);
    await recordEnrolledBusiness((sql, params) => ds.query(sql, params), LATE, T_LATE);
    await boutique(600, T_LATE, '2031-06-01T10:00:00Z');
    expect(await measure()).toMatchObject({ paidCents: 600 });
    const [row] = (await ds.query(
      `SELECT source, "associationId" FROM lydia_enrolled_businesses WHERE "vendorToken" = $1`,
      [T_LATE]
    )) as Array<{ source: string; associationId: string }>;
    expect(row).toEqual({ source: 'enrolment', associationId: LATE });
  });
});
