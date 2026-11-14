/**
 * THE AGENDA SUBSCRIPTION LINK IS ITS HOLDER'S (owner, 2026-11-14, "Respecter les publics"), against
 * a REAL PostgreSQL - migrations 071, 078, 132 and 170 applied.
 *
 * The service and the controller run for real: a token minted by `POST calendar/subscription`
 * (`subscribeAgenda`) is read back through `GET calendar/feed?token=` exactly as a calendar app would
 * read the `.ics`, and what it serves is asked of the shipped SQL each time. The cases are the
 * owner's: a holder outside an association's audience gets nothing until they join it; a holder who
 * loses their space stops receiving it on the SAME token; a students-only event follows the holder's
 * public; a legacy `sig` link for an association alone serves only events reaching every open space;
 * the erasure's own statement deletes the row and the token then answers 403.
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

maybe('the agenda subscription link against PostgreSQL (migration 170)', () => {
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

  /** What a calendar app holding `token` is served: event ids, or 403. */
  async function served(token: string): Promise<string[] | 403> {
    const res = response();
    const rows = await controller.aggregatedCalendarFeed(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      token,
      res as never
    );
    if (res.statusCode === 403) return 403;
    expect(res.headers['Cache-Control']).toBe('private, max-age=120');
    return (rows as Array<{ id: string }>).map((r) => r.id).sort();
  }

  /** What a legacy `sig` link for `selection` is served, read anonymously: event ids. */
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
    const rows = await controller.aggregatedCalendarFeed(
      undefined,
      undefined,
      selection.associationId,
      undefined,
      undefined,
      undefined,
      selection.campus,
      selection.formation,
      sig,
      undefined,
      response() as never
    );
    return (rows as Array<{ id: string }>).map((r) => r.id).sort();
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
    // The tables production's `synchronize` built; `agenda_subscriptions` is migration 170's.
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
      '170_agenda_subscriptions.sql',
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
    const redis = { deleteByPattern: () => Promise.resolve(0) } as never;
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

  it('migration 170 replays cleanly, and one selection gives ONE row and the same link', async () => {
    await q(migration('170_agenda_subscriptions.sql'));
    const first = await controller.subscribeCalendarFeed('si', { campus: SE, formation: 'ICM' });
    const again = await controller.subscribeCalendarFeed('si', { campus: SE, formation: 'ICM' });
    expect(again.token).toBe(first.token);
    // NULLs count equal: an association-only selection does not pile up either.
    const a = await controller.subscribeCalendarFeed('si', { associationId: N });
    const b = await controller.subscribeCalendarFeed('si', { associationId: N });
    expect(b.token).toBe(a.token);
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

  it('(d) a legacy sig for an association alone serves only events reaching EVERY open space', async () => {
    // N reaches ICM x Saint-Etienne only: a legacy association link could be held by anyone.
    expect(await servedLegacy({ associationId: N })).toEqual([]);
    expect(await servedLegacy({ associationId: W })).toEqual([EW]);
    // A campus alone (the staff link): every open space of that campus - W reaches all of them, and
    // so does I (its rule is the whole Saint-Etienne campus); N does not.
    expect(await servedLegacy({ campus: SE })).toEqual([EI, EW].sort());
    // A pair is unchanged: every legitimate holder was in that space.
    expect(await servedLegacy({ campus: SE, formation: 'ICM' })).toEqual([EI, EN, EW].sort());
    // With no open space matching, nothing is served: never "everything".
    await q(`DELETE FROM spaces WHERE campus = $1`, [GA]);
    try {
      expect(await servedLegacy({ campus: GA })).toEqual([]);
    } finally {
      await q(
        `INSERT INTO spaces (formation, campus)
           SELECT f, $1 FROM unnest(ARRAY['ICM', 'ISMIN', 'FSSS', 'PDIS', 'Autre']) AS f`,
        [GA]
      );
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
});
