/**
 * A GUEST WHO PAYS (WP-P1, `public-paid-forms-chantier.md`), against a REAL PostgreSQL.
 *
 * The unit spec (`forms.service.seat-hold.spec.ts`) runs the service on an in-memory store whose
 * "lock" is a JavaScript mutex. What a guest's payment adds is SQL: a purchase record with no buyer
 * (migration 103 drops a NOT NULL), and guests racing for the last seat of a paid public form, or
 * Lydia's callback and the payer's return racing to record one payment - only a database
 * serialises those transactions. So `FormsService` runs here on a real connection, with only
 * core-service faked (axios: the checkout and the request-state read).
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; CI's
 * `test-social-integration` sets it. Locally:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- guest-payment.integration
 *
 * Everything happens in a throwaway schema, dropped at the end.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Logger } from '@nestjs/common';
import axios from 'axios';
import { Client } from 'pg';
import {
  DataSource,
  EventSubscriber,
  type EntitySubscriberInterface,
  type InsertEvent,
} from 'typeorm';
import { Form } from './entities/form.entity';
import { Submission } from './entities/submission.entity';
import { FormReminder } from './entities/form-reminder.entity';
import { FormRespondent } from './entities/form-respondent.entity';
import { PurchaseRecord } from '../users/entities/purchase-record.entity';
import { PurchaseRecordService } from '../users/purchase-record.service';
import { FormsService } from './forms.service';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

/**
 * Widens the window between a submit's capacity count and its INSERT while `slowInserts` is on, so
 * a race the form lock must close is a race on every run, not on the runs where the scheduler
 * happens to interleave (measured: without it, the control below passed two runs in three). With
 * the lock, the inserts queue behind it and each simply takes longer; without it, every racer has
 * counted the seat free before the first insert lands.
 */
let slowInserts = false;
@EventSubscriber()
class SlowSubmissionInsert implements EntitySubscriberInterface<Submission> {
  listenTo() {
    return Submission;
  }
  async beforeInsert(_event: InsertEvent<Submission>): Promise<void> {
    if (slowInserts) await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const ASSO = '00000000-0000-4000-8000-0000000000a7';
/** A Lydia `request_uuid`: 32 hex digits, no dash. */
const UUID = '0123456789abcdef0123456789abcdef';

maybe('a guest who pays, against PostgreSQL (migration 103)', () => {
  const schema = `guest_payment_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let service: FormsService;
  let issued = 0;

  beforeAll(async () => {
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [Form, Submission, FormReminder, FormRespondent, PurchaseRecord],
      subscribers: [SlowSubmissionInsert],
      synchronize: true,
      extra: { options: `-c search_path=${schema},public` },
    });
    await ds.initialize();
    // The column as production has it BEFORE 103 (`synchronize` builds it from the entity, which is
    // already nullable), then the migration file itself, twice: it must be idempotent.
    await ds.query(`ALTER TABLE purchase_records ALTER COLUMN "userId" SET NOT NULL`);
    const migration = readFileSync(
      join(__dirname, '../migrations/103_purchase_records_guest_buyer.sql'),
      'utf8'
    );
    await ds.query(migration);
    await ds.query(migration);

    const associationsService: any = {
      assertPaymentsReady: async () => undefined,
      getPaymentAccountId: async () => 'vendor',
      getLydiaPayeeAccountId: async () => 'vendor',
      getActivePaymentProvider: async () => 'lydia',
      mayAct: async () => false,
    };
    service = new FormsService(
      ds.getRepository(Form),
      ds.getRepository(Submission),
      ds.getRepository(FormReminder),
      { get: () => 'https://canari.example' } as any,
      associationsService,
      { grantCotisant: jest.fn() } as any,
      new PurchaseRecordService(ds.getRepository(PurchaseRecord)),
      { build: async () => ({ answers: {} }) } as any,
      ds.getRepository(FormRespondent),
      {} as any,
      // FormOrganiserAlertService: switched off, as it ships.
      { enabled: () => false } as any
    );
    jest.spyOn(axios, 'post').mockImplementation(async (url: string) => {
      if (url.endsWith('payments/request-state')) {
        return { data: { ok: true, state: 'paid', raw: '1' } };
      }
      issued += 1;
      return {
        data: {
          ok: true,
          url: `https://lydia.example/pay/${issued}`,
          id: issued === 1 ? UUID : `${String(issued).padStart(32, '0')}`,
          requestId: String(9000 + issued),
        },
      };
    });
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await ds?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  async function publicPaidForm(maxSubmissions: number | null): Promise<string> {
    const form = await ds.getRepository(Form).save(
      ds.getRepository(Form).create({
        ownerId: 'owner',
        title: 'Soiree',
        basePrice: 1200,
        currency: 'eur',
        requiresPayment: true,
        associationId: ASSO,
        isPublic: true,
        allowMultipleSubmissions: true,
        maxSubmissions,
        items: [],
      })
    );
    return form.id;
  }

  it('drops the NOT NULL of purchase_records."userId"', async () => {
    const [column] = await ds.query(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'purchase_records' AND column_name = 'userId'`,
      [schema]
    );
    expect(column.is_nullable).toBe('YES');
  });

  // Control (2026-10-22): `lockFormSeats` removed from `submit` -> eight guests took the seat.
  it('lets eight guests racing for the last seat take it ONCE', async () => {
    const formId = await publicPaidForm(1);
    slowInserts = true;
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        service.submit(formId, { answers: {}, payerEmail: 'g@example.org' } as any, 'guest')
      )
    ).finally(() => (slowInserts = false));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rows = await ds.query(
      `SELECT "userId", "paymentStatus" FROM submissions WHERE "formId" = $1`,
      [formId]
    );
    expect(rows).toEqual([{ userId: null, paymentStatus: 'pending' }]);
  });

  it('records a guest payment ONCE, with no buyer, however many confirmations race', async () => {
    const formId = await publicPaidForm(null);
    issued = 0;
    const { checkoutUrl } = (await service.submit(
      formId,
      { answers: {}, payerEmail: 'g@example.org' } as any,
      'guest'
    )) as { checkoutUrl: string };
    expect(checkoutUrl).toBe('https://lydia.example/pay/1');
    const [{ id }] = await ds.query(`SELECT id FROM submissions WHERE "formId" = $1`, [formId]);

    // The payer's return (`confirmPayment`, by the uuid) and Lydia's callback (by the numeric id)
    // for ONE payment, eight times over, at once.
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        i % 2 === 0 ? service.confirmPayment(id) : service.markPaid(id, '9001')
      )
    );

    const [row] = await ds.query(
      `SELECT "paymentStatus", "userId" FROM submissions WHERE id = $1`,
      [id]
    );
    expect(row).toEqual({ paymentStatus: 'paid', userId: null });
    const records = await ds.query(
      `SELECT "userId", "amountCents", source FROM purchase_records WHERE "formId" = $1`,
      [formId]
    );
    expect(records).toEqual([{ userId: null, amountCents: 1200, source: 'form' }]);
  });
});
