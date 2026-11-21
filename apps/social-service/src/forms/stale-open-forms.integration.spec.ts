/**
 * THE QUESTION PUT TO A FORM LEFT OPEN, against a REAL PostgreSQL - migration 180.
 *
 * The predicate, the claim (the sweep's only write) and its idempotence are SQL, so they are read
 * from the database that runs them: `forms` is built by `synchronize` WITHOUT the two new columns,
 * then migration 180 is applied to it, so the migration meets the shape it will meet in production.
 * Every instant is passed to the sweep (`sweep(at)`), never read from the wall clock.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; CI's
 * `test-social-integration` sets it. Locally:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- stale-open-forms.integration
 *
 * Everything happens in a throwaway schema, dropped at the end.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { Form } from './entities/form.entity';
import { Submission } from './entities/submission.entity';
import { StaleOpenFormScheduler } from './stale-open-form.scheduler';
import {
  STALE_OPEN_DUE_SQL,
  STALE_OPEN_FORM_DAYS,
  formsAskedStillOpen,
  keepFormOpen,
} from './stale-open-forms';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const migration = (file: string) => readFileSync(join(__dirname, '..', 'migrations', file), 'utf8');

const id = (n: number) => `00000000-0000-4000-8000-0000005a1e${String(n).padStart(2, '0')}`;
const ASSO = id(90);
const ARCHIVED_ASSO = id(91);

/** The instant the first sweep judges at, and a day in milliseconds. */
const NOW = new Date('2026-11-21T09:30:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number, from: Date = NOW) => new Date(from.getTime() - days * DAY);

maybe('the question put to a form left open against PostgreSQL (migration 180)', () => {
  const schema = `stale_open_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let scheduler: StaleOpenFormScheduler;
  const told: { recipientIds: string[]; postId: string; type: string; skipPush?: boolean }[] = [];
  let failFor: string | null = null;
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  beforeAll(async () => {
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [Form, Submission],
      synchronize: false,
      extra: { options: `-c search_path=${schema},public` },
    });
    await ds.initialize();
    await ds.synchronize();
    // The table as production has it before this pull request, then the migration itself.
    await q(`ALTER TABLE forms DROP COLUMN "staleAskedAt", DROP COLUMN "staleKeptAt"`);
    await q(migration('180_form_stale_open_notice.sql'));
    // Re-running it is a no-op (idempotent for CD).
    await q(migration('180_form_stale_open_notice.sql'));
    await q(
      `CREATE TABLE associations (id uuid PRIMARY KEY, archived boolean NOT NULL DEFAULT false)`
    );
    await q(`INSERT INTO associations (id, archived) VALUES ($1, false), ($2, true)`, [
      ASSO,
      ARCHIVED_ASSO,
    ]);

    const notifications = {
      createNotifications: jest.fn(
        async (d: { recipientIds: string[]; postId: string; type: string; skipPush?: boolean }) => {
          if (failFor === d.postId) throw new Error('rows not written');
          told.push(d);
          return d.recipientIds.length;
        }
      ),
    };
    const alerts = { recipientsOf: jest.fn(async (f: { ownerId: string }) => [f.ownerId, 'mgr']) };
    scheduler = new StaleOpenFormScheduler(
      ds.getRepository(Form),
      alerts as never,
      notifications as never
    );
  });

  afterAll(async () => {
    await ds?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    told.length = 0;
    failFor = null;
    await q(`TRUNCATE submissions, forms`);
  });

  /** A form with its columns spelt out; defaults are a published, open, personal form. */
  async function form(
    n: number,
    o: {
      status?: string;
      closedAt?: Date | null;
      opensAt?: Date | null;
      deletedAt?: Date | null;
      associationId?: string | null;
      createdDaysAgo?: number;
      updatedDaysAgo?: number;
    } = {}
  ) {
    await q(
      `INSERT INTO forms (id, title, "ownerId", "associationId", status, "closedAt", "opensAt",
                          "deletedAt", items, "createdAt", "updatedAt")
       VALUES ($1, $2, 'owner', $3, $4, $5, $6, $7, '[]', $8, $9)`,
      [
        id(n),
        `Form ${n}`,
        o.associationId ?? null,
        o.status ?? 'published',
        o.closedAt ?? null,
        o.opensAt ?? null,
        o.deletedAt ?? null,
        ago(o.createdDaysAgo ?? 100),
        ago(o.updatedDaysAgo ?? o.createdDaysAgo ?? 100),
      ]
    );
  }

  /** One answer row created at `at`. */
  const answer = (formId: string, at: Date) =>
    q(
      `INSERT INTO submissions (id, "formId", "userId", answers, "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), $1, 'someone', '{}', $2, $2)`,
      [formId, at]
    );

  const due = async (at: Date = NOW) =>
    ((await q(STALE_OPEN_DUE_SQL, [at, STALE_OPEN_FORM_DAYS])) as { id: string }[]).map(
      (r) => r.id
    );
  const stamp = async (n: number) =>
    ((await q(`SELECT "staleAskedAt" FROM forms WHERE id = $1`, [id(n)])) as any[])[0]
      .staleAskedAt as Date | null;

  describe('the predicate', () => {
    it('selects exactly the open, published, unclosed forms silent for the whole window', async () => {
      // Due: answered 30 days ago; never answered and untouched for 40; a personal one.
      await form(1, { associationId: ASSO });
      await answer(id(1), ago(30));
      await form(2, { createdDaysAgo: 40 });
      await form(3);
      await answer(id(3), ago(25));
      // Not due: a recent answer, an edit two days ago, a closing date, a draft, a deleted form,
      // an opening still to come, an archived association.
      await form(4);
      await answer(id(4), ago(10));
      await form(5, { createdDaysAgo: 40, updatedDaysAgo: 2 });
      await form(6, { closedAt: new Date(NOW.getTime() + 30 * DAY) });
      await answer(id(6), ago(60));
      await form(7, { status: 'draft' });
      await form(8, { deletedAt: ago(1) });
      await form(9, { opensAt: new Date(NOW.getTime() + DAY) });
      await form(10, { associationId: ARCHIVED_ASSO });
      await answer(id(10), ago(60));

      expect((await due()).sort()).toEqual([id(1), id(2), id(3)].sort());
    });

    it('counts the window in whole days: 21 days to the instant is due, a second less is not', async () => {
      await form(1);
      await answer(id(1), ago(STALE_OPEN_FORM_DAYS));
      expect(await due()).toEqual([id(1)]);
      await q(`UPDATE submissions SET "createdAt" = $1`, [
        new Date(ago(STALE_OPEN_FORM_DAYS).getTime() + 1000),
      ]);
      expect(await due()).toEqual([]);
    });
  });

  describe('the sweep', () => {
    it('asks each due form ONCE, writes one bell row per form to its managers and never pushes', async () => {
      await form(1, { associationId: ASSO });
      await answer(id(1), ago(30));
      await form(2, { createdDaysAgo: 40 });
      await form(3);
      await answer(id(3), ago(3));

      const report = await scheduler.sweep(NOW);
      expect(report).toEqual({ asked: 2, told: 4, released: 0 });
      expect(told.map((t) => t.postId).sort()).toEqual([id(1), id(2)].sort());
      for (const t of told) {
        expect(t).toMatchObject({
          type: 'form_stale_open',
          recipientIds: ['owner', 'mgr'],
          skipPush: true,
        });
      }
      expect(await stamp(1)).toEqual(NOW);
      expect(await stamp(3)).toBeNull();
    });

    it('is idempotent: a second sweep, a later day and a re-run ask nothing, whatever the clock', async () => {
      await form(1);
      await answer(id(1), ago(30));
      await scheduler.sweep(NOW);
      told.length = 0;

      expect(await scheduler.sweep(NOW)).toEqual({ asked: 0, told: 0, released: 0 });
      // The silence goes on for months: the question is never put again by time alone.
      expect(await scheduler.sweep(new Date(NOW.getTime() + 90 * DAY))).toMatchObject({ asked: 0 });
      expect(told).toEqual([]);
    });

    it('lets two concurrent sweeps claim a form once', async () => {
      await form(1);
      await answer(id(1), ago(30));
      const [a, b] = await Promise.all([scheduler.sweep(NOW), scheduler.sweep(NOW)]);
      expect(a.asked + b.asked).toBe(1);
      expect(told).toHaveLength(1);
    });

    it('asks again ONLY after an answer arrived and the whole window of silence has passed again', async () => {
      await form(1);
      await answer(id(1), ago(30));
      await scheduler.sweep(NOW);
      told.length = 0;

      // A new answer arrives 5 days after the question: the form lives, nothing is asked at once...
      const answered = new Date(NOW.getTime() + 5 * DAY);
      await answer(id(1), answered);
      expect(await scheduler.sweep(new Date(NOW.getTime() + 10 * DAY))).toMatchObject({
        asked: 0,
      });
      // ...and silent for the whole window again, it is asked a SECOND time, once.
      const later = new Date(answered.getTime() + STALE_OPEN_FORM_DAYS * DAY);
      expect(await scheduler.sweep(later)).toMatchObject({ asked: 1 });
      expect(await scheduler.sweep(later)).toMatchObject({ asked: 0 });
      expect(await stamp(1)).toEqual(later);
    });

    it("re-arms on an anonymous form's answer, stored as the DAY (midnight) of the day it was asked", async () => {
      await form(1);
      await answer(id(1), ago(30));
      await scheduler.sweep(NOW);
      // Midnight of the day of the question: BEFORE the stamp's time, but the same day.
      await answer(id(1), new Date('2026-11-21T00:00:00.000Z'));
      const later = new Date(NOW.getTime() + 22 * DAY);
      expect(await scheduler.sweep(later)).toMatchObject({ asked: 1 });
    });

    it('does not ask a form closed, or given a closing date, since', async () => {
      await form(1);
      await form(2);
      await answer(id(1), ago(30));
      await answer(id(2), ago(30));
      // Both are answered by an owner before the sweep runs.
      await q(`UPDATE forms SET "closedAt" = $2 WHERE id = $1`, [id(1), ago(1)]);
      await q(`UPDATE forms SET "closedAt" = $2 WHERE id = $1`, [
        id(2),
        new Date(NOW.getTime() + 7 * DAY),
      ]);
      expect(await scheduler.sweep(NOW)).toMatchObject({ asked: 0 });
    });

    it('puts a claim back when the notice could not be written, and asks that form on the next sweep; the others are told', async () => {
      await form(1);
      await form(2);
      await answer(id(1), ago(30));
      await answer(id(2), ago(30));
      failFor = id(1);

      expect(await scheduler.sweep(NOW)).toEqual({ asked: 2, told: 2, released: 1 });
      expect(await stamp(1)).toBeNull();
      expect(await stamp(2)).toEqual(NOW);

      failFor = null;
      told.length = 0;
      expect(await scheduler.sweep(NOW)).toMatchObject({ asked: 1 });
      expect(told.map((t) => t.postId)).toEqual([id(1)]);
    });
  });

  describe('the answers a manager can give', () => {
    it('shows the question until it is answered, and "keep open" hides it for good', async () => {
      await form(1);
      await form(2);
      await answer(id(1), ago(30));
      await scheduler.sweep(NOW);

      expect([...(await formsAskedStillOpen(ds.manager, [id(1), id(2)]))]).toEqual([id(1)]);
      // A form nobody asked about is left alone.
      expect(await keepFormOpen(ds.manager, id(2), NOW)).toBe(false);
      expect(await keepFormOpen(ds.manager, id(1), NOW)).toBe(true);
      expect((await formsAskedStillOpen(ds.manager, [id(1)])).size).toBe(0);
      // Kept, it is not asked again by the passing of time.
      expect(await scheduler.sweep(new Date(NOW.getTime() + 60 * DAY))).toMatchObject({ asked: 0 });
    });

    it('shows the question again when a new answer re-arms it after a "keep open"', async () => {
      await form(1);
      await answer(id(1), ago(30));
      await scheduler.sweep(NOW);
      await keepFormOpen(ds.manager, id(1), NOW);

      const answered = new Date(NOW.getTime() + 3 * DAY);
      await answer(id(1), answered);
      const later = new Date(answered.getTime() + STALE_OPEN_FORM_DAYS * DAY);
      await scheduler.sweep(later);
      expect((await formsAskedStillOpen(ds.manager, [id(1)])).has(id(1))).toBe(true);
    });

    it('stops showing it once the form is closed or given a closing date', async () => {
      await form(1);
      await answer(id(1), ago(30));
      await scheduler.sweep(NOW);
      await q(`UPDATE forms SET "closedAt" = $2 WHERE id = $1`, [
        id(1),
        new Date(NOW.getTime() + DAY),
      ]);
      expect((await formsAskedStillOpen(ds.manager, [id(1)])).size).toBe(0);
    });
  });
});
