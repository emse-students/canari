/**
 * THE ONE NOTICE BEFORE A CASH HOLD EXPIRES, against a REAL PostgreSQL - migration 179.
 *
 * The unit specs prove the due rule (`cash-reminder.spec.ts`) and the scheduler's claim / release
 * (`forms-reminder.scheduler.spec.ts`); this proves the SQL: migration 179 applied twice to a table
 * without its columns (and its backfill), which answers `dueCashReminders` selects on the database
 * clock, and that the claim is won exactly once and only while the answer still waits for cash.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; CI's
 * `test-social-integration` sets it. Locally:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- cash-reminder.integration
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { Form } from './entities/form.entity';
import { Submission } from './entities/submission.entity';
import { FormSeatHold } from './entities/form-seat-hold.entity';
import { FormsService } from './forms.service';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const ASSO = '00000000-0000-4000-8000-0000000ca501';
const FORM = '00000000-0000-4000-8000-0000000ca5f1';
const GONE_FORM = '00000000-0000-4000-8000-0000000ca5f2';
const MEMBER = 'm'.repeat(64);

maybe('the cash hold notice against PostgreSQL (migration 179)', () => {
  const schema = `cash_reminder_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let forms: FormsService;
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  /** Inserts one answer; times are SQL expressions on the database clock. */
  async function answer(
    id: string,
    over: {
      formId?: string;
      userId?: string | null;
      status?: string;
      expires?: string | null;
      due?: string | null;
      told?: string | null;
    } = {}
  ): Promise<void> {
    const sql = (expr: string | null | undefined) => (expr ? expr : 'NULL');
    await q(
      `INSERT INTO submissions (id, "formId", "userId", "paymentStatus", "paymentMethod", "totalPaid",
         "cashExpiresAt", "cashReminderDueAt", "cashReminderNotifiedAt")
       VALUES ($1, $2, $3, $4, 'cash', 1500, ${sql(over.expires)}, ${sql(over.due)}, ${sql(over.told)})`,
      [
        id,
        over.formId ?? FORM,
        over.userId === undefined ? MEMBER : over.userId,
        over.status ?? 'pending_cash',
      ]
    );
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [Form, Submission, FormSeatHold],
      synchronize: true,
      extra: { options: `-c search_path=${schema},public` },
    });
    await ds.initialize();
    await q(
      `CREATE TABLE associations (id uuid PRIMARY KEY, name text, "logoUrl" text, archived boolean NOT NULL DEFAULT false)`
    );
    await q(`INSERT INTO associations (id, name) VALUES ($1, 'BDE')`, [ASSO]);
    await q(
      `INSERT INTO forms (id, "ownerId", title, "associationId") VALUES ($1, 'owner', 'Gala', $2)`,
      [FORM, ASSO]
    );
    await q(
      `INSERT INTO forms (id, "ownerId", title, "deletedAt") VALUES ($1, 'owner', 'Gone', now())`,
      [GONE_FORM]
    );
    const none = {} as never;
    forms = new FormsService(
      ds.getRepository(Form),
      ds.getRepository(Submission),
      none,
      { get: () => undefined } as never,
      none,
      none,
      none,
      none,
      none,
      none,
      none,
      none
    );
  });

  afterAll(async () => {
    await ds?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    await q('DELETE FROM submissions');
  });

  it('adds the two columns and backfills a waiting answer 24 hours before its expiry, twice over', async () => {
    await q(`ALTER TABLE submissions DROP COLUMN "cashReminderDueAt"`);
    await q(`ALTER TABLE submissions DROP COLUMN "cashReminderNotifiedAt"`);
    await q(`ALTER TABLE submissions DROP COLUMN "paymentCancelOrigin"`);
    await q(
      `INSERT INTO submissions (id, "formId", "userId", "paymentStatus", "paymentMethod", "cashExpiresAt")
       VALUES ('00000000-0000-4000-8000-0000000ca5a1', $1, $2, 'pending_cash', 'cash', now() + interval '3 days'),
              ('00000000-0000-4000-8000-0000000ca5a2', $1, $2, 'paid', 'cash', now() + interval '3 days')`,
      [FORM, MEMBER]
    );
    const migration = readFileSync(
      join(__dirname, '..', 'migrations', '179_cash_hold_reminder.sql'),
      'utf8'
    );
    await q(migration);
    await q(migration);
    await q('RESET lock_timeout');
    const rows: { status: string; lead: number | null; told: Date | null }[] = await q(
      `SELECT "paymentStatus" AS status,
              EXTRACT(EPOCH FROM ("cashExpiresAt" - "cashReminderDueAt"))::int AS lead,
              "cashReminderNotifiedAt" AS told
         FROM submissions ORDER BY "paymentStatus"`
    );
    expect(rows).toEqual([
      { status: 'paid', lead: null, told: null },
      { status: 'pending_cash', lead: 24 * 3600, told: null },
    ]);
    const [cancelOrigin] = await q(
      `SELECT data_type, character_maximum_length AS len FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'submissions'
          AND column_name = 'paymentCancelOrigin'`
    );
    expect(cancelOrigin).toEqual({ data_type: 'character varying', len: 16 });
  });

  it('selects only a member answer still waiting, due, not expired, not told, of a live form', async () => {
    await answer('00000000-0000-4000-8000-0000000ca511', {
      expires: `now() + interval '10 hours'`,
      due: `now() - interval '1 hour'`,
    });
    // Each of these is told nothing.
    await answer('00000000-0000-4000-8000-0000000ca512', {
      expires: `now() + interval '3 days'`,
      due: `now() + interval '2 days'`,
    });
    await answer('00000000-0000-4000-8000-0000000ca513', {
      expires: `now() - interval '1 hour'`,
      due: `now() - interval '1 day'`,
    });
    await answer('00000000-0000-4000-8000-0000000ca514', {
      userId: null,
      expires: `now() + interval '10 hours'`,
      due: `now() - interval '1 hour'`,
    });
    await answer('00000000-0000-4000-8000-0000000ca515', {
      expires: `now() + interval '10 hours'`,
      due: `now() - interval '1 hour'`,
      told: 'now()',
    });
    await answer('00000000-0000-4000-8000-0000000ca516', {
      status: 'paid',
      expires: `now() + interval '10 hours'`,
      due: `now() - interval '1 hour'`,
    });
    await answer('00000000-0000-4000-8000-0000000ca517', {
      formId: GONE_FORM,
      expires: `now() + interval '10 hours'`,
      due: `now() - interval '1 hour'`,
    });
    // Written by an older image during the rolling deploy: no due date, owed 24 hours ahead.
    await answer('00000000-0000-4000-8000-0000000ca518', {
      expires: `now() + interval '10 hours'`,
    });
    await answer('00000000-0000-4000-8000-0000000ca519', {
      expires: `now() + interval '3 days'`,
    });
    const due = await forms.dueCashReminders();
    expect(due.map((d) => d.submissionId).sort()).toEqual([
      '00000000-0000-4000-8000-0000000ca511',
      '00000000-0000-4000-8000-0000000ca518',
    ]);
    expect(due.find((d) => d.submissionId.endsWith('ca511'))).toEqual({
      submissionId: '00000000-0000-4000-8000-0000000ca511',
      userId: MEMBER,
      formId: FORM,
      formTitle: 'Gala',
      associationId: ASSO,
      associationName: 'BDE',
      associationLogoUrl: null,
    });
  });

  it('is claimed exactly once, never on an answer no longer waiting for cash, and again after a release', async () => {
    const id = '00000000-0000-4000-8000-0000000ca521';
    await answer(id, { expires: `now() + interval '10 hours'`, due: `now() - interval '1 hour'` });
    const both = await Promise.all([forms.claimCashReminder(id), forms.claimCashReminder(id)]);
    expect(both.filter(Boolean)).toHaveLength(1);
    expect(await forms.dueCashReminders()).toEqual([]);

    await forms.releaseCashReminder(id);
    expect(await forms.claimCashReminder(id)).toBe(true);

    const validated = '00000000-0000-4000-8000-0000000ca522';
    await answer(validated, {
      status: 'paid',
      expires: `now() + interval '10 hours'`,
      due: `now() - interval '1 hour'`,
    });
    expect(await forms.claimCashReminder(validated)).toBe(false);
  });
});
