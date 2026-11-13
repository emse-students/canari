/**
 * THE PRICED GRID AGAINST A REAL PostgreSQL (WP-G1, migration 137).
 *
 * The unit spec (`forms.service.product-grid.spec.ts`) proves the arithmetic on an in-memory store.
 * What only a database shows: migration 137 as written (idempotent, nullable jsonb), the lines
 * stored and read back through jsonb, a retry that REUSES its pending row rewriting answer, lines
 * and total together, the paid order holding its seat, and the seat a refund frees. core-service is
 * the `axios.post` mock: what Lydia was asked to charge is read from it.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; CI's
 * `test-social-integration` sets it. Locally:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- product-grid.integration
 *
 * Everything happens in a throwaway schema, dropped at the end.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Logger } from '@nestjs/common';
import axios from 'axios';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { Form } from './entities/form.entity';
import { Submission } from './entities/submission.entity';
import { FormReminder } from './entities/form-reminder.entity';
import { OpeningReminder } from '../openings/entities/opening-reminder.entity';
import { FormRespondent } from './entities/form-respondent.entity';
import { PurchaseRecord } from '../users/entities/purchase-record.entity';
import { PurchaseRecordService } from '../users/purchase-record.service';
import { FormsService } from './forms.service';
import type { ProductGridLine } from './product-grid-contract';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const ASSO = '00000000-0000-4000-8000-0000000000b7';
const COTISANT = 'c'.repeat(64);
const MEMBER = 'd'.repeat(64);

const GRID_ITEM = {
  id: 'q-grid',
  label: 'Sweat capuche',
  type: 'product_grid',
  required: true,
  productGrid: {
    rows: [
      { id: 'vert', label: 'Vert' },
      { id: 'noir', label: 'Noir' },
    ],
    columns: [
      { id: 'm', label: 'M' },
      { id: 'l', label: 'L' },
    ],
    maxPerCell: 5,
    closedCells: [],
    pricing: {
      mode: 'per_row',
      tiers: {
        id: 'cot',
        kind: 'cotisation',
        buckets: [{ id: 'cotisant', label: 'Cotisant', anyTier: true }],
      },
      prices: { cotisant: { vert: 2500, noir: 2600 }, _others: { vert: 3000, noir: 3100 } },
    },
  },
};

maybe('the priced grid against PostgreSQL (migration 137)', () => {
  const schema = `product_grid_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let service: FormsService;
  let issued = 0;
  /** Every amount Lydia was asked to charge, in order. */
  const charged: number[] = [];

  beforeAll(async () => {
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [Form, Submission, FormReminder, OpeningReminder, FormRespondent, PurchaseRecord],
      synchronize: true,
      extra: { options: `-c search_path=${schema},public` },
    });
    await ds.initialize();
    // Migration 137 from a table WITHOUT its column, twice: `synchronize` built it from the entity.
    await ds.query(`ALTER TABLE submissions DROP COLUMN lines`);
    const migration = readFileSync(
      join(__dirname, '../migrations/137_submissions_lines.sql'),
      'utf8'
    );
    await ds.query(migration);
    await ds.query(migration);
    await ds.query('RESET lock_timeout');

    service = new FormsService(
      ds.getRepository(Form),
      ds.getRepository(Submission),
      ds.getRepository(OpeningReminder),
      { get: () => 'https://canari.example' } as any,
      {
        assertPaymentsReady: async () => undefined,
        canTakePaymentsNow: async () => true,
        getPaymentAccountId: async () => 'vendor',
        getActivePaymentProvider: async () => 'lydia',
        mayAct: async () => false,
        noteLydiaRequestIssued: async () => undefined,
      } as any,
      { cotisationModeOf: async () => 'simple' } as any,
      new PurchaseRecordService(ds.getRepository(PurchaseRecord)),
      // The cotisant holds the base tier; anybody else none.
      {
        build: async (input: { userId?: string; answers: Record<string, string[]> }) => ({
          promo: null,
          formation: null,
          cotisationTiers: input.userId === COTISANT ? [null] : [],
          answers: input.answers,
        }),
      } as any,
      ds.getRepository(FormRespondent),
      {} as any,
      { enabled: () => false } as any,
      {} as any // FormItemImagesService
    );
    jest.spyOn(axios, 'post').mockImplementation(async (url: string, body: any) => {
      if (url.endsWith('payments/cancel-request')) return { data: { outcome: 'cancelled' } };
      issued += 1;
      charged.push(body.lineItems[0].price_data.unit_amount);
      return {
        data: {
          ok: true,
          url: `https://lydia.example/pay/${issued}`,
          id: String(issued).padStart(32, '0'),
          requestId: String(9000 + issued),
        },
      };
    });
    for (const level of ['log', 'debug', 'warn'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await ds?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  async function gridForm(over: Partial<Form> = {}): Promise<string> {
    const repo = ds.getRepository(Form);
    const form = await repo.save(
      repo.create({
        ownerId: 'owner',
        title: 'Merch',
        basePrice: 0,
        currency: 'eur',
        requiresPayment: true,
        associationId: ASSO,
        allowMultipleSubmissions: true,
        items: [GRID_ITEM],
        ...over,
      } as Partial<Form>)
    );
    return form.id;
  }

  const row = async (id: string) =>
    (
      await ds.query(
        `SELECT "paymentStatus", "totalPaid", answers, lines FROM submissions WHERE id = $1`,
        [id]
      )
    )[0] as {
      paymentStatus: string;
      totalPaid: number;
      answers: Record<string, unknown>;
      lines: ProductGridLine[] | null;
    };

  it('migration 137 adds a nullable jsonb column, and is idempotent', async () => {
    const [column] = await ds.query(
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'submissions' AND column_name = 'lines'`,
      [schema]
    );
    expect(column).toEqual({ data_type: 'jsonb', is_nullable: 'YES' });
  });

  it('charges a cotisant per row at the cotisant price, and stores the lines as charged', async () => {
    const formId = await gridForm();
    const result: any = await service.submit(formId, {
      userId: COTISANT,
      answers: { 'q-grid': { 'vert:m': 2, 'noir:l': 1, 'vert:l': 0 } },
    } as any);
    expect(charged[charged.length - 1]).toBe(2 * 2500 + 2600);
    const stored = await row(result.submissionId);
    expect(stored.totalPaid).toBe(7600);
    expect(stored.answers).toEqual({ 'q-grid': { 'vert:m': 2, 'noir:l': 1 } });
    expect(stored.lines).toEqual([
      expect.objectContaining({
        rowLabel: 'Vert',
        colLabel: 'M',
        quantity: 2,
        unitCents: 2500,
        lineCents: 5000,
        tierId: 'cotisant',
        tierLabel: 'Cotisant',
      }),
      expect.objectContaining({
        rowLabel: 'Noir',
        colLabel: 'L',
        quantity: 1,
        unitCents: 2600,
        lineCents: 2600,
      }),
    ]);
  });

  it('a form with no grid stores no lines', async () => {
    const formId = await gridForm({
      items: [{ id: 'q1', label: 'Nom', type: 'short_text', required: true }] as any,
      requiresPayment: false,
    });
    const result: any = await service.submit(formId, {
      userId: MEMBER,
      answers: { q1: 'Ada' },
    } as any);
    expect((await row(result.submissionId)).lines).toBeNull();
  });

  it('a retry reuses its pending row and rewrites answer, lines and total together', async () => {
    const formId = await gridForm({ allowMultipleSubmissions: false });
    const first: any = await service.submit(formId, {
      userId: MEMBER,
      answers: { 'q-grid': { 'vert:m': 1 } },
    } as any);
    expect(charged[charged.length - 1]).toBe(3000);
    const second: any = await service.submit(formId, {
      userId: MEMBER,
      answers: { 'q-grid': { 'noir:m': 2 } },
    } as any);
    expect(second.submissionId).toBe(first.submissionId);
    expect(charged[charged.length - 1]).toBe(2 * 3100);
    const stored = await row(first.submissionId);
    expect(stored.totalPaid).toBe(6200);
    expect(stored.answers).toEqual({ 'q-grid': { 'noir:m': 2 } });
    expect(stored.lines?.map((l) => [l.rowId, l.colId, l.quantity])).toEqual([['noir', 'm', 2]]);
    const [{ count }] = await ds.query(
      `SELECT count(*)::int AS count FROM submissions WHERE "formId" = $1`,
      [formId]
    );
    expect(count).toBe(1);
  });

  it('a paid order holds its seat, and the seat a refund frees is taken again', async () => {
    const formId = await gridForm({ maxSubmissions: 1 });
    const paid: any = await service.submit(formId, {
      userId: COTISANT,
      answers: { 'q-grid': { 'vert:m': 1 } },
    } as any);
    await service.markPaid(paid.submissionId, String(9000 + issued));
    expect((await row(paid.submissionId)).paymentStatus).toBe('paid');
    await expect(
      service.submit(formId, { userId: MEMBER, answers: { 'q-grid': { 'vert:m': 1 } } } as any)
    ).rejects.toThrow('Form is full');
    // The status a TOTAL refund writes, under the form lock (`RefundsService`, proven on a grid
    // answer by `refunds.integration.spec.ts`): the lines stay, the seat is free.
    await ds.query(`UPDATE submissions SET "paymentStatus" = 'refunded' WHERE id = $1`, [
      paid.submissionId,
    ]);
    const again: any = await service.submit(formId, {
      userId: MEMBER,
      answers: { 'q-grid': { 'vert:m': 1 } },
    } as any);
    expect(again.checkoutUrl).toMatch(/^https:\/\/lydia\.example\//);
    expect((await row(paid.submissionId)).lines).toHaveLength(1);
  });
});
