/**
 * THE BELL RE-ASKS WHAT A ROW POINTS AT, NOT ONLY A POST (audit of 2026-11-14), against a REAL
 * PostgreSQL - migrations 071, 072, 073, 078, 121, 126, 132, 148 and 165 applied.
 *
 * The rule: a bell row that names something other than a post is served while the predicate of what
 * it names still admits its reader (`BELL_ROW_GATE`, `targetBoundRowShownSql`, inside
 * `bellRowShownSql`): an event's opening by the event's visibility to that reader NOW, a proposal or
 * an officer's notice by the role that made its reader a recipient. Every case reads the bell through
 * the shipped statement (`getNotifications`, `bellPageQuery`): the reader sees the row, loses the
 * right, and the row is no longer served (and so not counted unread); a second reader who keeps the
 * right keeps theirs. A row about the reader's own account is served whatever. No row is deleted by
 * a read.
 *
 * The cast:
 *   off1, off2 - POST_AS_ASSO in R (the receiving association of a repost and a co-organisation)
 *   prop1, prop2 - PROPOSE_EVENT in O (the organiser of event E)
 *   pp - PROPOSE_EVENT in P, an accepted co-organiser of E
 *   val1, val2 - VALIDATE_EVENTS in B, the BDE governing ICM x Saint-Etienne, which O targets
 *   adm - a platform administrator
 *   f1, f2 - followers of O, ICM x Saint-Etienne students: E's and booking space S's openings
 *   fo, fm - form F's owner, and a MANAGE_FORMS holder of O
 *   pay1, pay2 - MANAGE_PAYOUT_ACCOUNT and MANAGE_PRODUCTS in O, each held by both
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like every `*.integration.spec.ts`; CI's
 * `test-social-integration` sets it. Everything happens in a throwaway schema, dropped at the end.
 */
// FIRST: the review cohort the import-time fragments of reader-spaces are built with.
import '../spaces/review-cohort.it-fixture';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { PostNotification } from './entities/post-notification.entity';
import { PostNotificationsService } from './post-notifications.service';
import {
  createBellTargetTables,
  createPostNotificationsTable,
} from './post-notifications.it-schema';
import { AssociationPermissionFlag as F } from '../associations/entities/association-member.entity';
import { PG_SESSION_OPTIONS } from '../common/pg-session-options';
import {
  REPORT_ALREADY_ANNOUNCED_SQL,
  alumniDuplicatePendingSql,
} from '../admin-queues/admin-queue-sql';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const migration = (file: string) => readFileSync(join(__dirname, '..', 'migrations', file), 'utf8');

const id = (n: number) => `00000000-0000-4000-8000-0000000b${String(n).padStart(4, '0')}`;
const O = id(1); // the organiser
const R = id(2); // receives a repost and a co-organisation proposal
const P = id(3); // an accepted co-organiser of E
const B = id(4); // the BDE of ICM x Saint-Etienne
const E = id(10); // O's event
const S = id(20); // O's booking space
const FORM = id(30); // O's form

const SE = 'saint-etienne';
const ICM = '[{"formation":"ICM","promo":2024}]';

maybe('bell rows bound to something other than a post (PostgreSQL)', () => {
  const schema = `bell_target_it_${Math.random().toString(36).slice(2, 10)}`;
  let ds: DataSource;
  let bell: PostNotificationsService;
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  /** The types `reader`'s bell SERVES now, through the shipped read - unread ones are what it counts. */
  const served = async (reader: string): Promise<string[]> =>
    (await bell.getNotifications(reader, 50)).map((n) => n.type).sort();

  /** The same read from a build that draws the admin queue notices (`1.7.1`). */
  const servedTo171 = async (reader: string): Promise<string[]> =>
    (await bell.getNotifications(reader, 50, '1.7.1')).map((n) => n.type).sort();

  /** One bell row, as the writers store it. */
  const row = (
    recipientId: string,
    type: string,
    postId: string,
    meta: Record<string, unknown> | null = null
  ) =>
    q(
      `INSERT INTO post_notifications ("recipientId", type, "postId", "actorId", text, meta)
       VALUES ($1, $2, $3, 'someone', 'A title', $4::jsonb)`,
      [recipientId, type, postId, meta ? JSON.stringify(meta) : null]
    );

  const member = (associationId: string, userId: string, permissions: number) =>
    q(
      `INSERT INTO association_members ("associationId", "userId", permissions) VALUES ($1, $2, $3)`,
      [associationId, userId, permissions]
    );

  const setFlags = (associationId: string, userId: string, permissions: number) =>
    q(
      `UPDATE association_members SET permissions = $3 WHERE "associationId" = $1 AND "userId" = $2`,
      [associationId, userId, permissions]
    );

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [PostNotification],
      synchronize: false,
      extra: { options: `${PG_SESSION_OPTIONS} -c search_path=${schema},public` },
    });
    await ds.initialize();
    await q(`CREATE SCHEMA ${schema}`);
    await q(`
      CREATE TABLE users (id varchar(255) PRIMARY KEY, admin boolean NOT NULL DEFAULT false,
        campus varchar(32), cursus jsonb NOT NULL DEFAULT '[]', posts text[] NOT NULL DEFAULT '{}');
      CREATE TABLE associations (id uuid PRIMARY KEY, name varchar NOT NULL, slug varchar NOT NULL,
        type varchar NOT NULL DEFAULT 'association', archived boolean NOT NULL DEFAULT false,
        "isBDE" boolean NOT NULL DEFAULT false);
      CREATE TABLE posts (id uuid PRIMARY KEY, "authorId" varchar(255) NOT NULL,
        "associationId" uuid, "studentsOnly" boolean NOT NULL DEFAULT false, "reachPublic" varchar(16),
        "reachSpaces" jsonb, anonymous boolean NOT NULL DEFAULT false,
        "hiddenByModeration" boolean NOT NULL DEFAULT false, "scheduledAt" timestamptz,
        "publishedAt" timestamptz NOT NULL DEFAULT now(),
        -- The bell reads a comment's writer behind an empty actor (bellRowActorAccountSql).
        comments jsonb NOT NULL DEFAULT '[]');
      CREATE TABLE association_members (id serial PRIMARY KEY, "associationId" uuid NOT NULL,
        "userId" varchar(255) NOT NULL, permissions int NOT NULL DEFAULT 0);
      CREATE TABLE user_blocks ("blockerId" varchar(255) NOT NULL, "blockedId" varchar(255) NOT NULL);
      CREATE TABLE user_follows ("followerUserId" varchar(255) NOT NULL,
        "followedUserId" varchar(255) NOT NULL, status varchar(16) NOT NULL);
      CREATE TABLE user_moderation ("userId" varchar(255) PRIMARY KEY,
        "isMuted" boolean NOT NULL DEFAULT false);
    `);
    await createPostNotificationsTable(q);
    for (const file of [
      '071_spaces.sql',
      '072_drop_is_bde.sql',
      '073_republications.sql',
      '078_read_grants.sql',
      '132_read_grant_readers.sql',
      '121_member_reposts.sql',
      '148_profile_birthdays.sql',
      '126_post_notifications_recipient_created.sql',
    ]) {
      await q(migration(file));
    }
    await createBellTargetTables(q);

    for (const [aid, name] of [
      [O, 'O'],
      [R, 'R'],
      [P, 'P'],
      [B, 'B'],
    ] as const) {
      await q(`INSERT INTO associations (id, name, slug) VALUES ($1, $2, $2)`, [aid, name]);
      await q(
        `INSERT INTO association_audiences ("associationId", formation, campus) VALUES ($1, 'ICM', $2)`,
        [aid, SE]
      );
    }
    await q(`UPDATE spaces SET "bdeAssociationId" = $1 WHERE formation = 'ICM' AND campus = $2`, [
      B,
      SE,
    ]);
    for (const u of [
      'off1',
      'off2',
      'prop1',
      'prop2',
      'pp',
      'val1',
      'val2',
      'f1',
      'f2',
      'fo',
      'fm',
      'pay1',
      'pay2',
    ]) {
      await q(`INSERT INTO users (id, campus, cursus) VALUES ($1, $2, $3)`, [u, SE, ICM]);
    }
    await q(`INSERT INTO users (id, admin) VALUES ('adm', true)`);

    await q(
      `INSERT INTO association_calendar_events (id, "associationId", title, status)
       VALUES ($1, $2, 'Gala', 'validated')`,
      [E, O]
    );
    await q(
      `INSERT INTO association_calendar_event_co_owners (event_id, association_id) VALUES ($1, $2)`,
      [E, P]
    );
    await q(
      `INSERT INTO booking_spaces (id, "associationId", "ownerId", name) VALUES ($1, $2, 'fo', 'Salle')`,
      [S, O]
    );
    await q(
      `INSERT INTO forms (id, "ownerId", "associationId", title) VALUES ($1, 'fo', $2, 'F')`,
      [FORM, O]
    );

    bell = new PostNotificationsService(
      ds.getRepository(PostNotification),
      { manager: ds.manager } as never,
      {} as never,
      {} as never
    );
  });

  beforeEach(async () => {
    await q(`DELETE FROM post_notifications`);
    await q(`DELETE FROM association_members`);
    await member(R, 'off1', F.POST_AS_ASSO);
    await member(R, 'off2', F.POST_AS_ASSO);
    await member(O, 'prop1', F.PROPOSE_EVENT);
    await member(O, 'prop2', F.PROPOSE_EVENT);
    await member(P, 'pp', F.PROPOSE_EVENT);
    await member(B, 'val1', F.VALIDATE_EVENTS);
    await member(B, 'val2', F.VALIDATE_EVENTS);
    await member(O, 'fm', F.MANAGE_FORMS);
    await member(O, 'pay1', F.MANAGE_PAYOUT_ACCOUNT | F.MANAGE_PRODUCTS);
    await member(O, 'pay2', F.MANAGE_PAYOUT_ACCOUNT | F.MANAGE_PRODUCTS);
    await q(`UPDATE users SET admin = (id = 'adm'), campus = $1, cursus = $2 WHERE id <> 'adm'`, [
      SE,
      ICM,
    ]);
    await q(`UPDATE users SET admin = true WHERE id = 'adm'`);
    await q(`UPDATE associations SET archived = false`);
    await q(`UPDATE association_calendar_events SET status = 'validated' WHERE id = $1`, [E]);
    await q(`UPDATE booking_spaces SET discoverability = 'listed', audience = NULL WHERE id = $1`, [
      S,
    ]);
    await q(`DELETE FROM association_calendar_event_co_owners`);
    await q(
      `INSERT INTO association_calendar_event_co_owners (event_id, association_id) VALUES ($1, $2)`,
      [E, P]
    );
  });

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    await q(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await ds.destroy();
  });

  it('a repost or co-organisation proposal leaves the bell of an officer who no longer holds POST_AS_ASSO', async () => {
    for (const u of ['off1', 'off2']) {
      await row(u, 'repost_proposed', R);
      await row(u, 'coorganise_proposed', R);
    }
    expect(await served('off1')).toEqual(['coorganise_proposed', 'repost_proposed']);

    await setFlags(R, 'off1', F.PROPOSE_EVENT);
    expect(await served('off1')).toEqual([]);
    expect(await served('off2')).toEqual(['coorganise_proposed', 'repost_proposed']);

    // Leaving the association altogether is the same answer.
    await q(`DELETE FROM association_members WHERE "userId" = 'off2'`);
    expect(await served('off2')).toEqual([]);
    // Nothing was deleted by the read: the rows wait for the 90-day sweep.
    expect((await q(`SELECT count(*)::int AS n FROM post_notifications`))[0].n).toBe(4);
  });

  it('what a calendar manager did with an event leaves the bell of a member who lost PROPOSE_EVENT in the organiser', async () => {
    const kinds = ['event_deleted', 'event_rejected', 'event_updated', 'event_validated'];
    for (const u of ['prop1', 'prop2']) for (const k of kinds) await row(u, k, O);
    expect(await served('prop1')).toEqual(kinds);

    await q(`DELETE FROM association_members WHERE "userId" = 'prop1'`);
    expect(await served('prop1')).toEqual([]);
    expect(await served('prop2')).toEqual(kinds);
  });

  it("an event back in the queue leaves a party's bell with the role: the organiser's member, a partner's member, a partner that left", async () => {
    await row('prop1', 'event_pending', O, { reason: 'date_moved', eventId: E });
    await row('pp', 'event_pending', O, { reason: 'date_moved', eventId: E });
    await row('pp', 'event_pending_coorganiser', O, { reason: 'coorganiser_joined', eventId: E });
    expect(await served('prop1')).toEqual(['event_pending']);
    expect(await served('pp')).toEqual(['event_pending', 'event_pending_coorganiser']);

    // The partner leaves the event: its member's rows go, the organiser's stay.
    await q(`DELETE FROM association_calendar_event_co_owners`);
    expect(await served('pp')).toEqual([]);
    expect(await served('prop1')).toEqual(['event_pending']);

    // The organiser's member loses the right.
    await setFlags(O, 'prop1', 0);
    expect(await served('prop1')).toEqual([]);
  });

  it('a party row written before it named its event is kept by the organiser only (fail closed)', async () => {
    await row('prop2', 'event_pending', O, { reason: 'date_moved' });
    await row('pp', 'event_pending', O, { reason: 'date_moved' });
    expect(await served('prop2')).toEqual(['event_pending']);
    expect(await served('pp')).toEqual([]);
  });

  it("a proposal waiting for validation leaves the bell of a validator who lost the BDE's agenda right", async () => {
    await row('val1', 'event_proposed', O);
    await row('val2', 'event_proposed', O);
    await row('adm', 'event_proposed', O);
    await row('val1', 'event_pending_coorganiser', O, {
      reason: 'coorganiser_joined',
      audience: 'validators',
    });
    expect(await served('val1')).toEqual(['event_pending_coorganiser', 'event_proposed']);
    expect(await served('adm')).toEqual(['event_proposed']);

    await setFlags(B, 'val1', F.PROPOSE_EVENT);
    expect(await served('val1')).toEqual([]);
    expect(await served('val2')).toEqual(['event_proposed']);

    // The organiser stops targeting B's space: B's validator is no longer the one who decides.
    await q(`UPDATE association_audiences SET campus = 'gardanne' WHERE "associationId" = $1`, [O]);
    try {
      expect(await served('val2')).toEqual([]);
      // The platform administrator validates any event, and keeps it until the flag is gone.
      expect(await served('adm')).toEqual(['event_proposed']);
      await q(`UPDATE users SET admin = false WHERE id = 'adm'`);
      expect(await served('adm')).toEqual([]);
    } finally {
      await q(`UPDATE association_audiences SET campus = $2 WHERE "associationId" = $1`, [O, SE]);
    }
  });

  it("an event's opening leaves the bell when the event leaves the agenda or its reader stops seeing it", async () => {
    await row('f1', 'event_open', E);
    await row('f2', 'event_open', E);
    expect(await served('f1')).toEqual(['event_open']);

    // Back in validation: not on the agenda, for nobody.
    await q(`UPDATE association_calendar_events SET status = 'pending' WHERE id = $1`, [E]);
    expect(await served('f1')).toEqual([]);
    expect(await served('f2')).toEqual([]);
    await q(`UPDATE association_calendar_events SET status = 'validated' WHERE id = $1`, [E]);

    // f1 moves to a space neither O nor its partner reaches; f2 keeps it.
    await q(`UPDATE users SET campus = 'gardanne' WHERE id = 'f1'`);
    expect(await served('f1')).toEqual([]);
    expect(await served('f2')).toEqual(['event_open']);

    // The organiser is archived: the opening is gone for everyone.
    await q(`UPDATE associations SET archived = true WHERE id = $1`, [O]);
    expect(await served('f2')).toEqual([]);
  });

  it("a deleted event's opening is served to nobody", async () => {
    const gone = id(11);
    await row('f2', 'event_open', gone);
    expect(await served('f2')).toEqual([]);
  });

  /** What `reader`'s bell serves, as the client receives it: the type and the facts. */
  const servedRows = async (reader: string) =>
    (await bell.getNotifications(reader, 50))
      .map((n) => ({ type: n.type, meta: n.meta }))
      .sort((a, b) => a.type.localeCompare(b.type));

  it('a validator told in place of their party notice keeps it with either right, then reads it as the party notice', async () => {
    // A reopening tells a validator who is also a party ONCE, as a validator, and records it.
    await member(O, 'val1', F.PROPOSE_EVENT);
    await row('val1', 'event_proposed', O, {
      reason: 'date_moved',
      audience: 'validators',
      eventId: E,
      toldAsParty: true,
    });
    await row('val1', 'event_pending_coorganiser', O, {
      reason: 'coorganiser_joined',
      audience: 'validators',
      eventId: E,
      toldAsParty: true,
    });
    // Still a validator: the validators' rows, which open the validation queue.
    expect((await servedRows('val1')).map((r) => r.meta?.audience)).toEqual([
      'validators',
      'validators',
    ]);
    // Only a party now: served as the party notices they replaced, which open the agenda.
    await setFlags(B, 'val1', 0);
    expect(await servedRows('val1')).toEqual([
      { type: 'event_pending', meta: { reason: 'date_moved', eventId: E } },
      { type: 'event_pending_coorganiser', meta: { reason: 'coorganiser_joined', eventId: E } },
    ]);
    await setFlags(O, 'val1', 0);
    expect(await served('val1')).toEqual([]);
  });

  it("a validator who is a party through a CO-ORGANISER keeps that row by the partner's right, through `meta.eventId`", async () => {
    await member(P, 'val1', F.PROPOSE_EVENT);
    await row('val1', 'event_pending_coorganiser', O, {
      reason: 'coorganiser_joined',
      audience: 'validators',
      eventId: E,
      toldAsParty: true,
    });
    await setFlags(B, 'val1', 0);
    expect(await served('val1')).toEqual(['event_pending_coorganiser']);
    // The partner leaves the event: no right is left.
    await q(`DELETE FROM association_calendar_event_co_owners WHERE association_id = $1`, [P]);
    expect(await served('val1')).toEqual([]);
  });

  it("a validators' row that did not replace a party notice follows the validator's right alone (fail closed)", async () => {
    // val1 holds PROPOSE_EVENT in the organiser AND in the partner, and loses the validator's right.
    await member(O, 'val1', F.PROPOSE_EVENT);
    await member(P, 'val1', F.PROPOSE_EVENT);
    // A first proposal: the writer tells the validators only, so nothing was replaced.
    await row('val1', 'event_proposed', O);
    // A reopening's row written before the writer recorded it, naming no event either.
    await row('val1', 'event_pending_coorganiser', O, {
      reason: 'coorganiser_joined',
      audience: 'validators',
    });
    // A reopening's row naming its event, but not written in place of a party notice.
    await row('val1', 'event_proposed', O, {
      reason: 'date_moved',
      audience: 'validators',
      eventId: E,
    });
    expect(await served('val1')).toEqual([
      'event_pending_coorganiser',
      'event_proposed',
      'event_proposed',
    ]);
    await setFlags(B, 'val1', 0);
    expect(await served('val1')).toEqual([]);
  });

  it("an event's opening is gated by the READ predicate: an institution's reach, and a read grant, admit as the agenda does", async () => {
    // An institution of the whole Saint-Etienne campus, its event ticking ICM x Saint-Etienne.
    const I = id(5);
    const EI = id(12);
    await q(
      `INSERT INTO associations (id, name, slug, type) VALUES ($1, 'I', 'i', 'institution')
       ON CONFLICT (id) DO NOTHING`,
      [I]
    );
    await q(
      `INSERT INTO association_audiences ("associationId", formation, campus) VALUES ($1, NULL, $2)
       ON CONFLICT DO NOTHING`,
      [I, SE]
    );
    await q(
      `INSERT INTO association_calendar_events (id, "associationId", title, status, "reachPublic", "reachSpaces")
       VALUES ($1, $2, 'Forum', 'validated', 'all', $3::jsonb) ON CONFLICT (id) DO NOTHING`,
      [EI, I, JSON.stringify([{ formation: 'ICM', campus: SE }])]
    );
    // `iss` studies in an unticked space; `nr` has no space, only a read grant on the ticked cell.
    await q(
      `INSERT INTO users (id, campus, cursus) VALUES ('iss', $1, $2), ('nr', NULL, '[]')
             ON CONFLICT (id) DO NOTHING`,
      [SE, '[{"formation":"ISMIN","promo":2024}]']
    );
    await q(
      `INSERT INTO read_grants (user_id, campus, formation, granted_by) VALUES ('nr', $1, 'ICM', 'admin')`,
      [SE]
    );
    try {
      for (const u of ['f1', 'iss', 'nr']) await row(u, 'event_open', EI);
      expect(await served('f1')).toEqual(['event_open']);
      expect(await served('iss')).toEqual([]);
      // A read grant is a read door: the row once written stays (the opening itself is never told
      // through a grant - its writer asks the plain predicate).
      expect(await served('nr')).toEqual(['event_open']);
      // "Students" closes the grant door, as on the agenda.
      await q(`UPDATE association_calendar_events SET "reachPublic" = 'students' WHERE id = $1`, [
        EI,
      ]);
      expect(await served('nr')).toEqual([]);
      expect(await served('f1')).toEqual(['event_open']);
    } finally {
      await q(`DELETE FROM read_grants WHERE user_id = 'nr'`);
    }
  });

  it("a booking space's opening leaves the bell when the space takes an audience, goes link-only, or its reader stops seeing it", async () => {
    await row('f1', 'booking_open', S);
    await row('f2', 'booking_open', S);
    expect(await served('f1')).toEqual(['booking_open']);

    await q(`UPDATE booking_spaces SET audience = '{"kind":"any"}'::jsonb WHERE id = $1`, [S]);
    expect(await served('f1')).toEqual([]);
    await q(`UPDATE booking_spaces SET audience = NULL, discoverability = 'link' WHERE id = $1`, [
      S,
    ]);
    expect(await served('f1')).toEqual([]);
    await q(`UPDATE booking_spaces SET discoverability = 'listed' WHERE id = $1`, [S]);

    await q(`UPDATE users SET campus = 'gardanne' WHERE id = 'f1'`);
    expect(await served('f1')).toEqual([]);
    expect(await served('f2')).toEqual(['booking_open']);
  });

  it("a paid answer over capacity leaves the bell of a member who lost MANAGE_FORMS; the form's owner keeps it", async () => {
    await row('fo', 'form_paid_over_capacity', FORM);
    await row('fm', 'form_paid_over_capacity', FORM);
    expect(await served('fm')).toEqual(['form_paid_over_capacity']);

    await setFlags(O, 'fm', F.POST_AS_ASSO);
    expect(await served('fm')).toEqual([]);
    expect(await served('fo')).toEqual(['form_paid_over_capacity']);
  });

  it('the question put to a form left open is served to the MANAGE_FORMS holders while it waits, and leaves the bell once answered or when its reader stops managing', async () => {
    const servedTo180 = async (reader: string) =>
      (await bell.getNotifications(reader, 50, '1.8.0')).map((n) => n.type);
    const ASKED = '2026-11-21T09:30:00.000Z';
    // The test before this one took MANAGE_FORMS from `fm`: give it back, and take it again at the end.
    await setFlags(O, 'fm', F.MANAGE_FORMS);
    // The rows name the question they were written for (`meta.askedAt`). The form's creator `fo`
    // holds no MANAGE_FORMS: an association's form is managed by its flag holders alone.
    await row('fo', 'form_stale_open', FORM, { askedAt: ASKED });
    await row('fm', 'form_stale_open', FORM, { askedAt: ASKED });
    // Not asked yet (no stamp): nothing to answer, so nothing served.
    expect(await servedTo180('fm')).toEqual([]);

    await q(`UPDATE forms SET "staleAskedAt" = $2::timestamptz WHERE id = $1`, [FORM, ASKED]);
    expect(await servedTo180('fm')).toEqual(['form_stale_open']);
    expect(await servedTo180('fo')).toEqual([]);
    // A build older than the floor is never served the type.
    expect(await served('fm')).toEqual([]);

    // A member who lost MANAGE_FORMS no longer sees it.
    await setFlags(O, 'fm', F.POST_AS_ASSO);
    expect(await servedTo180('fm')).toEqual([]);
    await setFlags(O, 'fm', F.MANAGE_FORMS);
    expect(await servedTo180('fm')).toEqual(['form_stale_open']);

    // "Garder ouvert" answers it for everybody; a later question (a new stamp) puts back ITS row only.
    await q(`UPDATE forms SET "staleKeptAt" = now() WHERE id = $1`, [FORM]);
    expect(await servedTo180('fm')).toEqual([]);
    const LATER = '2026-12-30T09:30:00.000Z';
    await q(`UPDATE forms SET "staleAskedAt" = $2::timestamptz WHERE id = $1`, [FORM, LATER]);
    expect(await servedTo180('fm')).toEqual([]);
    await row('fm', 'form_stale_open', FORM, { askedAt: LATER });
    expect(await servedTo180('fm')).toEqual(['form_stale_open']);

    // A closing date (or a close) answers it too.
    await q(`UPDATE forms SET "closedAt" = now() + interval '7 days' WHERE id = $1`, [FORM]);
    expect(await servedTo180('fm')).toEqual([]);
    await q(
      `UPDATE forms SET "closedAt" = NULL, "staleAskedAt" = NULL, "staleKeptAt" = NULL WHERE id = $1`,
      [FORM]
    );
  });

  it("a payout or a shop manager's notice leaves the bell with the flag", async () => {
    const kinds = ['delegation_revoked', 'lydia_payments_paused'];
    for (const u of ['pay1', 'pay2']) for (const k of kinds) await row(u, k, O);
    expect(await served('pay1')).toEqual(kinds);

    await setFlags(O, 'pay1', F.MANAGE_PRODUCTS);
    expect(await served('pay1')).toEqual(['delegation_revoked']);
    await setFlags(O, 'pay1', 0);
    expect(await served('pay1')).toEqual([]);
    expect(await served('pay2')).toEqual(kinds);
  });

  it("a row about the reader's own account is served whatever they hold, and a malformed target is served to nobody", async () => {
    await row('f1', 'booking_removed', id(99));
    await row('f1', 'follow_accepted', 'not-a-uuid');
    await row('f1', 'repost_proposed', 'not-a-uuid');
    expect(await served('f1')).toEqual(['booking_removed', 'follow_accepted']);
  });

  it('an admin queue notice is served to a global admin while its item waits, and leaves EVERY admin bell once one handles it', async () => {
    const request = id(40);
    const report = id(41);
    const second = id(42);
    await q(`INSERT INTO users (id, admin) VALUES ('adm2', true) ON CONFLICT (id) DO NOTHING`);
    await q(`UPDATE users SET admin = true WHERE id = 'adm2'`);
    await q(
      `INSERT INTO profile_correction_requests (id, "userId", message) VALUES ($1, 'f1', 'x')`,
      [request]
    );
    // Two reports on ONE subject: the notice announced the first, the subject waits until both go.
    await q(
      `INSERT INTO content_reports (id, "contentType", "contentId") VALUES ($1, 'post', 'p-1'), ($2, 'post', 'p-1')`,
      [report, second]
    );
    for (const u of ['adm', 'adm2', 'f1']) {
      await row(u, 'admin_profile_correction', request);
      await row(u, 'admin_report', report);
    }
    const both = ['admin_profile_correction', 'admin_report'];
    expect(await servedTo171('adm')).toEqual(both);
    expect(await servedTo171('adm2')).toEqual(both);
    // A row that reached somebody who is not a global admin is served to nobody.
    expect(await servedTo171('f1')).toEqual([]);
    // A build before the floor is not served a type it cannot draw.
    expect(await served('adm')).toEqual([]);

    // One admin takes the correction (the claim), then applies it: gone from both bells at once.
    await q(`UPDATE profile_correction_requests SET status = 'applying' WHERE id = $1`, [request]);
    expect(await servedTo171('adm2')).toEqual(['admin_report']);
    await q(`UPDATE profile_correction_requests SET status = 'applied' WHERE id = $1`, [request]);
    expect(await servedTo171('adm')).toEqual(['admin_report']);
    expect(await servedTo171('adm2')).toEqual(['admin_report']);

    // The announced report is reviewed, another on the same subject still waits: the notice stays.
    await q(`UPDATE content_reports SET status = 'reviewed' WHERE id = $1`, [report]);
    expect(await servedTo171('adm')).toEqual(['admin_report']);
    await q(`UPDATE content_reports SET status = 'dismissed' WHERE id = $1`, [second]);
    expect(await servedTo171('adm')).toEqual([]);
    expect(await servedTo171('adm2')).toEqual([]);

    // An admin who loses the flag loses the notices too.
    await q(`UPDATE content_reports SET status = 'pending' WHERE id = $1`, [second]);
    expect(await servedTo171('adm2')).toEqual(['admin_report']);
    await q(`UPDATE users SET admin = false WHERE id = 'adm2'`);
    expect(await servedTo171('adm2')).toEqual([]);
    await q(`DELETE FROM content_reports WHERE id IN ($1, $2)`, [report, second]);
  });

  it('an Alumni duplicate notice is served to a global admin while the duplicate waits, leaves EVERY admin bell once one marks it, and returns when the mark is withdrawn', async () => {
    // The first build that draws this notice (`ALUMNI_DUPLICATE_NOTICE_MIN_CLIENT_VERSION`).
    const servedTo183 = async (reader: string): Promise<string[]> =>
      (await bell.getNotifications(reader, 50, '1.8.3')).map((n) => n.type).sort();
    const dup = id(60);
    const target = id(61);
    const pending = async (): Promise<number> =>
      (
        (await q(
          `SELECT count(*)::int AS n FROM alumni_duplicate_flags adf WHERE ${alumniDuplicatePendingSql('adf')}`
        )) as { n: number }[]
      )[0].n;
    const merge = (completed: boolean, cancelled: boolean, marked = true) =>
      q(
        `INSERT INTO alumni_merges ("actorId", "duplicateUuid", "duplicateUsername", "targetUuid", held,
           "markedAt", "completedAt", "cancelledAt")
         VALUES ('adm', $1, 'alumni-0001', $2, '{}'::jsonb, CASE WHEN $5::boolean THEN now() END,
           CASE WHEN $3::boolean THEN now() END, CASE WHEN $4::boolean THEN now() END)`,
        [dup, target, completed, cancelled, marked]
      );
    await q(`INSERT INTO users (id, admin) VALUES ('adm2', true) ON CONFLICT (id) DO NOTHING`);
    await q(`UPDATE users SET admin = true WHERE id = 'adm2'`);
    await q(`INSERT INTO alumni_duplicate_flags ("duplicateUuid") VALUES ($1)`, [dup]);
    for (const u of ['adm', 'adm2', 'f1']) await row(u, 'admin_alumni_duplicate', dup);

    // It waits: both admins are served it and COUNT it, a member who somehow holds the row is not.
    expect(await pending()).toBe(1);
    expect(await servedTo183('adm')).toEqual(['admin_alumni_duplicate']);
    expect(await servedTo183('adm2')).toEqual(['admin_alumni_duplicate']);
    expect(await servedTo183('f1')).toEqual([]);
    // A build before the floor is not served a type it cannot draw.
    expect(await servedTo171('adm')).toEqual([]);
    expect(await served('adm')).toEqual([]);

    // A merge only REQUESTED (written, the editor not yet written to, so not marked) removes nothing:
    // an interrupted mark leaves the item waiting.
    await merge(false, false, false);
    expect(await pending()).toBe(1);
    expect(await servedTo183('adm')).toEqual(['admin_alumni_duplicate']);

    // One admin marks it for a merge (an OPEN, MARKED merge row): gone from every bell and every count.
    await q(`DELETE FROM alumni_merges`);
    await merge(false, false);
    expect(await pending()).toBe(0);
    expect(await servedTo183('adm')).toEqual([]);
    expect(await servedTo183('adm2')).toEqual([]);

    // The mark is withdrawn (cancelled: closed, never merged): it waits again, for the same row.
    await q(`DELETE FROM alumni_merges`);
    await merge(true, true);
    expect(await pending()).toBe(1);
    expect(await servedTo183('adm2')).toEqual(['admin_alumni_duplicate']);

    // MiConnect completed the merge: still gone, and nothing was announced.
    await merge(true, false);
    expect(await pending()).toBe(0);
    expect(await servedTo183('adm')).toEqual([]);

    // A flag a later reading resolved (the duplicate is gone) leaves the bells; one that matches
    // again returns.
    await q(`DELETE FROM alumni_merges`);
    await q(`UPDATE alumni_duplicate_flags SET "resolvedAt" = now() WHERE "duplicateUuid" = $1`, [
      dup,
    ]);
    expect(await pending()).toBe(0);
    expect(await servedTo183('adm')).toEqual([]);
    await q(`UPDATE alumni_duplicate_flags SET "resolvedAt" = NULL WHERE "duplicateUuid" = $1`, [
      dup,
    ]);
    expect(await servedTo183('adm')).toEqual(['admin_alumni_duplicate']);

    // ONE row for a BATCH (meta.duplicateUuids), keyed on its first duplicate: it stays while ANY of
    // them still waits, and leaves only when none does.
    await q(`DELETE FROM post_notifications WHERE type = 'admin_alumni_duplicate'`);
    const dup2 = id(62);
    await q(`UPDATE alumni_duplicate_flags SET "resolvedAt" = NULL`);
    await q(`INSERT INTO alumni_duplicate_flags ("duplicateUuid") VALUES ($1)`, [dup2]);
    await row('adm', 'admin_alumni_duplicate', dup, { duplicateUuids: [dup, dup2] });
    expect(await servedTo183('adm')).toEqual(['admin_alumni_duplicate']);
    await q(`UPDATE alumni_duplicate_flags SET "resolvedAt" = now() WHERE "duplicateUuid" = $1`, [
      dup,
    ]);
    // The first duplicate (the row's key) is handled, the second still waits: the notice stays.
    expect(await servedTo183('adm')).toEqual(['admin_alumni_duplicate']);
    await merge(false, false); // a marked merge of `dup` changes nothing for `dup2`
    expect(await servedTo183('adm')).toEqual(['admin_alumni_duplicate']);
    await q(`UPDATE alumni_duplicate_flags SET "resolvedAt" = now() WHERE "duplicateUuid" = $1`, [
      dup2,
    ]);
    expect(await servedTo183('adm')).toEqual([]);

    // An admin who loses the flag loses the notice too.
    await q(`UPDATE users SET admin = false WHERE id = 'adm2'`);
    expect(await servedTo183('adm2')).toEqual([]);
    await q(`DELETE FROM alumni_duplicate_flags`);
    await q(`DELETE FROM alumni_merges`);
  });

  it('a report is announced unless a notice about its subject is still owed, and a handled notice never comes back (`REPORT_ALREADY_ANNOUNCED_SQL`)', async () => {
    const [before, x, y, z, elsewhere] = [id(50), id(51), id(52), id(53), id(54)];
    const file = (report: string, minutesAgo: number, type = 'user') =>
      q(
        `INSERT INTO content_reports (id, "contentType", "contentId", "createdAt")
         VALUES ($1, $2, 'u-9', now() - make_interval(mins => $3))`,
        [report, type, minutesAgo]
      );
    const covered = async (reportId: string) =>
      ((await q(REPORT_ALREADY_ANNOUNCED_SQL, [reportId])) as { covered: boolean }[])[0].covered;
    const handle = (...reports: string[]) =>
      q(`UPDATE content_reports SET status = 'dismissed' WHERE id = ANY($1::uuid[])`, [reports]);

    // A report that waited before the notices existed (or whose announcement failed) has no row: the
    // next report on its subject IS announced - "an older report waits" is not "it was announced".
    await file(before, 40);
    await file(x, 30);
    expect(await covered(x)).toBe(false);
    await row('adm', 'admin_report', x);
    // Now a notice is owed: the next report is covered by it, one subject, one notice.
    await file(y, 20);
    expect(await covered(y)).toBe(true);
    // Another content type with the same id is another subject.
    await file(elsewhere, 20, 'comment');
    expect(await covered(elsewhere)).toBe(false);

    // The announced report is handled, the older unannounced one still waits: the notice stays.
    await handle(x, y);
    expect(await servedTo171('adm')).toEqual(['admin_report']);
    await handle(before);
    expect(await servedTo171('adm')).toEqual([]);

    // Reported again after everything was handled: a NEW notice, and the old one does not come back.
    await file(z, 1);
    expect(await covered(z)).toBe(false);
    await row('adm', 'admin_report', z);
    expect(await servedTo171('adm')).toEqual(['admin_report']);
    const shown = (await bell.getNotifications('adm', 50, '1.7.1')).map((n) => n.postId);
    expect(shown).toEqual([z]);
    await q(`DELETE FROM content_reports WHERE id = ANY($1::uuid[])`, [
      [before, x, y, z, elsewhere],
    ]);
  });

  it("keeps the bell's one statement walking the reader's index with no sort", async () => {
    await row('f1', 'event_open', E);
    // The plan must not depend on whether autoanalyze happened to run: seed other readers' rows in
    // bulk, then ANALYZE, as bell-page.integration.spec does (deterministic statistics).
    await q(
      `INSERT INTO post_notifications ("recipientId", type, "postId", "actorId", text, "createdAt")
         SELECT 'plan-fill-' || (g % 40), 'event_open', $1, 'someone', 'A title',
                now() - make_interval(mins => g)
           FROM generate_series(1, 4000) g`,
      [E]
    );
    try {
      await q('ANALYZE post_notifications');
      const [sql, params] = bell.bellPageQuery('f1', 30).getQueryAndParameters();
      const plan = JSON.stringify(
        (await q(`EXPLAIN (FORMAT JSON) ${sql}`, params))[0]['QUERY PLAN'][0].Plan
      );
      expect(plan).not.toContain('"Node Type":"Sort"');
    } finally {
      await q(`DELETE FROM post_notifications WHERE "recipientId" LIKE 'plan-fill-%'`);
    }
  });
});
