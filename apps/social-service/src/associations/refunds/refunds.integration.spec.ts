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
import { LydiaRefund } from './lydia-refund.entity';
import { RefundsService } from './refunds.service';
import { ERASURE_STATEMENTS, erasureParams } from '../../internal/account-erasure';
import {
  CORE_REFUND_CODES,
  LYDIA_REFUND_EXCEEDS_PAID,
  LYDIA_REFUND_IN_FLIGHT,
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
      `CREATE TABLE associations (id uuid PRIMARY KEY, name text NOT NULL, "lydiaAccountId" varchar NULL)`
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
    await admin.query(`INSERT INTO associations VALUES ($1, 'BDE', $2)`, [ASSO, VENDOR]);
    ds = new DataSource(
      options(false, [
        PurchaseRecord,
        UserTag,
        ProductCheckout,
        AssociationProduct,
        Submission,
        LydiaRefund,
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
  async function boutiquePayment(type: 'membership' | 'balance_topup' | 'other', amount = 1000) {
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
        associationId: ASSO,
        productName: product.name,
      })
    );
    await ds.getRepository(ProductCheckout).save(
      ds.getRepository(ProductCheckout).create({
        productId: product.id,
        userId: buyer,
        associationId: ASSO,
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

  it('a TOTAL refund of a product deleted since withdraws NOTHING: what it was cannot be told', async () => {
    const { record, product } = await boutiquePayment('balance_topup');
    await ds.getRepository(AssociationProduct).delete({ id: product.id });
    await service.refund(ASSO, record.id, MANAGER, total());
    expect((await refundOf(record.id))[0].sideEffect).toBe('not-applied-unidentified');
    expect(await statusOf(record.id)).toBe('paid');
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
