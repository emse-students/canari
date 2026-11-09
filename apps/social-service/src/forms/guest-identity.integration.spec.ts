/**
 * A GUEST'S NAME AND E-MAIL, AGAINST POSTGRESQL (migration 138, owner 2026-11-06).
 *
 * The unit spec (`forms.service.guest-identity.spec.ts`) proves the rule; this proves the columns:
 * migration 138 applied twice to tables without them, a guest's answer that stores exactly what the
 * form asked, and a paid guest whose asked e-mail is the one Lydia's request is sent to - typed once.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; CI sets it.
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- guest-identity.integration
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
import { FormRespondent } from './entities/form-respondent.entity';
import { PurchaseRecord } from '../users/entities/purchase-record.entity';
import { PurchaseRecordService } from '../users/purchase-record.service';
import { FormsService } from './forms.service';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const ASSO = '00000000-0000-4000-8000-0000000000b8';

maybe("a guest's name and e-mail, against PostgreSQL (migration 138)", () => {
  const schema = `guest_identity_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let service: FormsService;
  /** The body of the last payment request issued: where its `payerEmail` is read. */
  let lastCheckout: Record<string, unknown> | null = null;
  const savedSecret = process.env.INTERNAL_SECRET;

  beforeAll(async () => {
    process.env.INTERNAL_SECRET = 'internal-secret-for-it';
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [Form, Submission, FormReminder, FormRespondent, PurchaseRecord],
      synchronize: true,
      extra: { options: `-c search_path=${schema},public` },
    });
    await ds.initialize();
    // The tables as production has them BEFORE 138 (`synchronize` built the columns from the
    // entities), then the migration file itself, twice: it must be idempotent.
    await ds.query(`ALTER TABLE forms DROP COLUMN "guestFields"`);
    await ds.query(
      `ALTER TABLE submissions DROP COLUMN "guestLastName", DROP COLUMN "guestFirstName", DROP COLUMN "guestEmail"`
    );
    const migration = readFileSync(
      join(__dirname, '../migrations/138_forms_guest_identity.sql'),
      'utf8'
    );
    await ds.query(migration);
    await ds.query(migration);

    service = new FormsService(
      ds.getRepository(Form),
      ds.getRepository(Submission),
      ds.getRepository(FormReminder),
      { get: () => 'https://canari.example' } as any,
      {
        assertPaymentsReady: async () => undefined,
        canTakePaymentsNow: async () => true,
        getPaymentAccountId: async () => 'vendor',
        getActivePaymentProvider: async () => 'lydia',
        mayAct: async () => false,
      } as any,
      { grantCotisant: jest.fn() } as any,
      new PurchaseRecordService(ds.getRepository(PurchaseRecord)),
      { build: async () => ({ answers: {} }) } as any,
      ds.getRepository(FormRespondent),
      {} as any,
      { enabled: () => false } as any,
      {} as any
    );
    jest.spyOn(axios, 'post').mockImplementation(async (_url: string, body: any) => {
      lastCheckout = body;
      return {
        data: {
          ok: true,
          url: 'https://lydia.example/pay/1',
          id: '0123456789abcdef0123456789abcdef',
          requestId: '9001',
        },
      };
    });
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterAll(async () => {
    if (savedSecret === undefined) delete process.env.INTERNAL_SECRET;
    else process.env.INTERNAL_SECRET = savedSecret;
    jest.restoreAllMocks();
    await ds?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  async function publicForm(over: Partial<Form>): Promise<string> {
    const repo = ds.getRepository(Form);
    const form = await repo.save(
      repo.create({
        ownerId: 'owner',
        title: 'Soiree',
        basePrice: 0,
        currency: 'eur',
        associationId: ASSO,
        isPublic: true,
        allowMultipleSubmissions: true,
        items: [],
        ...over,
      })
    );
    return form.id;
  }

  const stored = (formId: string) =>
    ds.getRepository(Submission).find({ where: { formId }, order: { createdAt: 'ASC' } });

  it('adds four nullable columns, and leaves an existing form asking nothing', async () => {
    const columns: { table_name: string; column_name: string; is_nullable: string }[] =
      await ds.query(
        `SELECT table_name, column_name, is_nullable FROM information_schema.columns
          WHERE table_schema = $1 AND column_name IN ('guestFields', 'guestLastName', 'guestFirstName', 'guestEmail')
          ORDER BY table_name, column_name`,
        [schema]
      );
    expect(columns.map((c) => `${c.table_name}.${c.column_name}:${c.is_nullable}`)).toEqual([
      'forms.guestFields:YES',
      'submissions.guestEmail:YES',
      'submissions.guestFirstName:YES',
      'submissions.guestLastName:YES',
    ]);
    const formId = await publicForm({});
    expect((await service.getPublic(formId)).guestFields).toEqual([]);
  });

  it("stores a free guest answer's names, and nothing on a form that asks nothing", async () => {
    const asks = await publicForm({ guestFields: ['lastName', 'firstName'] });
    await service.submit(
      asks,
      { answers: {}, guestLastName: 'Curie', guestFirstName: 'Marie' },
      'guest'
    );
    const [row] = await stored(asks);
    expect(row).toMatchObject({
      userId: null,
      guestLastName: 'Curie',
      guestFirstName: 'Marie',
      guestEmail: null,
    });

    const silent = await publicForm({});
    await service.submit(silent, { answers: {} }, 'guest');
    const [plain] = await stored(silent);
    expect(plain).toMatchObject({ guestLastName: null, guestFirstName: null, guestEmail: null });
  });

  it('sends Lydia the asked e-mail and stores it - one address, typed once', async () => {
    const formId = await publicForm({
      basePrice: 1200,
      requiresPayment: true,
      guestFields: ['email'],
    });
    const reply = await service.submit(
      formId,
      { answers: {}, guestEmail: 'marie@x.fr' },
      'guest',
      '198.51.100.7'
    );
    expect(reply.checkoutUrl).toBe('https://lydia.example/pay/1');
    expect(lastCheckout?.payerEmail).toBe('marie@x.fr');
    const [row] = await stored(formId);
    expect(row).toMatchObject({ paymentStatus: 'pending', guestEmail: 'marie@x.fr' });
  });

  it('keeps the payment-step address out of the row when the form does not ask for it', async () => {
    const formId = await publicForm({ basePrice: 1200, requiresPayment: true });
    await service.submit(
      formId,
      { answers: {}, payerEmail: 'payer@x.fr' },
      'guest',
      '198.51.100.8'
    );
    expect(lastCheckout?.payerEmail).toBe('payer@x.fr');
    const [row] = await stored(formId);
    expect(row.guestEmail).toBeNull();
    expect(row.email).toBeNull();
  });
});
