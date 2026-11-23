/**
 * THE AGENDA SUBSCRIPTION LINK IS ITS HOLDER'S (owner, 2026-11-14, "Respecter les publics"), against
 * a REAL PostgreSQL - migrations 071, 078, 132 and 173 applied.
 *
 * The service and the controller run for real: a token minted by `POST calendar/subscription`
 * (`subscribeAgenda`) is read back through `GET calendar/feed.ics?token=` exactly as a calendar app
 * reads it, and what it serves is asked of the shipped SQL each time. The cases are the owner's: a
 * holder outside an association's audience gets nothing until they join it; a holder who loses their
 * space stops receiving it on the SAME token; a students-only event follows the holder's public; a
 * legacy `sig` link that is not a (campus, formation) pair answers an EMPTY calendar, a pair is served
 * as before; the erasure's own statement deletes the row and the token then answers 403. Last, the
 * table is built from the ENTITY alone (`synchronize`), and the one-statement subscribe still gives
 * one row per selection on it.
 *
 * The cast (every space of migration 071 is open: five formations x two campuses):
 *   si - a student, ICM x Saint-Etienne
 *   nr - a named reader (grant: ICM x Saint-Etienne), no campus, no cursus
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like every integration spec here. Locally:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- agenda-subscription.integration
 *
 * Everything happens in a throwaway schema, dropped at the end.
 */
// FIRST: the review cohort the import-time fragments of reader-spaces are built with.
import '../spaces/review-cohort.it-fixture';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { AssociationsController } from './associations.controller';
import { AssociationsService } from './associations.service';
import { Association } from './entities/association.entity';
import { AssociationMember } from './entities/association-member.entity';
import { AssociationCalendarEvent } from './entities/association-calendar-event.entity';
import { AssociationCalendarEventCoOwner } from './entities/association-calendar-event-co-owner.entity';
import { AgendaSubscription } from './entities/agenda-subscription.entity';
import { createPostNotificationsTable } from '../posts/post-notifications.it-schema';
import { Form } from '../forms/entities/form.entity';
import { Submission } from '../forms/entities/submission.entity';
import { signAgendaSelection } from './agenda-signature';
import { ERASURE_STATEMENTS } from '../internal/account-erasure';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const migration = (file: string) => readFileSync(join(__dirname, '..', 'migrations', file), 'utf8');

const KEY = 'agenda-it-key-0123456789abcdef0123456789';
const SE = 'saint-etienne';
const GA = 'gardanne';

const N = '00000000-0000-4000-8000-0000000f1001'; // narrow: ICM x Saint-Etienne
const W = '00000000-0000-4000-8000-0000000f1002'; // wide: every space
const G = '00000000-0000-4000-8000-0000000f1003'; // the whole Gardanne campus
const I = '00000000-0000-4000-8000-0000000f1004'; // an institution, the whole Saint-Etienne campus

const EN = '00000000-0000-4000-8000-0000000fe001';
const EW = '00000000-0000-4000-8000-0000000fe002';
const EG = '00000000-0000-4000-8000-0000000fe003';
const EI = '00000000-0000-4000-8000-0000000fe004';

maybe('the agenda subscription link against PostgreSQL (migration 173)', () => {
  const schema = `agenda_sub_it_${Math.random().toString(36).slice(2, 10)}`;
  const previousKey = process.env.AGENDA_SIGNING_KEY;
  let admin: Client;
  let ds: DataSource;
  let service: AssociationsService;
  let controller: AssociationsController;
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  const response = () => {
    const res = { statusCode: 200, headers: {} as Record<string, string> };
    return Object.assign(res, {
      status: (code: number) => {
        res.statusCode = code;
      },
      setHeader: (name: string, value: string) => {
        res.headers[name] = value;
      },
    });
  };

  /** The event ids an `.ics` body carries (`UID:<id>@canari`), sorted. */
  const uids = (body: string) =>
    [...body.matchAll(/^UID:([0-9a-f-]+)@canari/gm)].map((m) => m[1]).sort();

  /** What a calendar app holding `token` is served: event ids, or 403. */
  async function served(token: string): Promise<string[] | 403> {
    const res = response();
    const body = await controller.aggregatedCalendarFeedIcs(
      undefined,
      undefined,
      undefined,
      undefined,
      res as never,
      undefined,
      undefined,
      undefined,
      token
    );
    if (res.statusCode === 403) return 403;
    expect(res.headers['Cache-Control']).toBe('private, max-age=120');
    return uids(body);
  }

  /** What a legacy `sig` link for `selection` is served, as a calendar app reads it: event ids. */
  async function servedLegacy(selection: {
    campus?: string;
    formation?: string;
    associationId?: string;
  }): Promise<string[]> {
    const sig = signAgendaSelection({
      campus: (selection.campus ?? null) as never,
      formation: (selection.formation ?? null) as never,
      associationId: selection.associationId ?? null,
    });
    const res = response();
    const body = await controller.aggregatedCalendarFeedIcs(
      undefined,
      undefined,
      selection.associationId,
      undefined,
      res as never,
      selection.campus,
      selection.formation,
      sig,
      undefined
    );
    // Still a valid calendar, so the app keeps the subscription and shows nothing.
    expect(res.statusCode).toBe(200);
    expect(body).toContain('BEGIN:VCALENDAR');
    return uids(body);
  }

  beforeAll(async () => {
    process.env.AGENDA_SIGNING_KEY = KEY;
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [
        Association,
        AssociationMember,
        AssociationCalendarEvent,
        AssociationCalendarEventCoOwner,
        Form,
        Submission,
      ],
      synchronize: false,
      extra: { options: `-c search_path=${schema},public`, application_name: schema },
    });
    await ds.initialize();
    // The tables production's `synchronize` built; `agenda_subscriptions` is migration 173's.
    await ds.synchronize();
    await q(`
      CREATE TABLE users (id varchar(255) PRIMARY KEY, admin boolean NOT NULL DEFAULT false,
        campus varchar(32), cursus jsonb NOT NULL DEFAULT '[]', promo int);
      CREATE TABLE posts (id uuid PRIMARY KEY);
      ALTER TABLE associations ADD COLUMN "isBDE" boolean NOT NULL DEFAULT false;
    `);
    await createPostNotificationsTable(q);
    for (const [id, name, type] of [
      [N, 'Narrow', 'association'],
      [W, 'Wide', 'association'],
      [G, 'Gardanne club', 'association'],
      [I, 'School', 'institution'],
    ]) {
      await q(
        `INSERT INTO associations (id, name, slug, type, "createdBy") VALUES ($1, $2, $3, $4, 'it')`,
        [id, name, name.toLowerCase().replace(/ /g, '-'), type]
      );
    }
    for (const file of [
      '071_spaces.sql',
      '078_read_grants.sql',
      '132_read_grant_readers.sql',
      '173_agenda_subscriptions.sql',
    ]) {
      await q(migration(file));
    }
    // 071 gave every association (ICM, saint-etienne); set each one's real rule.
    for (const [id, formation, campus] of [
      [W, null, null],
      [G, null, GA],
      [I, null, SE],
    ] as const) {
      await q(`DELETE FROM association_audiences WHERE "associationId" = $1`, [id]);
      await q(
        `INSERT INTO association_audiences ("associationId", formation, campus) VALUES ($1, $2, $3)`,
        [id, formation, campus]
      );
    }
    await q(`INSERT INTO users (id, campus, cursus) VALUES ('si', $1, $2), ('nr', NULL, '[]')`, [
      SE,
      JSON.stringify([{ formation: 'ICM', promo: 2024 }]),
    ]);
    await q(
      `INSERT INTO read_grants (user_id, campus, formation, granted_by) VALUES ('nr', $1, 'ICM', 'admin')`,
      [SE]
    );
    const soon = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    for (const [id, owner] of [
      [EN, N],
      [EW, W],
      [EG, G],
      [EI, I],
    ]) {
      await q(
        `INSERT INTO association_calendar_events (id, "associationId", title, "startsAt", "createdBy", status)
           VALUES ($1, $2, 'Evening', $3, 'it', 'validated')`,
        [id, owner, soon]
      );
    }

    const none = {} as never;
    const redis = {
      incr: () => Promise.resolve(1),
      deleteByPattern: () => Promise.resolve(0),
    } as never;
    service = new AssociationsService(
      ds.getRepository(Association),
      ds.getRepository(AssociationMember),
      ds.getRepository(AssociationCalendarEvent),
      ds.getRepository(AssociationCalendarEventCoOwner),
      none,
      none,
      none,
      ds.getRepository(Form),
      none,
      redis,
      none,
      none,
      none,
      { enabled: () => false, tell: async () => 0 } as never
    );
    controller = new AssociationsController(service, none, none, none, none, none, none, none);
  });

  afterAll(async () => {
    if (previousKey === undefined) delete process.env.AGENDA_SIGNING_KEY;
    else process.env.AGENDA_SIGNING_KEY = previousKey;
    if (ds?.isInitialized) await ds.destroy();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  it('migration 173 replays cleanly, and one selection gives ONE row and the same link', async () => {
    await q(migration('173_agenda_subscriptions.sql'));
    const first = await controller.subscribeCalendarFeed('si', { campus: SE, formation: 'ICM' });
    const again = await controller.subscribeCalendarFeed('si', { campus: SE, formation: 'ICM' });
    expect(again.token).toBe(first.token);
    // The key spells a missing side `-`: an association-only selection does not pile up either.
    const a = await controller.subscribeCalendarFeed('si', { associationId: N });
    const b = await controller.subscribeCalendarFeed('si', { associationId: N });
    expect(b.token).toBe(a.token);
    // An upper-case id names the same association: the same row, the same link.
    const upper = await controller.subscribeCalendarFeed('si', { associationId: N.toUpperCase() });
    expect(upper.token).toBe(a.token);
    const [{ n }] = await q(
      `SELECT count(*)::int AS n FROM agenda_subscriptions WHERE "userId" = 'si'`
    );
    expect(n).toBe(2);
    await controller.revokeCalendarSubscriptions('si');
  });

  it('(a) a holder outside an association audience, not a member, gets NOTHING - then its events once a member', async () => {
    const { token } = await controller.subscribeCalendarFeed('si', { associationId: G });
    expect(await served(token)).toEqual([]);
    await q(
      `INSERT INTO association_members ("associationId", "userId", role, permissions)
               VALUES ($1, 'si', 'member', 0)`,
      [G]
    );
    try {
      expect(await served(token)).toEqual([EG]);
    } finally {
      await q(`DELETE FROM association_members WHERE "userId" = 'si'`);
    }
    await controller.revokeCalendarSubscriptions('si');
  });

  it("(b) a holder who loses their space stops receiving that space's events on the SAME token", async () => {
    const { token } = await controller.subscribeCalendarFeed('si', {
      campus: SE,
      formation: 'ICM',
    });
    expect(await served(token)).toEqual([EI, EN, EW].sort());
    await q(`UPDATE users SET campus = $1, cursus = $2 WHERE id = 'si'`, [
      GA,
      JSON.stringify([{ formation: 'ISMIN', promo: 2024 }]),
    ]);
    try {
      // The holder now reads Gardanne; the token still names (ICM, Saint-Etienne). The events only
      // that space reached (N's, the School's) stop; W's reaches every space, the holder's new one
      // included, and still matches the selection.
      expect(await served(token)).toEqual([EW]);
    } finally {
      await q(`UPDATE users SET campus = $1, cursus = $2 WHERE id = 'si'`, [
        SE,
        JSON.stringify([{ formation: 'ICM', promo: 2024 }]),
      ]);
    }
    expect(await served(token)).toEqual([EI, EN, EW].sort());
    await controller.revokeCalendarSubscriptions('si');
  });

  it('(c) a students-only event is served to a student holder and not to a non-student holder', async () => {
    const student = (await controller.subscribeCalendarFeed('si', { associationId: I })).token;
    const named = (await controller.subscribeCalendarFeed('nr', { associationId: I })).token;
    const setReach = (pub: string | null) =>
      q(
        `UPDATE association_calendar_events SET "reachPublic" = $2, "reachSpaces" = $3::jsonb WHERE id = $1`,
        [EI, pub, pub ? JSON.stringify([{ formation: 'ICM', campus: SE }]) : null]
      );
    try {
      await setReach('all');
      expect(await served(student)).toEqual([EI]);
      expect(await served(named)).toEqual([EI]);
      await setReach('students');
      expect(await served(student)).toEqual([EI]);
      expect(await served(named)).toEqual([]);
    } finally {
      await setReach(null);
      await controller.revokeCalendarSubscriptions('si');
      await controller.revokeCalendarSubscriptions('nr');
    }
  });

  it('(d) a legacy sig that is not a pair answers an EMPTY calendar; a pair is served as before', async () => {
    // An association alone was signed for anyone: N reaches one space, W every space - both empty.
    expect(await servedLegacy({ associationId: N })).toEqual([]);
    expect(await servedLegacy({ associationId: W })).toEqual([]);
    // A campus alone (the staff link) and a formation alone (signed before 2026-10-07): empty.
    expect(await servedLegacy({ campus: SE })).toEqual([]);
    expect(await servedLegacy({ formation: 'ICM' })).toEqual([]);
    // A pair is unchanged: every legitimate holder was in that space.
    expect(await servedLegacy({ campus: SE, formation: 'ICM' })).toEqual([EI, EN, EW].sort());
    expect(await servedLegacy({ campus: SE, formation: 'ICM', associationId: N })).toEqual([EN]);
  });

  it('(f) a staff holder is served EXACTLY its in-app agenda: its grants and memberships, and nothing of its campus otherwise', async () => {
    await q(`INSERT INTO users (id, campus, cursus) VALUES ('st', $1, '[]')`, [SE]);
    const inApp = async () =>
      (
        (await service.listAggregatedCalendarFeed(undefined, undefined, undefined, {
          viewer: { userId: 'st' },
        })) as { id: string }[]
      )
        .map((e) => e.id)
        .sort();
    const grant = (campus: string) =>
      q(
        `INSERT INTO read_grants (user_id, campus, formation, granted_by) VALUES ('st', $1, 'ICM', 'admin')`,
        [campus]
      );
    // The one link a staff account can ask: its own campus, no formation.
    const { token } = await controller.subscribeCalendarFeed('st', { campus: SE });
    try {
      // No grant, no membership: nothing on either surface - the School and the associations of
      // its campus address spaces, and staff have none.
      expect(await inApp()).toEqual([]);
      expect(await served(token)).toEqual([]);

      // One grant on its own campus: exactly that grant's events, on both.
      await grant(SE);
      expect(await inApp()).toEqual([EI, EN, EW].sort());
      expect(await served(token)).toEqual(await inApp());

      // One grant on the OTHER campus: the app shows it, and so does the link - the link's campus
      // is not a filter on what a grant opens.
      await q(`DELETE FROM read_grants WHERE user_id = 'st'`);
      await grant(GA);
      expect(await inApp()).toEqual([EG, EW].sort());
      expect(await served(token)).toEqual(await inApp());

      // A membership on the other campus, alone: the same.
      await q(`DELETE FROM read_grants WHERE user_id = 'st'`);
      await q(
        `INSERT INTO association_members ("associationId", "userId", role, permissions)
               VALUES ($1, 'st', 'member', 0)`,
        [G]
      );
      expect(await inApp()).toEqual([EG]);
      expect(await served(token)).toEqual([EG]);
    } finally {
      await q(`DELETE FROM read_grants WHERE user_id = 'st'`);
      await q(`DELETE FROM association_members WHERE "userId" = 'st'`);
      await controller.revokeCalendarSubscriptions('st');
      await q(`DELETE FROM users WHERE id = 'st'`);
    }
  });

  it('(e) the erasure deletes the holder rows, and the token then answers 403', async () => {
    const { token } = await controller.subscribeCalendarFeed('si', {
      campus: SE,
      formation: 'ICM',
    });
    expect(await served(token)).not.toBe(403);
    const statement = ERASURE_STATEMENTS.find((s) => s.label === 'agenda_subscriptions');
    expect(statement).toBeDefined();
    await q(statement!.sql, ['si']);
    expect(await served(token)).toBe(403);
  });

  it('revocation: the old token answers 403, and the next ask mints a NEW link', async () => {
    const before = (await controller.subscribeCalendarFeed('si', { associationId: W })).token;
    await expect(controller.revokeCalendarSubscriptions('si')).resolves.toEqual({ revoked: 1 });
    expect(await served(before)).toBe(403);
    const after = (await controller.subscribeCalendarFeed('si', { associationId: W })).token;
    expect(after).not.toBe(before);
    expect(await served(after)).toEqual([EW]);
    await controller.revokeCalendarSubscriptions('si');
  });

  it('deleting the association deletes its subscriptions (ON DELETE CASCADE)', async () => {
    const { token } = await controller.subscribeCalendarFeed('si', { associationId: G });
    await q(`DELETE FROM association_calendar_events WHERE "associationId" = $1`, [G]);
    await q(`DELETE FROM associations WHERE id = $1`, [G]);
    expect(await served(token)).toBe(403);
  });

  it('a table built from the ENTITY (synchronize, no migration) keeps one row per selection', async () => {
    // A second schema, first on the search path: the entity tables are built there by `synchronize`,
    // while users, spaces and read grants (no entity) are still read from the migrated schema.
    const entitySchema = `${schema}_entity`;
    await admin.query(`CREATE SCHEMA ${entitySchema}`);
    const fromEntity = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [
        Association,
        AssociationMember,
        AssociationCalendarEvent,
        AssociationCalendarEventCoOwner,
        Form,
        Submission,
        AgendaSubscription,
      ],
      synchronize: false,
      extra: {
        options: `-c search_path=${entitySchema},${schema},public`,
        application_name: entitySchema,
      },
    });
    await fromEntity.initialize();
    try {
      await fromEntity.synchronize();
      await fromEntity.query(
        `INSERT INTO associations (id, name, slug, type, "createdBy") VALUES ($1, 'Narrow', 'narrow', 'association', 'it')`,
        [N]
      );
      const none = {} as never;
      const entityService = new AssociationsService(
        fromEntity.getRepository(Association),
        fromEntity.getRepository(AssociationMember),
        fromEntity.getRepository(AssociationCalendarEvent),
        fromEntity.getRepository(AssociationCalendarEventCoOwner),
        none,
        none,
        none,
        fromEntity.getRepository(Form),
        none,
        { incr: () => Promise.resolve(1), deleteByPattern: () => Promise.resolve(0) } as never,
        none,
        none,
        none,
        { enabled: () => false, tell: async () => 0 } as never
      );
      const pair = { campus: SE, formation: 'ICM' } as never;
      const first = await entityService.subscribeAgenda('si', pair, null);
      expect((await entityService.subscribeAgenda('si', pair, null)).token).toBe(first.token);
      const alone = { campus: null, formation: null } as never;
      const a = await entityService.subscribeAgenda('si', alone, N);
      expect((await entityService.subscribeAgenda('si', alone, N)).token).toBe(a.token);
      const [{ n }] = await fromEntity.query(
        `SELECT count(*)::int AS n FROM ${entitySchema}.agenda_subscriptions`
      );
      expect(n).toBe(2);
      // The cascade is the entity's too.
      await fromEntity.query(`DELETE FROM ${entitySchema}.associations WHERE id = $1`, [N]);
      const [{ left }] = await fromEntity.query(
        `SELECT count(*)::int AS left FROM ${entitySchema}.agenda_subscriptions`
      );
      expect(left).toBe(1);
    } finally {
      await fromEntity.destroy();
      await admin.query(`DROP SCHEMA IF EXISTS ${entitySchema} CASCADE`);
    }
  });
});
