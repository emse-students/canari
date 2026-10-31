/**
 * Lydia refunds against a REAL PostgreSQL: migration 120 as written, the payment's row lock, the sum
 * cap and what a total refund withdraws. Only a database serialises two transactions, so only here
 * can "no double refund under concurrency" be shown.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- refunds.integration
 *
 * Everything happens in a throwaway schema, dropped at the end. core-service is the `axios.post`
 * mock: what Lydia answered is what it resolves or rejects with.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import axios from 'axios';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { PurchaseRecord } from '../../users/entities/purchase-record.entity';
import { UserTag } from '../../users/entities/user-tag.entity';
import { ProductCheckout } from '../entities/product-checkout.entity';
import { AssociationProduct } from '../entities/association-product.entity';
import { Submission } from '../../forms/entities/submission.entity';
import { Association } from '../entities/association.entity';
import { LydiaRefund } from './lydia-refund.entity';
import { REFUND_CALL_BOUND_MS, REFUND_CALL_LOCK_KEY, RefundsService } from './refunds.service';
import { ERASURE_STATEMENTS, erasureParams } from '../../internal/account-erasure';
import {
  CORE_REFUND_CODES,
  LYDIA_REFUND_EXCEEDS_PAID,
  LYDIA_REFUND_IN_FLIGHT,
  LYDIA_REFUND_NOT_PENDING,
  LYDIA_REFUND_NOT_REFUNDABLE,
} from './refund-codes';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const ASSO = '00000000-0000-4000-8000-0000000000a1';
const VENDOR = 'vendor-of-a1';
const MANAGER = 'm'.repeat(64);

maybe('Lydia refunds against PostgreSQL', () => {
  const schema = `refunds_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let service: RefundsService;
  let notifier: { tell: jest.Mock };
  let post: jest.SpyInstance;

  const options = (synchronize: boolean, entities: Function[]) => ({
    type: 'postgres' as const,
    url: URL,
    entities,
    synchronize,
    extra: { options: `-c search_path=${schema},public` },
  });

  beforeAll(async () => {
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema},public`);
    // The tables a refund reads beside its own, from their entities; associations and forms reduced
    // to the columns a refund reads.
    const others = new DataSource(
      options(true, [PurchaseRecord, UserTag, ProductCheckout, AssociationProduct, Submission])
    );
    await others.initialize();
    await others.destroy();
    await admin.query(
      `CREATE TABLE associations (id uuid PRIMARY KEY, name text NOT NULL, "lydiaAccountId" varchar NULL,
         "paymentParentAssociationId" uuid NULL, "paymentDelegationStatus" varchar NULL)`
    );
    await admin.query(
      `CREATE TABLE forms (id uuid PRIMARY KEY, "grantsCotisation" boolean NOT NULL DEFAULT false)`
    );
    // Migration 120 from the file, twice: it must be idempotent. On the admin connection, so its
    // `SET lock_timeout` does not stay on a pool connection.
    const migration = readFileSync(
      join(__dirname, '../../migrations/120_lydia_refunds.sql'),
      'utf8'
    );
    await admin.query(migration);
    await admin.query(migration);
    await admin.query('RESET lock_timeout');
    await admin.query(
      `INSERT INTO associations (id, name, "lydiaAccountId") VALUES ($1, 'BDE', $2)`,
      [ASSO, VENDOR]
    );
    ds = new DataSource(
      options(false, [
        PurchaseRecord,
        UserTag,
        ProductCheckout,
        AssociationProduct,
        Submission,
        LydiaRefund,
        Association,
      ])
    );
    await ds.initialize();
    notifier = { tell: jest.fn().mockResolvedValue(undefined) };
    service = Object.assign(Object.create(RefundsService.prototype) as object, {
      logger: new Logger('RefundsService'),
      refundRepo: ds.getRepository(LydiaRefund),
      associations: { canManagePayoutAccount: jest.fn().mockResolvedValue(true) },
      notifier,
    }) as unknown as RefundsService;
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });

  beforeEach(() => {
    post = jest.spyOn(axios, 'post').mockResolvedValue({ data: { ok: true } });
    notifier.tell.mockClear();
  });
  afterEach(() => post.mockRestore());

  afterAll(async () => {
    jest.restoreAllMocks();
    await ds?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  /** A boutique payment of `type`, settled: product, paid attempt, record (and the tier tag). */
  async function boutiquePayment(
    type: 'membership' | 'balance_topup' | 'other',
    amount = 1000,
    associationId = ASSO
  ) {
    const buyer = randomUUID().replace(/-/g, '').repeat(2);
    const product = await ds.getRepository(AssociationProduct).save(
      ds.getRepository(AssociationProduct).create({
        associationId: ASSO,
        name: `Product ${type}`,
        type,
        amountCents: amount,
      } as Partial<AssociationProduct>)
    );
    const paymentIntentId = String(Math.floor(Math.random() * 1e9));
    const record = await ds.getRepository(PurchaseRecord).save(
      ds.getRepository(PurchaseRecord).create({
        userId: buyer,
        source: 'product',
        productId: product.id,
        amountCents: amount,
        paymentMethod: 'online',
        status: 'paid',
        stripePaymentIntentId: paymentIntentId,
        associationId,
        productName: product.name,
      })
    );
    await ds.getRepository(ProductCheckout).save(
      ds.getRepository(ProductCheckout).create({
        productId: product.id,
        userId: buyer,
        associationId,
        paymentAssociationId: ASSO,
        vendorToken: VENDOR,
        amountCents: amount,
        currency: 'eur',
        productName: product.name,
        status: 'paid',
        expiresAt: new Date(),
        purchaseRecordId: record.id,
      })
    );
    if (type === 'membership') {
      await ds.getRepository(UserTag).save(
        ds.getRepository(UserTag).create({
          userId: buyer,
          tagName: `cotisant:bde-${product.id.slice(0, 6)}`,
          issuingAssocId: ASSO,
          grantedBy: 'system',
          expiresAt: null,
          metadata: { paymentIntentId },
        })
      );
    }
    return { record, product, buyer };
  }

  /** A paid form answer and its record; `grantsCotisation` adds the tier the answer granted. */
  async function formPayment(grantsCotisation: boolean, amount = 800) {
    const buyer = randomUUID().replace(/-/g, '').repeat(2);
    const formId = randomUUID();
    await ds.query(`INSERT INTO forms (id, "grantsCotisation") VALUES ($1, $2)`, [
      formId,
      grantsCotisation,
    ]);
    const submission = await ds.getRepository(Submission).save(
      ds.getRepository(Submission).create({
        formId,
        userId: buyer,
        answers: {},
        totalPaid: amount,
        paymentStatus: 'paid',
      })
    );
    await ds.query(
      `UPDATE submissions SET "lydiaOrderRef" = $2, "lydiaVendorToken" = $3 WHERE id = $1`,
      [submission.id, `form:${submission.id}:0a1b2c3d`, VENDOR]
    );
    const record = await ds.getRepository(PurchaseRecord).save(
      ds.getRepository(PurchaseRecord).create({
        userId: buyer,
        source: 'form',
        formId,
        submissionId: submission.id,
        amountCents: amount,
        paymentMethod: 'online',
        status: 'paid',
        associationId: ASSO,
        productName: 'Gala',
      })
    );
    if (grantsCotisation) {
      await ds.getRepository(UserTag).save(
        ds.getRepository(UserTag).create({
          userId: buyer,
          tagName: `cotisant:form-${formId.slice(0, 6)}`,
          issuingAssocId: ASSO,
          grantedBy: 'system',
          expiresAt: null,
          metadata: { submissionId: submission.id },
        })
      );
    }
    return { record, submission, buyer, formId };
  }

  const refundOf = (recordId: string) =>
    ds.getRepository(LydiaRefund).find({ where: { purchaseRecordId: recordId } });
  const statusOf = async (recordId: string) =>
    (await ds.getRepository(PurchaseRecord).findOneByOrFail({ id: recordId })).status;
  const tagsOf = (userId: string) => ds.getRepository(UserTag).find({ where: { userId } });
  const total = (key = randomUUID()) => ({
    kind: 'total' as const,
    reason: 'Event cancelled',
    idempotencyKey: key,
  });
  const partial = (amountCents: number, key = randomUUID()) => ({
    kind: 'partial' as const,
    amountCents,
    reason: 'Partial goodwill',
    idempotencyKey: key,
  });

  it('writes the refund PENDING before Lydia is asked, then records the answer and the audit', async () => {
    const { record } = await boutiquePayment('other');
    let seenDuringCall: string | undefined;
    post.mockImplementation(
      async (_url: string, body: { orderRef: string; amountCents: number }) => {
        const [row] = await refundOf(record.id);
        seenDuringCall = row?.status;
        expect(body.amountCents).toBe(1000);
        expect(body.orderRef).toMatch(/^product:[0-9a-f-]{36}:[0-9a-f-]{36}$/);
        return { data: { ok: true } };
      }
    );
    const view = await service.refund(ASSO, record.id, MANAGER, total());
    expect(seenDuringCall).toBe('pending');
    expect(view).toMatchObject({ state: 'refunded', kind: 'total', amountCents: 1000 });
    const [row] = await refundOf(record.id);
    // The audit: who, when, how much, which payment, why, and Lydia's answer.
    expect(row).toMatchObject({
      requestedByUserId: MANAGER,
      purchaseRecordId: record.id,
      amountCents: 1000,
      kind: 'total',
      reason: 'Event cancelled',
      status: 'confirmed',
      outcome: 'refunded',
      sideEffect: 'purchase-refunded',
      vendorToken: VENDOR,
    });
    expect(row.requestedAt).toBeInstanceOf(Date);
    expect(row.answeredAt).toBeInstanceOf(Date);
    expect(notifier.tell).toHaveBeenCalledTimes(1);
  });

  it('an unknown outcome stays pending, answers LYDIA_REFUND_UNCONFIRMED and blocks every retry until the re-check', async () => {
    const { record } = await boutiquePayment('other');
    post.mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }));
    await expect(service.refund(ASSO, record.id, MANAGER, partial(300))).rejects.toMatchObject({
      status: 504,
      response: { code: CORE_REFUND_CODES.unconfirmed },
    });
    const [row] = await refundOf(record.id);
    expect(row).toMatchObject({ status: 'pending', outcome: 'no-answer' });

    // A second refund - another click, another key - is refused BEFORE Lydia is asked again.
    post.mockClear();
    await expect(service.refund(ASSO, record.id, MANAGER, partial(300))).rejects.toMatchObject({
      response: { code: LYDIA_REFUND_IN_FLIGHT },
    });
    expect(post).not.toHaveBeenCalled();

    // The re-check: the manager read Lydia's statement - it did not go through - and only then a new
    // refund is asked, and sent.
    const settled = await service.resolve(ASSO, row.id, MANAGER, false);
    expect(settled.state).toBe('refused');
    const [after] = await refundOf(record.id);
    expect(after).toMatchObject({
      status: 'refused',
      outcome: 'declared-not-refunded',
      resolvedByUserId: MANAGER,
    });
    await expect(service.refund(ASSO, record.id, MANAGER, partial(300))).resolves.toMatchObject({
      state: 'refunded',
    });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('a resent click (the same key) answers the same refund and sends nothing', async () => {
    const { record } = await boutiquePayment('other');
    const key = randomUUID();
    await service.refund(ASSO, record.id, MANAGER, partial(200, key));
    await service.refund(ASSO, record.id, MANAGER, partial(200, key));
    expect(post).toHaveBeenCalledTimes(1);
    expect(await refundOf(record.id)).toHaveLength(1);
  });

  it('refunds ONCE when eight refunds of one payment race, whatever their keys', async () => {
    const { record } = await boutiquePayment('other');
    post.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return { data: { ok: true } };
    });
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => service.refund(ASSO, record.id, MANAGER, total()))
    );
    expect(post).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected')) {
      const code = ((r as PromiseRejectedResult).reason as { response?: { code?: string } })
        .response?.code;
      // Refused while the first is in flight, or after it (summed, or the payment already refunded).
      expect([
        LYDIA_REFUND_IN_FLIGHT,
        LYDIA_REFUND_EXCEEDS_PAID,
        LYDIA_REFUND_NOT_REFUNDABLE,
      ]).toContain(code);
    }
    const rows = await refundOf(record.id);
    expect(rows.filter((r) => r.status === 'confirmed')).toHaveLength(1);
  });

  it('refunds ONCE when eight partial refunds race: the sum never passes the amount paid', async () => {
    const { record } = await boutiquePayment('other', 1000);
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => service.refund(ASSO, record.id, MANAGER, partial(400)))
    );
    const refunded = (await refundOf(record.id))
      .filter((r) => r.status === 'confirmed')
      .reduce((s, r) => s + r.amountCents, 0);
    expect(refunded).toBeLessThanOrEqual(1000);
    expect(post.mock.calls.length).toBe(results.filter((r) => r.status === 'fulfilled').length);
  });

  it('caps the sum of refunds at the amount paid', async () => {
    const { record } = await boutiquePayment('other', 1000);
    await service.refund(ASSO, record.id, MANAGER, partial(600));
    await expect(service.refund(ASSO, record.id, MANAGER, partial(500))).rejects.toMatchObject({
      response: { code: LYDIA_REFUND_EXCEEDS_PAID, remainingCents: 400 },
    });
    await expect(service.refund(ASSO, record.id, MANAGER, total())).rejects.toMatchObject({
      response: { code: LYDIA_REFUND_EXCEEDS_PAID },
    });
    await expect(service.refund(ASSO, record.id, MANAGER, partial(400))).resolves.toMatchObject({
      state: 'refunded',
    });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('a PARTIAL refund withdraws nothing', async () => {
    const { record, buyer } = await boutiquePayment('membership');
    await service.refund(ASSO, record.id, MANAGER, partial(500));
    expect(await statusOf(record.id)).toBe('paid');
    expect(await tagsOf(buyer)).toHaveLength(1);
    const [row] = await refundOf(record.id);
    expect(row.sideEffect).toBeNull();
  });

  it('a TOTAL refund of a membership revokes the tier this payment delivered', async () => {
    const { record, buyer } = await boutiquePayment('membership');
    await service.refund(ASSO, record.id, MANAGER, total());
    expect(await statusOf(record.id)).toBe('refunded');
    expect(await tagsOf(buyer)).toHaveLength(0);
    expect((await refundOf(record.id))[0].sideEffect).toBe('cotisation-revoked');
  });

  it('a TOTAL refund of a membership keeps a tier another payment renewed since', async () => {
    const { record, buyer } = await boutiquePayment('membership');
    await ds.query(
      `UPDATE user_tags SET metadata = '{"paymentIntentId":"a-later-payment"}' WHERE "userId" = $1`,
      [buyer]
    );
    await service.refund(ASSO, record.id, MANAGER, total());
    expect(await tagsOf(buyer)).toHaveLength(1);
    expect((await refundOf(record.id))[0].sideEffect).toBe('cotisation-not-held');
  });

  it('a TOTAL refund of a form answer frees its seat and revokes the tier it granted', async () => {
    const { record, submission, buyer } = await formPayment(true);
    await service.refund(ASSO, record.id, MANAGER, total());
    const [after] = await ds.query(`SELECT "paymentStatus" FROM submissions WHERE id = $1`, [
      submission.id,
    ]);
    expect(after.paymentStatus).toBe('refunded');
    expect(await tagsOf(buyer)).toHaveLength(0);
    expect(await statusOf(record.id)).toBe('refunded');
    expect((await refundOf(record.id))[0].sideEffect).toBe('seat-freed-cotisation-revoked');
    const [, sent] = post.mock.calls[0] as [string, { orderRef: string }];
    expect(sent.orderRef).toBe(`form:${submission.id}:0a1b2c3d`);
  });

  it('a TOTAL refund of a form answer that grants no tier frees the seat only', async () => {
    const { record, submission } = await formPayment(false);
    await service.refund(ASSO, record.id, MANAGER, total());
    const [after] = await ds.query(`SELECT "paymentStatus" FROM submissions WHERE id = $1`, [
      submission.id,
    ]);
    expect(after.paymentStatus).toBe('refunded');
    expect((await refundOf(record.id))[0].sideEffect).toBe('seat-freed');
  });

  it('a TOTAL refund of a Cercle top-up gives the money back and touches no balance and no tier', async () => {
    const { record, buyer } = await boutiquePayment('balance_topup');
    const before = await tagsOf(buyer);
    await service.refund(ASSO, record.id, MANAGER, total());
    expect((await refundOf(record.id))[0].sideEffect).toBe('topup-balance-unchanged');
    expect(await tagsOf(buyer)).toEqual(before);
  });

  it('a TOTAL refund of a product deleted since touches no tier, and the payment is still refunded', async () => {
    const { record, product, buyer } = await boutiquePayment('membership');
    await ds.getRepository(AssociationProduct).delete({ id: product.id });
    await service.refund(ASSO, record.id, MANAGER, total());
    expect((await refundOf(record.id))[0].sideEffect).toBe('not-applied-unidentified');
    expect(await statusOf(record.id)).toBe('refunded');
    expect(await tagsOf(buyer)).toHaveLength(1);
  });

  it('a refusal Lydia answered records the typed code and refunds nothing', async () => {
    const { record } = await boutiquePayment('membership');
    post.mockRejectedValueOnce(
      Object.assign(new Error('409'), {
        response: { status: 409, data: { code: 'LYDIA_REFUND_TRANSACTION_NOT_REFUNDABLE' } },
      })
    );
    await expect(service.refund(ASSO, record.id, MANAGER, total())).rejects.toMatchObject({
      response: { code: 'LYDIA_REFUND_TRANSACTION_NOT_REFUNDABLE' },
    });
    expect((await refundOf(record.id))[0]).toMatchObject({
      status: 'refused',
      outcome: 'LYDIA_REFUND_TRANSACTION_NOT_REFUNDABLE',
      sideEffect: null,
    });
    expect(await statusOf(record.id)).toBe('paid');
  });

  it('refuses a payment its association no longer holds the Business of, and one Canari cannot trace', async () => {
    const { record } = await boutiquePayment('other');
    await ds.query(
      `UPDATE product_checkouts SET "vendorToken" = 'another' WHERE "purchaseRecordId" = $1`,
      [record.id]
    );
    await expect(service.refund(ASSO, record.id, MANAGER, total())).rejects.toMatchObject({
      response: { code: LYDIA_REFUND_NOT_REFUNDABLE, reason: 'other-business' },
    });
    const { record: form } = await formPayment(false);
    await ds.query(`UPDATE purchase_records SET "submissionId" = NULL WHERE id = $1`, [form.id]);
    await expect(service.refund(ASSO, form.id, MANAGER, total())).rejects.toMatchObject({
      response: { code: LYDIA_REFUND_NOT_REFUNDABLE, reason: 'untraceable' },
    });
    expect(post).not.toHaveBeenCalled();
  });

  it('describes each payment: refundable or why not, and what a total refund withdraws', async () => {
    const { record } = await boutiquePayment('balance_topup');
    const { standings } = await service.describe(ASSO);
    expect(standings.find((s) => s.purchaseRecordId === record.id)).toMatchObject({
      refundable: true,
      withdrawal: 'topup',
      paidCents: 1000,
      refundedCents: 0,
    });
  });

  it('states the payments, the confirmed refunds as negatives, and the totals - no payer', async () => {
    const statement = await service.statement(ASSO);
    const kinds = new Set(statement.lines.map((l) => l.operation));
    expect(kinds).toEqual(new Set(['payment', 'refund-total', 'refund-partial']));
    for (const line of statement.lines) {
      expect(line.date).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
      expect(line.operation === 'payment' ? line.amountCents > 0 : line.amountCents < 0).toBe(true);
    }
    const sum = (op: (o: string) => boolean) =>
      statement.lines.filter((l) => op(l.operation)).reduce((s, l) => s + l.amountCents, 0);
    expect(statement.receivedCents).toBe(sum((o) => o === 'payment'));
    expect(statement.refundedCents).toBe(-sum((o) => o !== 'payment'));
    // The statement names no payer: no account id written by the fixtures appears in it.
    const text = JSON.stringify(statement);
    const buyers = (await ds.query(`SELECT DISTINCT "userId" FROM purchase_records`)) as {
      userId: string;
    }[];
    for (const { userId } of buyers) expect(text).not.toContain(userId);
  });

  /** Whether the call lock of `refundId` is free, asked from another session (and given back). */
  async function callLockFree(refundId: string): Promise<boolean> {
    const [row] = (
      await admin.query(`SELECT pg_try_advisory_lock(${REFUND_CALL_LOCK_KEY}) AS free`, [refundId])
    ).rows as { free: boolean }[];
    if (row.free)
      await admin.query(`SELECT pg_advisory_unlock(${REFUND_CALL_LOCK_KEY})`, [refundId]);
    return row.free;
  }

  it('WHILE Lydia is asked: the call lock is held, the sweep leaves the row, and nothing can be declared', async () => {
    const { record } = await boutiquePayment('other');
    let during: { swept: number; outcome: string | null; free: boolean; state?: string } | null =
      null;
    let check: Promise<unknown> | null = null;
    post.mockImplementation(async () => {
      const [row] = await refundOf(record.id);
      const swept = await service.sweepAbandoned();
      const { standings } = await service.describe(ASSO);
      during = {
        swept,
        outcome: (await refundOf(record.id))[0].outcome,
        free: await callLockFree(row.id),
        state: standings.find((s) => s.purchaseRecordId === record.id)?.openRefund?.state,
      };
      check = service.resolve(ASSO, row.id, MANAGER, false).catch((e: unknown) => e);
      await check;
      return { data: { ok: true } };
    });
    await expect(service.refund(ASSO, record.id, MANAGER, total())).resolves.toMatchObject({
      state: 'refunded',
    });
    expect(during).toEqual({ swept: 0, outcome: null, free: false, state: 'in-progress' });
    await expect(check).resolves.toMatchObject({ response: { code: LYDIA_REFUND_IN_FLIGHT } });
    // Released once the outcome is written.
    expect(await callLockFree((await refundOf(record.id))[0].id)).toBe(true);
  });

  it('a call abandoned by a dead process (no outcome, lock free) is swept to no-answer, ERROR logged, and checkable', async () => {
    const { record } = await boutiquePayment('other');
    const [row] = (await ds.query(
      `INSERT INTO lydia_refunds ("purchaseRecordId", "associationId", "vendorToken", "orderRef", kind,
         "amountCents", reason, "idempotencyKey", "requestedByUserId")
       VALUES ($1, $2, $3, 'product:x:y', 'partial', 100, 'r', $4, $5) RETURNING id`,
      [record.id, ASSO, VENDOR, randomUUID(), MANAGER]
    )) as { id: string }[];
    const error = jest.spyOn(Logger.prototype, 'error');
    error.mockClear();
    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    expect((await refundOf(record.id))[0]).toMatchObject({
      status: 'pending',
      outcome: 'no-answer',
    });
    expect(error.mock.calls.map(String).join(' | ')).toContain(`${row.id}: its call was abandoned`);
    const { standings } = await service.describe(ASSO);
    expect(standings.find((s) => s.purchaseRecordId === record.id)?.openRefund).toEqual({
      id: row.id,
      state: 'unconfirmed',
    });
    await expect(service.resolve(ASSO, row.id, MANAGER, false)).resolves.toMatchObject({
      state: 'refused',
    });
  });

  it('a row whose call lock another process holds is NOT swept: a call on another replica is in flight', async () => {
    const { record } = await boutiquePayment('other');
    const [row] = (await ds.query(
      `INSERT INTO lydia_refunds ("purchaseRecordId", "associationId", "vendorToken", "orderRef", kind,
         "amountCents", reason, "idempotencyKey", "requestedByUserId")
       VALUES ($1, $2, $3, 'product:x:y', 'partial', 100, 'r', $4, $5) RETURNING id`,
      [record.id, ASSO, VENDOR, randomUUID(), MANAGER]
    )) as { id: string }[];
    await admin.query(`SELECT pg_advisory_lock(${REFUND_CALL_LOCK_KEY})`, [row.id]);
    try {
      await service.sweepAbandoned();
      expect((await refundOf(record.id))[0].outcome).toBeNull();
    } finally {
      await admin.query(`SELECT pg_advisory_unlock(${REFUND_CALL_LOCK_KEY})`, [row.id]);
    }
    await service.sweepAbandoned();
    expect((await refundOf(record.id))[0].outcome).toBe('no-answer');
  });

  it('a late Lydia answer on a refund already settled is kept beside it and logged ERROR', async () => {
    const { record } = await boutiquePayment('other');
    post.mockRejectedValueOnce(new Error('timeout'));
    await expect(service.refund(ASSO, record.id, MANAGER, partial(100))).rejects.toBeDefined();
    const [row] = await refundOf(record.id);
    await service.resolve(ASSO, row.id, MANAGER, false);
    const error = jest.spyOn(Logger.prototype, 'error');
    error.mockClear();
    await (
      service as unknown as {
        settle(m: unknown, id: string, o: unknown, by: null): Promise<unknown>;
      }
    ).settle(ds.manager, row.id, { status: 'confirmed', outcome: 'refunded' }, null);
    expect((await refundOf(record.id))[0]).toMatchObject({
      status: 'refused',
      outcome: 'declared-not-refunded',
      lateOutcome: 'refunded',
    });
    expect(error.mock.calls.map(String).join(' | ')).toContain('AFTER the refund was settled');
    // Surfaced: on the managers' view, and in the hourly report's count.
    const { refunds } = await service.describe(ASSO);
    expect(refunds.find((r) => r.id === row.id)?.lateAnswer).toBe('refunded');
    expect(await service.countContradicted()).toBeGreaterThanOrEqual(1);
    const before = await service.countContradicted();
    await ds.query(
      `UPDATE lydia_refunds SET "lateOutcome" = 'LYDIA_REFUND_REJECTED' WHERE id = $1`,
      [row.id]
    );
    // A late answer AGREEING with the settlement is no contradiction.
    expect(await service.countContradicted()).toBe(before - 1);
  });

  it('Lydia refunded and the recording failed: unrecorded, blocking, then recorded by a manager', async () => {
    const { record } = await boutiquePayment('other');
    const settle = jest
      .spyOn(service as unknown as { settle: () => Promise<unknown> }, 'settle')
      .mockRejectedValueOnce(new Error('deadlock detected'));
    await expect(service.refund(ASSO, record.id, MANAGER, partial(100))).resolves.toMatchObject({
      state: 'unrecorded',
    });
    settle.mockRestore();
    const [row] = await refundOf(record.id);
    expect(row).toMatchObject({ status: 'pending', outcome: 'refunded-unrecorded' });
    await expect(service.refund(ASSO, record.id, MANAGER, partial(100))).rejects.toMatchObject({
      response: { code: LYDIA_REFUND_IN_FLIGHT },
    });
    const { standings } = await service.describe(ASSO);
    expect(standings.find((s) => s.purchaseRecordId === record.id)?.openRefund?.state).toBe(
      'unrecorded'
    );
    await expect(service.resolve(ASSO, row.id, MANAGER, false)).rejects.toMatchObject({
      response: { code: LYDIA_REFUND_NOT_PENDING },
    });
    await expect(service.resolve(ASSO, row.id, MANAGER, true)).resolves.toMatchObject({
      state: 'refunded',
    });
    expect((await refundOf(record.id))[0]).toMatchObject({
      status: 'confirmed',
      outcome: 'refunded',
      resolvedByUserId: MANAGER,
    });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("refunds only its own payments or an approved delegate's, and the refund sits on the payer's association statement", async () => {
    const child = randomUUID();
    await ds.query(`INSERT INTO associations (id, name) VALUES ($1, 'Club')`, [child]);
    const { record } = await boutiquePayment('other', 700, child);
    await expect(service.refund(ASSO, record.id, MANAGER, total())).rejects.toMatchObject({
      status: 404,
    });
    await ds.query(
      `UPDATE associations SET "paymentParentAssociationId" = $2, "paymentDelegationStatus" = 'pending' WHERE id = $1`,
      [child, ASSO]
    );
    await expect(service.refund(ASSO, record.id, MANAGER, total())).rejects.toMatchObject({
      status: 404,
    });
    expect(post).not.toHaveBeenCalled();
    await ds.query(`UPDATE associations SET "paymentDelegationStatus" = 'approved' WHERE id = $1`, [
      child,
    ]);
    await expect(service.refund(ASSO, record.id, MANAGER, partial(200))).resolves.toMatchObject({
      state: 'refunded',
    });
    const parent = await service.statement(ASSO);
    expect(parent.lines.every((l) => l.item !== '')).toBe(true);
    expect(parent.refundedCents).toBe(
      -parent.lines.filter((l) => l.operation !== 'payment').reduce((s, l) => s + l.amountCents, 0)
    );
    const own = await service.statement(child);
    expect(own).toMatchObject({ receivedCents: 700, refundedCents: 200 });
    expect(own.lines.find((l) => l.operation === 'refund-partial')).toMatchObject({
      item: 'Product other',
      amountCents: -200,
    });
  });

  it('a replay of a refused refund answers 200 with its state, never a refund', async () => {
    const { record } = await boutiquePayment('other');
    const key = randomUUID();
    post.mockRejectedValueOnce(
      Object.assign(new Error('409'), {
        response: { status: 409, data: { code: 'LYDIA_REFUND_REJECTED' } },
      })
    );
    await expect(service.refund(ASSO, record.id, MANAGER, partial(100, key))).rejects.toBeDefined();
    await expect(
      service.refund(ASSO, record.id, MANAGER, partial(100, key))
    ).resolves.toMatchObject({ state: 'refused', refusal: 'LYDIA_REFUND_REJECTED' });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('ONE refund holds ONE connection: it completes on a pool of one', async () => {
    const { record } = await boutiquePayment('membership');
    const narrow = new DataSource({
      ...options(false, [
        PurchaseRecord,
        UserTag,
        ProductCheckout,
        AssociationProduct,
        Submission,
        LydiaRefund,
        Association,
      ]),
      extra: {
        options: `-c search_path=${schema},public`,
        max: 1,
        connectionTimeoutMillis: 2_000,
      },
    });
    await narrow.initialize();
    try {
      const single = Object.assign(Object.create(RefundsService.prototype) as object, {
        logger: new Logger('RefundsService'),
        refundRepo: narrow.getRepository(LydiaRefund),
        associations: { canManagePayoutAccount: jest.fn() },
        notifier,
      }) as unknown as RefundsService;
      // A second connection asked by the settle path would wait for the only one, and time out.
      await expect(single.refund(ASSO, record.id, MANAGER, total())).resolves.toMatchObject({
        state: 'refunded',
      });
      expect((await refundOf(record.id))[0]).toMatchObject({
        status: 'confirmed',
        sideEffect: 'cotisation-revoked',
      });
    } finally {
      await narrow.destroy();
    }
  });

  it("the settle path runs on the refund's own connection, the one holding its call lock", async () => {
    const { record } = await boutiquePayment('other');
    const create = jest.spyOn(ds, 'createQueryRunner');
    const settle = jest.spyOn(service as unknown as { settle: () => Promise<unknown> }, 'settle');
    try {
      await service.refund(ASSO, record.id, MANAGER, partial(100));
      const runner = create.mock.results[0].value as { manager: unknown };
      expect((settle.mock.calls[0] as unknown[])[0]).toBe(runner.manager);
    } finally {
      create.mockRestore();
      settle.mockRestore();
    }
  });

  it('a call is swept only once its lock is free AND its start is past the bound on the database clock', async () => {
    const { record } = await boutiquePayment('other');
    const [row] = (await ds.query(
      `INSERT INTO lydia_refunds ("purchaseRecordId", "associationId", "vendorToken", "orderRef", kind,
         "amountCents", reason, "idempotencyKey", "requestedByUserId", "calledAt")
       VALUES ($1, $2, $3, 'product:x:y', 'partial', 100, 'r', $4, $5, now()) RETURNING id`,
      [record.id, ASSO, VENDOR, randomUUID(), MANAGER]
    )) as { id: string }[];
    // Lock free (its connection lost) but the call started just now: it may still be running.
    await service.sweepAbandoned();
    expect((await refundOf(record.id))[0].outcome).toBeNull();
    const { standings } = await service.describe(ASSO);
    expect(standings.find((s) => s.purchaseRecordId === record.id)?.openRefund?.state).toBe(
      'in-progress'
    );
    // Past the bound: it has ended.
    await ds.query(
      `UPDATE lydia_refunds SET "calledAt" = now() - make_interval(secs => $2::double precision / 1000 + 1) WHERE id = $1`,
      [row.id, REFUND_CALL_BOUND_MS]
    );
    await service.sweepAbandoned();
    expect((await refundOf(record.id))[0].outcome).toBe('no-answer');
  });

  it('the call start is stamped on the database before core is asked', async () => {
    const { record } = await boutiquePayment('other');
    let stamped: Date | null | undefined;
    post.mockImplementation(async () => {
      stamped = (await refundOf(record.id))[0].calledAt;
      return { data: { ok: true } };
    });
    await service.refund(ASSO, record.id, MANAGER, partial(100));
    expect(stamped).toBeInstanceOf(Date);
  });

  it('a connection whose call lock cannot be released is destroyed, never pooled with the lock', async () => {
    const { record } = await boutiquePayment('other');
    const unlock = jest
      .spyOn(service as unknown as { unlockCall: () => Promise<boolean> }, 'unlockCall')
      .mockResolvedValueOnce(false);
    try {
      await service.refund(ASSO, record.id, MANAGER, partial(100));
    } finally {
      unlock.mockRestore();
    }
    // The destroyed connection took its session lock with it.
    expect(await callLockFree((await refundOf(record.id))[0].id)).toBe(true);
  });

  it("an erased manager's refunds stay, their name on them anonymised", async () => {
    const { record } = await boutiquePayment('other');
    post.mockRejectedValueOnce(new Error('timeout'));
    await expect(service.refund(ASSO, record.id, MANAGER, partial(100))).rejects.toBeDefined();
    const [row] = await refundOf(record.id);
    await service.resolve(ASSO, row.id, MANAGER, true);
    for (const statement of ERASURE_STATEMENTS.filter((s) => s.sql.includes('lydia_refunds'))) {
      await ds.query(statement.sql, erasureParams(statement, MANAGER));
    }
    const [after] = await refundOf(record.id);
    expect(after.requestedByUserId).not.toBe(MANAGER);
    expect(after.resolvedByUserId).not.toBe(MANAGER);
    expect(after).toMatchObject({ amountCents: 100, status: 'confirmed' });
  });
});
