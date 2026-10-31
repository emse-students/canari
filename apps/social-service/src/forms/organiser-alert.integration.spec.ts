/**
 * THE ORGANISER ALERT FOR A PAYMENT OVER CAPACITY, against a REAL PostgreSQL - migration 102.
 *
 * `FormsService.markPaid` runs for real (the seat lock, the row lock, the status decision, the
 * conditional UPDATE that claims `organiserNotifiedAt`), and so do the two services the alert goes
 * through: `AssociationsService.listFlagHolders` reads the real member bitmask, and
 * `PostNotificationsService.createNotifications` writes real `post_notifications` rows. Only the
 * push and the purchase record are recorded rather than sent. The `submissions` table is built by
 * `synchronize` WITHOUT the new column, then migration 102 is applied to it, so the migration meets
 * the shape it will meet in production.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; CI's
 * `test-social-integration` sets it. Locally:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- organiser-alert.integration
 *
 * Everything happens in a throwaway schema, dropped at the end.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { AssociationsService } from '../associations/associations.service';
import {
  AssociationMember,
  AssociationPermissionFlag,
} from '../associations/entities/association-member.entity';
import { PostNotification } from '../posts/entities/post-notification.entity';
import { PostNotificationsService } from '../posts/post-notifications.service';
import { Form } from './entities/form.entity';
import { Submission } from './entities/submission.entity';
import { FormsService } from './forms.service';
import { FormOrganiserAlertService } from './organiser-alert.service';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const migration = (file: string) => readFileSync(join(__dirname, '..', 'migrations', file), 'utf8');

const ASSO = '00000000-0000-4000-8000-0000000a1e01';
const FORM = '00000000-0000-4000-8000-0000000a1ef1';
const PERSONAL_FORM = '00000000-0000-4000-8000-0000000a1ef2';
const SEATED = '00000000-0000-4000-8000-0000000a1e51';
const LATE = '00000000-0000-4000-8000-0000000a1e52';

maybe('the organiser alert against PostgreSQL (migration 102)', () => {
  const schema = `organiser_alert_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let forms: FormsService;
  let alert: FormOrganiserAlertService;
  const pushed: { userId: string; key: string; arg: string; data: Record<string, string> }[] = [];
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  beforeAll(async () => {
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [AssociationMember, Form, Submission, PostNotification],
      synchronize: false,
      extra: { options: `-c search_path=${schema},public` },
    });
    await ds.initialize();
    await ds.synchronize();
    // The table as production has it before this pull request, then the migration itself.
    await q(`ALTER TABLE submissions DROP COLUMN "organiserNotifiedAt"`);
    await q(migration('102_submissions_organiser_notified.sql'));

    const none = {} as never;
    const push = {
      notifyContent: jest.fn(
        async (
          userId: string,
          content: { key: string; arg: string },
          data: Record<string, string>
        ) => {
          pushed.push({ userId, key: content.key, arg: content.arg, data });
        }
      ),
    };
    const notifications = new PostNotificationsService(
      ds.getRepository(PostNotification),
      none,
      push as never,
      none
    );
    // Only `listFlagHolders` is reached, and it reads `association_members` alone.
    const associations = new AssociationsService(
      none,
      ds.getRepository(AssociationMember),
      none,
      none,
      none,
      none,
      none,
      ds.getRepository(Form),
      none,
      none,
      none,
      notifications,
      none,
      { enabled: () => false, tell: async () => 0 } as never // lydiaNotifier
    );
    alert = new FormOrganiserAlertService(associations, notifications, push as never);
    forms = new FormsService(
      ds.getRepository(Form),
      ds.getRepository(Submission),
      none,
      { get: jest.fn() } as never,
      associations,
      none,
      { create: jest.fn(async () => undefined) } as never,
      none,
      none,
      none,
      alert
    );
  });

  afterAll(async () => {
    await ds?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    pushed.length = 0;
    jest.restoreAllMocks();
    // The alert ships switched off; every case but the first turns it on, as the flip will.
    jest.spyOn(alert, 'enabled').mockReturnValue(true);
    await q(`TRUNCATE submissions, post_notifications, association_members, forms`);
    const member = (userId: string, permissions: number) =>
      q(
        `INSERT INTO association_members ("associationId", "userId", role, permissions)
         VALUES ($1, $2, 'member', $3)`,
        [ASSO, userId, permissions]
      );
    await member('manager', AssociationPermissionFlag.MANAGE_FORMS);
    await member('poster', AssociationPermissionFlag.POST_AS_ASSO);
    await member('owner', AssociationPermissionFlag.MANAGE_FORMS);
    const form = (id: string, associationId: string | null) =>
      q(
        `INSERT INTO forms (id, title, "ownerId", "associationId", "maxSubmissions", items)
         VALUES ($1, 'Gala', 'owner', $2, 1, '[]')`,
        [id, associationId]
      );
    await form(FORM, ASSO);
    await form(PERSONAL_FORM, null);
  });

  /** The one seat taken, and a late payer whose hold has run out: their payment lands over it. */
  async function fullFormWithLatePayer(formId = FORM) {
    await q(
      `INSERT INTO submissions (id, "formId", "userId", answers, "paymentStatus", "totalPaid")
       VALUES ($1, $3, 'seated', '{}', 'paid', 1500),
              ($2, $3, 'payer', '{}', 'expired', 1500)`,
      [SEATED, LATE, formId]
    );
  }

  const rowsFor = async (type: string) =>
    (await q(
      `SELECT "recipientId", "postId", text, "actorId" FROM post_notifications
        WHERE type = $1 ORDER BY "recipientId"`,
      [type]
    )) as { recipientId: string; postId: string; text: string; actorId: string }[];
  const notifiedAt = async (id: string) =>
    (
      (await q(`SELECT "organiserNotifiedAt" FROM submissions WHERE id = $1`, [id])) as {
        organiserNotifiedAt: Date | null;
      }[]
    )[0].organiserNotifiedAt;
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it('applies migration 102 as a nullable column, and a second run is a no-op', async () => {
    await q(migration('102_submissions_organiser_notified.sql'));
    const [col] = await q(
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'submissions' AND column_name = 'organiserNotifiedAt'`,
      [schema]
    );
    expect(col).toEqual({ data_type: 'timestamp with time zone', is_nullable: 'YES' });
  });

  it('tells nobody and claims nothing while switched off', async () => {
    jest.spyOn(alert, 'enabled').mockReturnValue(false);
    await fullFormWithLatePayer();
    await forms.markPaid(LATE, 'req-1');
    const [late] = await q(`SELECT "paymentStatus" FROM submissions WHERE id = $1`, [LATE]);
    expect(late.paymentStatus).toBe('paid_over_capacity');
    expect(await rowsFor('form_paid_over_capacity')).toEqual([]);
    expect(await notifiedAt(LATE)).toBeNull();
  });

  it('tells the owner and the MANAGE_FORMS holders once - not the payer, not another officer', async () => {
    await fullFormWithLatePayer();
    await forms.markPaid(LATE, 'req-1');
    await flush();
    expect(await rowsFor('form_paid_over_capacity')).toEqual([
      { recipientId: 'manager', postId: FORM, text: 'Gala', actorId: 'system' },
      { recipientId: 'owner', postId: FORM, text: 'Gala', actorId: 'system' },
    ]);
    expect(await notifiedAt(LATE)).not.toBeNull();
    expect(pushed.map((p) => p.userId).sort()).toEqual(['manager', 'owner']);
    for (const p of pushed) {
      expect(p).toMatchObject({
        key: 'form_paid_over_capacity',
        arg: 'Gala',
        data: { type: 'social', target: 'form-responses', formId: FORM },
      });
    }
  });

  it("tells a personal form's owner alone", async () => {
    await fullFormWithLatePayer(PERSONAL_FORM);
    await forms.markPaid(LATE, 'req-1');
    expect((await rowsFor('form_paid_over_capacity')).map((r) => r.recipientId)).toEqual(['owner']);
  });

  it('writes nothing twice on replays, sequential or concurrent', async () => {
    await fullFormWithLatePayer();
    await forms.markPaid(LATE, 'req-1');
    await forms.markPaid(LATE, 'req-1');
    await Promise.all([forms.markPaid(LATE, 'req-1'), forms.markPaid(LATE, 'req-1')]);
    expect(await rowsFor('form_paid_over_capacity')).toHaveLength(2);
  });

  it('writes once when two confirmations settle the row at the same moment', async () => {
    await fullFormWithLatePayer();
    await Promise.all([forms.markPaid(LATE, 'req-1'), forms.markPaid(LATE, 'req-1')]);
    expect(await rowsFor('form_paid_over_capacity')).toHaveLength(2);
  });

  it('releases the claim when the rows could not be written, and the next replay writes them', async () => {
    await fullFormWithLatePayer();
    const tell = jest.spyOn(alert, 'tell').mockRejectedValueOnce(new Error('insert failed'));
    await forms.markPaid(LATE, 'req-1');
    expect(await notifiedAt(LATE)).toBeNull();
    expect(await rowsFor('form_paid_over_capacity')).toEqual([]);
    await forms.markPaid(LATE, 'req-1');
    expect(tell).toHaveBeenCalledTimes(2);
    expect(await notifiedAt(LATE)).not.toBeNull();
    expect(await rowsFor('form_paid_over_capacity')).toHaveLength(2);
  });

  it('tells nobody about a payment that took a free seat', async () => {
    await q(`UPDATE forms SET "maxSubmissions" = 2 WHERE id = $1`, [FORM]);
    await fullFormWithLatePayer();
    await forms.markPaid(LATE, 'req-1');
    const [late] = await q(`SELECT "paymentStatus" FROM submissions WHERE id = $1`, [LATE]);
    expect(late.paymentStatus).toBe('paid');
    expect(await rowsFor('form_paid_over_capacity')).toEqual([]);
    expect(await notifiedAt(LATE)).toBeNull();
  });
});
