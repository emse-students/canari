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
        campus varchar(32), cursus jsonb NOT NULL DEFAULT '[]');
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

  it("keeps the bell's one statement walking the reader's index with no sort", async () => {
    await row('f1', 'event_open', E);
    const [sql, params] = bell.bellPageQuery('f1', 30).getQueryAndParameters();
    const plan = JSON.stringify(
      (await q(`EXPLAIN (FORMAT JSON) ${sql}`, params))[0]['QUERY PLAN'][0].Plan
    );
    expect(plan).not.toContain('"Node Type":"Sort"');
  });
});
