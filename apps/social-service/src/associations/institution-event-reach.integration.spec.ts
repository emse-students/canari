/**
 * AN INSTITUTION'S EVENT REACH AGAINST A REAL POSTGRESQL (owner, 2026-11-13) - migrations 071, 078,
 * 132 and 165 applied, 165 on an `association_calendar_events` table that does not have the columns.
 *
 * The rule: an institution chooses, at every event it files, the SPACES of its own audience the
 * event targets and the PUBLIC in them - everyone, the students, the staff - exactly as for its
 * posts, read by the SAME fragments inside the ONE event predicate, `eventVisibleToUserSql`. So
 * every reader path (the agenda lists, the JSON and `.ics` feeds, a form's linked event, the event
 * card on a post, the opening push) is asked here through the shipped statements, each with the
 * reach the cases below write - and an edit is a new row value, read at once.
 *
 * The cast, and the door each one has to I's event E when E carries no reach:
 *   si - a student, ICM x Saint-Etienne                     - I's rules (the whole Saint-Etienne)
 *   ss - a student, ISMIN x Saint-Etienne                   - I's rules
 *   sg - a student, ISMIN x Gardanne                        - none (C's rules, once C co-organises)
 *   mb - a member of I, no cursus                            - its membership (D21)
 *   cm - a member of C, no cursus                            - none (C's membership, once C co-organises)
 *   nr - a named reader (grant: ICM x Saint-Etienne), staff - the grant
 *   os - staff of Saint-Etienne, no door at all              - nothing
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like every integration spec here. Locally:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- institution-event-reach.integration
 *
 * Everything happens in a throwaway schema, dropped at the end.
 */
// FIRST: the review cohort the import-time fragments of reader-spaces are built with.
import '../spaces/review-cohort.it-fixture';
import { readFileSync } from 'fs';
import { join } from 'path';
import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createPostNotificationsTable } from '../posts/post-notifications.it-schema';
import { AssociationsService } from './associations.service';
import {
  INSTITUTION_REACH_CODES,
  institutionReachOptionsOffered,
  resolveInstitutionReachWrite,
  type InstitutionReach,
} from '../spaces/institution-reach';
import {
  eventCardShownToViewerSql,
  eventReachesSpaceMatchingSql,
  eventVisibleToViewerSql,
} from '../spaces/reader-spaces';

/** The service's own anonymous-read clause, run against a capturing query builder. */
const restrictAnonymous = (
  AssociationsService.prototype as unknown as {
    restrictAnonymousToPublicReach: (
      this: unknown,
      qb: { andWhere: (sql: string) => void },
      opts:
        | {
            viewer?: { userId?: string };
            selection?: { campus: string | null; formation: string | null };
            signedEvent?: boolean;
          }
        | undefined
    ) => void;
  }
).restrictAnonymousToPublicReach;

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const migration = (file: string) => readFileSync(join(__dirname, '..', 'migrations', file), 'utf8');

const SE = 'saint-etienne';
const GA = 'gardanne';
const USERS: Record<string, { campus: string | null; formation: string | null }> = {
  si: { campus: SE, formation: 'ICM' },
  ss: { campus: SE, formation: 'ISMIN' },
  sg: { campus: GA, formation: 'ISMIN' },
  mb: { campus: SE, formation: null },
  cm: { campus: GA, formation: null },
  nr: { campus: null, formation: null },
  os: { campus: SE, formation: null },
};
const READERS = ['si', 'ss', 'sg', 'mb', 'cm', 'nr', 'os'] as const;
type Reader = (typeof READERS)[number];

const I = '00000000-0000-4000-8000-0000000e1001'; // institution, the whole Saint-Etienne campus
const C = '00000000-0000-4000-8000-0000000e1002'; // association, all Gardanne: co-organises once
const A = '00000000-0000-4000-8000-0000000e1003'; // an ordinary association, ICM x Saint-Etienne
const E = '00000000-0000-4000-8000-0000000ee001'; // I's event

const ICM_SE = { formation: 'ICM', campus: SE };
const ISMIN_SE = { formation: 'ISMIN', campus: SE };
const ICM_GA = { formation: 'ICM', campus: GA };

/** The four reaches the cases write, and who reads E under each (the predicate's answer). */
const CASES: { name: string; reach: InstitutionReach | null; readers: Reader[] }[] = [
  {
    name: 'no reach (an event filed before it): the whole audience, everyone',
    reach: null,
    readers: ['si', 'ss', 'mb', 'nr'],
  },
  {
    // ss loses its unticked space; the member and the named reader of the ticked cell keep it.
    name: 'ICM x Saint-Etienne, everyone',
    reach: { spaces: [ICM_SE], public: 'all' },
    readers: ['si', 'mb', 'nr'],
  },
  {
    // The named reader (staff) loses it - "students" closes the grant door; I's member keeps it.
    name: 'ICM and ISMIN x Saint-Etienne, students',
    reach: { spaces: [ICM_SE, ISMIN_SE], public: 'students' },
    readers: ['si', 'ss', 'mb'],
  },
  {
    // Students lose it; staff keep the doors they had (the member, the named reader).
    name: 'ICM and ISMIN x Saint-Etienne, staff',
    reach: { spaces: [ICM_SE, ISMIN_SE], public: 'staff' },
    readers: ['mb', 'nr'],
  },
];

maybe("an institution's event reach against PostgreSQL (migration 165)", () => {
  const schema = `institution_event_reach_it_${Math.random().toString(36).slice(2, 10)}`;
  let ds: DataSource;
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  /** Writes a reach on E as the shipped write stores it: two columns, nothing else. */
  const setReach = (reach: InstitutionReach | null) =>
    q(
      `UPDATE association_calendar_events SET "reachPublic" = $2, "reachSpaces" = $3::jsonb WHERE id = $1`,
      [E, reach?.public ?? null, reach ? JSON.stringify(reach.spaces) : null]
    );

  /** THE SIGNED-IN AGENDA'S FILTER (`restrictToViewerSpaces`), as shipped. */
  const sees = async (reader: string) =>
    (
      await q(
        `SELECT ${eventVisibleToViewerSql('e', '$2')} AS v FROM association_calendar_events e WHERE e.id = $1`,
        [E, reader]
      )
    )[0].v === true;

  async function readersOf(test: (r: Reader) => Promise<boolean>): Promise<Reader[]> {
    const out: Reader[] = [];
    for (const r of READERS) if (await test(r)) out.push(r);
    return out;
  }

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      synchronize: false,
      extra: { options: `-c search_path=${schema},public` },
    });
    await ds.initialize();
    await q(`CREATE SCHEMA ${schema}`);
    // The events table WITHOUT the reach columns: migration 165 adds them, as on every estate.
    await q(`
      CREATE TABLE users (id varchar(255) PRIMARY KEY, admin boolean NOT NULL DEFAULT false,
        campus varchar(32), cursus jsonb NOT NULL DEFAULT '[]');
      CREATE TABLE associations (id uuid PRIMARY KEY, name varchar NOT NULL, slug varchar NOT NULL,
        type varchar NOT NULL DEFAULT 'association', archived boolean NOT NULL DEFAULT false,
        "isBDE" boolean NOT NULL DEFAULT false, "createdBy" varchar(255));
      -- Only for migration 071's foreign key; no post is read here.
      CREATE TABLE posts (id uuid PRIMARY KEY);
      CREATE TABLE association_members (id serial PRIMARY KEY, "associationId" uuid NOT NULL,
        "userId" varchar(255) NOT NULL, permissions int NOT NULL DEFAULT 0);
      CREATE TABLE association_calendar_events (id uuid PRIMARY KEY, "associationId" uuid NOT NULL,
        title varchar(200) NOT NULL, status varchar(16) NOT NULL DEFAULT 'validated',
        presentation varchar(16) NOT NULL DEFAULT 'association');
      CREATE TABLE association_calendar_event_co_owners (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        event_id uuid NOT NULL, association_id uuid NOT NULL);
    `);
    await createPostNotificationsTable(q);
    for (const file of [
      '071_spaces.sql',
      '078_read_grants.sql',
      '132_read_grant_readers.sql',
      '165_institution_event_reach.sql',
    ]) {
      await q(migration(file));
    }
    for (const [id, name, type, rule] of [
      [I, 'I', 'institution', [null, SE]],
      [C, 'C', 'association', [null, GA]],
      [A, 'A', 'association', ['ICM', SE]],
    ] as const) {
      await q(`INSERT INTO associations (id, name, slug, type) VALUES ($1, $2, $2, $3)`, [
        id,
        name,
        type,
      ]);
      await q(
        `INSERT INTO association_audiences ("associationId", formation, campus) VALUES ($1, $2, $3)`,
        [id, rule[0], rule[1]]
      );
    }
    for (const [id, u] of Object.entries(USERS)) {
      await q(`INSERT INTO users (id, campus, cursus) VALUES ($1, $2, $3)`, [
        id,
        u.campus,
        JSON.stringify(u.formation ? [{ formation: u.formation, promo: 2024 }] : []),
      ]);
    }
    await q(
      `INSERT INTO association_members ("associationId", "userId") VALUES ($1, 'mb'), ($2, 'cm')`,
      [I, C]
    );
    await q(
      `INSERT INTO read_grants (user_id, campus, formation, granted_by) VALUES ('nr', $1, 'ICM', 'admin')`,
      [SE]
    );
    await q(
      `INSERT INTO association_calendar_events (id, "associationId", title) VALUES ($1, $2, 'Gala')`,
      [E, I]
    );
  });

  afterEach(async () => {
    await setReach(null);
    await q(`DELETE FROM association_calendar_event_co_owners`);
  });

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    await q(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await ds.destroy();
  });

  it('migration 165: every event starts with no reach, the CHECKs hold, a re-run is safe', async () => {
    const rows = await q(
      `SELECT count(*)::int AS n FROM association_calendar_events WHERE "reachPublic" IS NOT NULL`
    );
    expect(rows[0].n).toBe(0);
    await expect(
      q(`UPDATE association_calendar_events SET "reachPublic" = 'all' WHERE id = $1`, [E])
    ).rejects.toThrow(/CHK_calendar_events_reach_together/);
    await expect(
      q(
        `UPDATE association_calendar_events SET "reachPublic" = 'everyone', "reachSpaces" = $2::jsonb WHERE id = $1`,
        [E, JSON.stringify([ICM_SE])]
      )
    ).rejects.toThrow(/CHK_calendar_events_reach_public/);
    await expect(
      q(
        `UPDATE association_calendar_events SET "reachPublic" = 'all', "reachSpaces" = '[]'::jsonb WHERE id = $1`,
        [E]
      )
    ).rejects.toThrow(/CHK_calendar_events_reach_spaces_shape/);
    await q(migration('165_institution_event_reach.sql'));
  });

  for (const c of CASES) {
    it(`the agenda predicate: ${c.name}`, async () => {
      await setReach(c.reach);
      expect(await readersOf(sees)).toEqual(c.readers);
    });
  }

  it('an edit narrows the event at once, and widening gives it back', async () => {
    expect(await sees('ss')).toBe(true);
    await setReach({ spaces: [ICM_SE], public: 'all' });
    expect(await sees('ss')).toBe(false);
    expect(await sees('si')).toBe(true);
    await setReach({ spaces: [ICM_SE, ISMIN_SE], public: 'all' });
    expect(await sees('ss')).toBe(true);
  });

  it('a ticked space outside the audience opens nothing (never wider than the audience)', async () => {
    await setReach({ spaces: [ICM_GA], public: 'all' });
    // No Gardanne student is reached through I's rules, which reach Saint-Etienne only.
    expect(await readersOf(sees)).toEqual(['mb']);
  });

  it("an accepted co-organiser's door keeps its own audience; only the public follows the event there", async () => {
    await q(
      `INSERT INTO association_calendar_event_co_owners (event_id, association_id) VALUES ($1, $2)`,
      [E, C]
    );
    // ICM x Saint-Etienne for students: si through I's ticked space, sg through C's rules (G4), and
    // C's staff member cm because a co-organiser's members read the event they co-own.
    await setReach({ spaces: [ICM_SE], public: 'students' });
    expect(await readersOf(sees)).toEqual(['si', 'sg', 'mb', 'cm']);
    // For staff: no student, whichever door.
    await setReach({ spaces: [ICM_SE], public: 'staff' });
    expect(await readersOf(sees)).toEqual(['mb', 'cm', 'nr']);
  });

  it('the anonymous selection: a ticked space matches, an unticked one does not, a staff event reaches no space', async () => {
    const matches = async (formation: string | null, campus: string | null) => {
      const params: unknown[] = [E];
      const slot = (value: string | null) => {
        if (value === null) return null;
        params.push(value);
        return `$${params.length}`;
      };
      const filter = { formation: slot(formation), campus: slot(campus) };
      const rows = await q(
        `SELECT ${eventReachesSpaceMatchingSql('e', filter)} AS v FROM association_calendar_events e WHERE e.id = $1`,
        params
      );
      return rows[0].v === true;
    };
    expect(await matches('ISMIN', SE)).toBe(true);
    await setReach({ spaces: [ICM_SE], public: 'all' });
    expect(await matches('ICM', SE)).toBe(true);
    expect(await matches('ISMIN', SE)).toBe(false);
    expect(await matches(null, SE)).toBe(true);
    await setReach({ spaces: [ICM_SE], public: 'students' });
    expect(await matches('ICM', SE)).toBe(true);
    await setReach({ spaces: [ICM_SE], public: 'staff' });
    expect(await matches('ICM', SE)).toBe(false);
    expect(await matches(null, SE)).toBe(false);
  });

  it('a signed selection feed (anonymous) withholds a students event and a staff event, ticked space or not', async () => {
    // THE SHIPPED COMPOSITION of an anonymous `.ics`/JSON feed per selection: the selection filter
    // (`restrictToSelection`) AND what `restrictAnonymousToPublicReach` itself adds for this read -
    // captured from the service's own method, so the clause run here is the one it ships.
    const anonymousClauses = (opts: Parameters<typeof restrictAnonymous>[1]) => {
      const added: string[] = [];
      const qb = { andWhere: (sql: string) => added.push(sql) };
      restrictAnonymous.call({ logger: { debug: () => undefined } }, qb, opts);
      return added;
    };
    const inSelectionFeed = async (opts: Parameters<typeof restrictAnonymous>[1]) => {
      const where = [
        eventReachesSpaceMatchingSql('e', { formation: '$2', campus: '$3' }),
        ...anonymousClauses(opts),
      ].join(' AND ');
      const rows = await q(
        `SELECT ${where} AS v FROM association_calendar_events e WHERE e.id = $1`,
        [E, 'ICM', SE]
      );
      return rows[0].v === true;
    };
    // The feed's own options: a signed selection, no reader.
    const anonymous = { selection: { campus: SE, formation: 'ICM' } };
    await setReach({ spaces: [ICM_SE], public: 'all' });
    expect(await inSelectionFeed(anonymous)).toBe(true);
    // Same rules as posts: a students or staff public never reaches an anonymous reader, even
    // through the very space it ticked.
    await setReach({ spaces: [ICM_SE], public: 'students' });
    expect(await inSelectionFeed(anonymous)).toBe(false);
    await setReach({ spaces: [ICM_SE], public: 'staff' });
    expect(await inSelectionFeed(anonymous)).toBe(false);
    // The signed ONE-event link is left whole (it shares one event its holder could read), and a
    // signed-in reader is judged by their own predicate, not by this clause.
    await setReach({ spaces: [ICM_SE], public: 'students' });
    expect(anonymousClauses({ signedEvent: true })).toEqual([]);
    expect(anonymousClauses({ viewer: { userId: 'si' } })).toEqual([]);
  });

  it('the event card on a post: unchanged without a reach, the event predicate with one', async () => {
    const shown = async (viewer: string | null) =>
      (
        await q(
          `SELECT ${eventCardShownToViewerSql('e', '$2')} AS v FROM association_calendar_events e WHERE e.id = $1`,
          [E, viewer]
        )
      )[0].v === true;
    // No reach: the card follows its post, whoever reads it (a republication's reader included).
    expect(await shown('os')).toBe(true);
    await setReach({ spaces: [ICM_SE], public: 'all' });
    expect(await shown('os')).toBe(false);
    expect(await shown('ss')).toBe(false);
    expect(await shown('si')).toBe(true);
    expect(await shown(null)).toBe(false);
  });

  it("the write: the institution's own audience is the ceiling, the posts' codes refuse the rest", async () => {
    const write = (
      associationId: string,
      type: string,
      raw: unknown,
      mode: 'create' | 'edit' = 'create'
    ) =>
      resolveInstitutionReachWrite(ds.manager, {
        mode,
        associationId,
        associationType: type,
        raw,
        subject: 'event',
      });
    // The refusal is classified at the throw: a BadRequestException carrying its typed code, or
    // nothing to read when the write did not refuse.
    const code = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: unknown) =>
          e instanceof BadRequestException
            ? (e.getResponse() as { code: string }).code
            : `not a BadRequestException: ${String(e)}`
      );
    await expect(write(I, 'institution', { spaces: [ICM_SE], public: 'all' })).resolves.toEqual({
      reachPublic: 'all',
      reachSpaces: [ICM_SE],
    });
    expect(await code(write(I, 'institution', undefined))).toBe(INSTITUTION_REACH_CODES.required);
    expect(await code(write(I, 'institution', { spaces: [ICM_GA], public: 'all' }))).toBe(
      INSTITUTION_REACH_CODES.outsideAudience
    );
    expect(await code(write(A, 'association', { spaces: [ICM_SE], public: 'all' }))).toBe(
      INSTITUTION_REACH_CODES.notOffered
    );
    // An edit without a reach leaves the stored one alone.
    await expect(write(I, 'institution', undefined, 'edit')).resolves.toBeUndefined();
    // The options are the audience's spaces, campus then formation, and only for an institution.
    const { spaces } = await institutionReachOptionsOffered(ds.manager, I, 'institution', 'event');
    expect(spaces.every((s) => s.campus === SE)).toBe(true);
    expect(spaces).toEqual(expect.arrayContaining([ICM_SE, ISMIN_SE]));
    expect(await code(institutionReachOptionsOffered(ds.manager, A, 'association', 'event'))).toBe(
      INSTITUTION_REACH_CODES.notOffered
    );
  });
});
