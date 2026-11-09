/**
 * PINS PER SPACE (WP-PIN, owner decisions of 2026-11-03), against a REAL PostgreSQL - migrations 071
 * (spaces), 073 (republications), 078 (read grants), 127 (the pins) and 128 (the move of the global
 * pin), hand-made minimal tables for the rest.
 *
 * Every rule of docs/wiki/spaces-and-audiences-reform.md section 11 that lives in SQL is proved here:
 * - "visible in a space" (`postReachesSpaceSql`) is `postVisibleToUserSql` for a reader whose only
 *   door is that space;
 * - two BDEs on one campus: an ISMIN pin is not on top for ICM readers;
 * - an institution's post is pinnable by the BDE of a space it reaches (G9 does not remove it);
 * - a no-space account with a campus-wide read grant is shown the pin, one with a grant on the other
 *   campus is not;
 * - the 4th pin is refused, and two concurrent pins at 2 of 3 leave exactly 3;
 * - a returning hidden pin never makes four shown: it is listed "en attente", and unpinning one of
 *   the 3 promotes it;
 * - migration 128 moves the global pin to every governed space where the post is visible.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`; everything happens in a throwaway schema, dropped at the end.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Logger } from '@nestjs/common';
import { Client } from 'pg';
import { DataSource, type EntityManager, type Repository } from 'typeorm';
import { AssociationPermissionFlag } from '../associations/entities/association-member.entity';
import type { RedisService } from '../common/redis/redis.service';
import { postReachesSpaceSql, postVisibleToUserSql } from '../spaces/reader-spaces';
import type { Post } from './entities/post.entity';
import {
  PINNED_FOR_VIEWER_IDS_SQL,
  PIN_STANDING_IN_SPACE_SQL,
  POST_NOT_FOUND,
  POST_NOT_IN_SPACE,
  SPACE_NOT_FOUND,
  SPACE_PIN_FORBIDDEN,
  SPACE_PIN_LIMIT_CODE,
} from './space-pins';
import { SpacePinsService, type PinActor } from './space-pins.service';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const migration = (name: string) => readFileSync(join(__dirname, '..', 'migrations', name), 'utf8');

const { MODERATE, VALIDATE_EVENTS } = AssociationPermissionFlag;

const A = {
  bdeIcm: '00000000-0000-4000-8000-0000000000b1', // BDE of ICM x saint-etienne
  bdeIsmin: '00000000-0000-4000-8000-0000000000b2', // BDE of ISMIN x saint-etienne
  club: '00000000-0000-4000-8000-0000000000c1', // rule (ISMIN, saint-etienne)
  clubGa: '00000000-0000-4000-8000-0000000000c2', // rule (NULL, gardanne): no BDE governs there
  inst: '00000000-0000-4000-8000-0000000000d1', // institution, rule (NULL, saint-etienne)
  clubArch: '00000000-0000-4000-8000-0000000000c3', // ARCHIVED, rule (ICM, saint-etienne)
} as const;

const P = {
  club1: '10000000-0000-4000-8000-000000000001',
  club2: '10000000-0000-4000-8000-000000000002',
  club3: '10000000-0000-4000-8000-000000000003',
  club4: '10000000-0000-4000-8000-000000000004',
  club5: '10000000-0000-4000-8000-000000000005',
  inst: '10000000-0000-4000-8000-000000000006',
  isminStudent: '10000000-0000-4000-8000-000000000007', // personal, by isminReader
  ga: '10000000-0000-4000-8000-000000000008', // clubGa's, republished by club
  gaOnly: '10000000-0000-4000-8000-000000000009', // clubGa's, never republished
  scheduled: '10000000-0000-4000-8000-00000000000a', // club's, published next year
} as const;

/** Users: [campus, cursus formations]. Probes have exactly one space and no other door. */
const USERS: Record<string, [string | null, string[]]> = {
  icmMod: ['saint-etienne', []],
  icmVal: ['saint-etienne', []],
  isminMod: ['saint-etienne', []],
  icmReader: ['saint-etienne', ['ICM']],
  isminReader: ['saint-etienne', ['ISMIN']],
  staffSe: ['saint-etienne', []], // a campus-wide read grant on saint-etienne
  staffGa: ['gardanne', []], // a campus-wide read grant on gardanne
  admin: [null, []],
};

const GRANT = { userId: 'admin', isGlobalAdmin: true } as const;
const asUser = (userId: string) => ({ userId, isGlobalAdmin: false });

maybe('pins per space against PostgreSQL', () => {
  const schema = `pins_it_${Math.random().toString(36).slice(2, 10)}`;
  let ds: DataSource;
  let service: SpacePinsService;
  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    ds.query(sql, params);
  const space = async (formation: string, campus: string): Promise<string> =>
    (
      await q<{ id: string }>(`SELECT id FROM spaces WHERE formation = $1 AND campus = $2`, [
        formation,
        campus,
      ])
    )[0].id;
  let icmSe: string;
  let isminSe: string;

  const pinnedFor = async (viewer: string): Promise<string[]> =>
    (await q<{ id: string }>(PINNED_FOR_VIEWER_IDS_SQL, [Object.values(P), viewer]))
      .map((r) => r.id)
      .sort();

  /** The refusal's typed `code`, or 'accepted'. */
  const outcome = async (act: Promise<unknown>): Promise<string> => {
    try {
      await act;
      return 'accepted';
    } catch (e: unknown) {
      const body = (e as { getResponse?: () => unknown }).getResponse?.();
      return (body as { code?: string } | undefined)?.code ?? `untyped: ${String(e)}`;
    }
  };

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      synchronize: false,
      extra: { options: `-c search_path=${schema},public`, max: 4 },
    });
    await ds.initialize();
    await q(`CREATE SCHEMA ${schema}`);
    await q(`
      CREATE TABLE users (id varchar(255) PRIMARY KEY, admin boolean NOT NULL DEFAULT false,
        campus varchar(32), cursus jsonb NOT NULL DEFAULT '[]');
      CREATE TABLE associations (id uuid PRIMARY KEY, name varchar NOT NULL,
        type varchar NOT NULL DEFAULT 'association', "isBDE" boolean NOT NULL DEFAULT false,
        archived boolean NOT NULL DEFAULT false);
      CREATE TABLE posts (id uuid PRIMARY KEY, "authorId" varchar(255) NOT NULL,
        "associationId" uuid, "studentsOnly" boolean NOT NULL DEFAULT false, anonymous boolean NOT NULL DEFAULT false,
        "hiddenByModeration" boolean NOT NULL DEFAULT false, "scheduledAt" timestamptz,
        kind varchar NOT NULL DEFAULT 'post', "expiresAt" timestamptz,
        pinned boolean NOT NULL DEFAULT false);
      CREATE TABLE association_members (id serial PRIMARY KEY, "associationId" uuid NOT NULL,
        "userId" varchar(255) NOT NULL, permissions int NOT NULL DEFAULT 0);
    `);
    for (const [key, id] of Object.entries(A)) {
      await q(`INSERT INTO associations (id, name, type) VALUES ($1, $2, $3)`, [
        id,
        key,
        key === 'inst' ? 'institution' : 'association',
      ]);
    }
    await q(migration('071_spaces.sql'));
    await q(migration('072_drop_is_bde.sql'));
    await q(migration('073_republications.sql'));
    await q(migration('078_read_grants.sql'));
    await q(migration('127_post_space_pins.sql'));
    // A replay is a no-op (the deploy ledger may run it twice).
    await q(migration('127_post_space_pins.sql'));
    await q(`DELETE FROM association_audiences`);
    const rules: [string, string | null, string | null][] = [
      [A.bdeIcm, 'ICM', 'saint-etienne'],
      [A.bdeIsmin, 'ISMIN', 'saint-etienne'],
      [A.club, 'ISMIN', 'saint-etienne'],
      [A.clubGa, null, 'gardanne'],
      [A.inst, null, 'saint-etienne'],
      [A.clubArch, 'ICM', 'saint-etienne'],
    ];
    for (const [asso, formation, campus] of rules) {
      await q(
        `INSERT INTO association_audiences ("associationId", formation, campus) VALUES ($1, $2, $3)`,
        [asso, formation, campus]
      );
    }
    icmSe = await space('ICM', 'saint-etienne');
    isminSe = await space('ISMIN', 'saint-etienne');
    await q(`UPDATE spaces SET "bdeAssociationId" = NULL`);
    await q(`UPDATE spaces SET "bdeAssociationId" = $1 WHERE id = $2`, [A.bdeIcm, icmSe]);
    await q(`UPDATE spaces SET "bdeAssociationId" = $1 WHERE id = $2`, [A.bdeIsmin, isminSe]);
    const members: [string, string, number][] = [
      ['icmMod', A.bdeIcm, MODERATE],
      ['icmVal', A.bdeIcm, VALIDATE_EVENTS], // another BDE flag: pins nothing
      ['isminMod', A.bdeIsmin, MODERATE],
    ];
    for (const [userId, asso, permissions] of members) {
      await q(
        `INSERT INTO association_members ("associationId", "userId", permissions) VALUES ($1, $2, $3)`,
        [asso, userId, permissions]
      );
    }
    for (const [id, [campus, formations]] of Object.entries(USERS)) {
      await q(`INSERT INTO users (id, campus, cursus, admin) VALUES ($1, $2, $3, $4)`, [
        id,
        campus,
        JSON.stringify(formations.map((formation) => ({ formation, promo: 2026 }))),
        id === 'admin',
      ]);
    }
    // One probe per space: a reader whose only door is that space.
    await q(`INSERT INTO users (id, campus, cursus)
      SELECT 'probe:' || s.formation || ':' || s.campus, s.campus,
             jsonb_build_array(jsonb_build_object('formation', s.formation, 'promo', 2026))
        FROM spaces s`);
    await q(
      `INSERT INTO read_grants (user_id, campus, formation, granted_by) VALUES
         ('staffSe', 'saint-etienne', NULL, 'admin'), ('staffGa', 'gardanne', NULL, 'admin')`
    );
    const posts: [string, string, string | null][] = [
      [P.club1, 'o', A.club],
      [P.club2, 'o', A.club],
      [P.club3, 'o', A.club],
      [P.club4, 'o', A.club],
      [P.club5, 'o', A.club],
      [P.inst, 'o', A.inst],
      [P.isminStudent, 'isminReader', null],
      [P.ga, 'o', A.clubGa],
      [P.gaOnly, 'o', A.clubGa],
      [P.scheduled, 'o', A.club],
    ];
    for (const [id, author, asso] of posts) {
      await q(`INSERT INTO posts (id, "authorId", "associationId") VALUES ($1, $2, $3)`, [
        id,
        author,
        asso,
      ]);
    }
    await q(`UPDATE posts SET "scheduledAt" = now() + interval '1 year' WHERE id = $1`, [
      P.scheduled,
    ]);
    await q(
      `INSERT INTO post_republications ("postId", "associationId", "republishedBy") VALUES ($1, $2, 'o')`,
      [P.ga, A.club]
    );
    // An archived carrier reaches nobody: its republication of `ga` opens no ICM space.
    await q(`UPDATE associations SET archived = true WHERE id = $1`, [A.clubArch]);
    await q(
      `INSERT INTO post_republications ("postId", "associationId", "republishedBy") VALUES ($1, $2, 'o')`,
      [P.ga, A.clubArch]
    );
    const redis = { deleteByPattern: jest.fn(() => Promise.resolve(0)) };
    service = new SpacePinsService(
      { manager: ds.manager } as unknown as Repository<Post>,
      redis as unknown as RedisService
    );
  });

  afterAll(async () => {
    if (ds?.isInitialized) {
      await q(`DROP SCHEMA ${schema} CASCADE`);
      await ds.destroy();
    }
  });

  beforeEach(async () => {
    await q(`DELETE FROM post_space_pins`);
    await q(`UPDATE posts SET "hiddenByModeration" = false`);
  });

  it('"visible in a space" is what a reader whose only door is that space sees', async () => {
    const rows = await q<{ post: string; space: string; reaches: boolean; sees: boolean }>(
      `SELECT p.id AS post, s.formation || ':' || s.campus AS space,
              ${postReachesSpaceSql('p', 's')} AS reaches,
              ${postVisibleToUserSql('p', 'probe', { followers: false })} AS sees
         FROM posts p CROSS JOIN spaces s
         JOIN users probe ON probe.id = 'probe:' || s.formation || ':' || s.campus`
    );
    expect(rows.length).toBe(Object.keys(P).length * 10);
    expect(rows.filter((r) => r.reaches !== r.sees)).toEqual([]);
    // And the cases the rule names, so an empty agreement cannot pass.
    const reaches = (post: string, sp: string) =>
      rows.find((r) => r.post === post && r.space === sp)?.reaches;
    expect(reaches(P.inst, 'ICM:saint-etienne')).toBe(true);
    expect(reaches(P.isminStudent, 'ISMIN:saint-etienne')).toBe(true);
    expect(reaches(P.isminStudent, 'ICM:saint-etienne')).toBe(false);
    expect(reaches(P.ga, 'ISMIN:saint-etienne')).toBe(true); // through club's republication
    expect(reaches(P.ga, 'ICM:saint-etienne')).toBe(false); // clubArch's: archived, reaches nobody
    expect(reaches(P.gaOnly, 'ISMIN:saint-etienne')).toBe(false);
  });

  it('pins only where the caller governs: its BDE MODERATE, or the platform admin', async () => {
    expect(await outcome(service.pin(P.inst, asUser('isminMod'), icmSe))).toBe(SPACE_PIN_FORBIDDEN);
    expect(await outcome(service.pin(P.inst, asUser('icmVal'), icmSe))).toBe(SPACE_PIN_FORBIDDEN);
    expect(await outcome(service.pin(P.inst, asUser('isminReader'), isminSe))).toBe(
      SPACE_PIN_FORBIDDEN
    );
    expect(await outcome(service.pin(P.inst, asUser('icmMod'), icmSe))).toBe('accepted');
    expect(await outcome(service.pin(P.inst, GRANT, isminSe))).toBe('accepted');
  });

  it('pins only a post visible in that space, and live there', async () => {
    expect(await outcome(service.pin(P.isminStudent, asUser('icmMod'), icmSe))).toBe(
      POST_NOT_IN_SPACE
    );
    expect(await outcome(service.pin(P.scheduled, asUser('isminMod'), isminSe))).toBe(
      POST_NOT_IN_SPACE
    );
    // A personal post and a republished one are pinnable where they are seen.
    expect(await outcome(service.pin(P.isminStudent, asUser('isminMod'), isminSe))).toBe(
      'accepted'
    );
    expect(await outcome(service.pin(P.ga, asUser('isminMod'), isminSe))).toBe('accepted');
  });

  it('two BDEs on one campus: an ISMIN pin is not on top for ICM readers', async () => {
    // An INSTITUTION's post, reached by both spaces: pinnable by the ISMIN BDE (G9 intact).
    await service.pin(P.inst, asUser('isminMod'), isminSe);
    expect(await pinnedFor('isminReader')).toEqual([P.inst]);
    expect(await pinnedFor('icmReader')).toEqual([]);
    await service.pin(P.inst, asUser('icmMod'), icmSe);
    expect(await pinnedFor('icmReader')).toEqual([P.inst]);
  });

  it('a campus-wide read grant is shown the campus pins; a grant on the other campus is not', async () => {
    await service.pin(P.inst, asUser('isminMod'), isminSe);
    expect(await pinnedFor('staffSe')).toEqual([P.inst]);
    expect(await pinnedFor('staffGa')).toEqual([]);
    expect(await pinnedFor('nobody-signed-in')).toEqual([]);
  });

  /**
   * A service whose pin transactions meet at a GATE just before reading the shown count: each waits
   * there until the other has arrived too - or is blocked waiting for an advisory lock (read from
   * `pg_locks`, never from a clock). Without the space lock both arrive, both read 2 and both insert;
   * with it the second is blocked before the gate, so the first goes on alone and commits first.
   */
  function gatedService(): SpacePinsService {
    let arrived = 0;
    const gate = async (): Promise<void> => {
      arrived += 1;
      for (;;) {
        if (arrived >= 2) return;
        const [{ blocked }] = await q<{ blocked: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted) AS blocked`
        );
        if (blocked) return;
        await new Promise((resolve) => setImmediate(resolve));
      }
    };
    const gated = (m: EntityManager) =>
      ({
        query: async (sql: string, params?: unknown[]) => {
          if (sql === PIN_STANDING_IN_SPACE_SQL) await gate();
          return m.query(sql, params);
        },
      }) as unknown as EntityManager;
    const manager = {
      query: (sql: string, params?: unknown[]) => ds.manager.query(sql, params),
      transaction: <T>(fn: (m: EntityManager) => Promise<T>) =>
        ds.manager.transaction((m) => fn(gated(m))),
    };
    return new SpacePinsService(
      { manager } as unknown as Repository<Post>,
      {
        deleteByPattern: () => Promise.resolve(0),
      } as unknown as RedisService
    );
  }

  it('refuses a 4th pin, and two concurrent pins at 2 of 3 leave exactly 3', async () => {
    const mod = asUser('isminMod');
    await service.pin(P.club1, mod, isminSe);
    await service.pin(P.club2, mod, isminSe);
    const racer = gatedService();
    const raced = await Promise.all([
      outcome(racer.pin(P.club3, mod, isminSe)),
      outcome(racer.pin(P.club4, mod, isminSe)),
    ]);
    expect(raced.sort()).toEqual(['accepted', SPACE_PIN_LIMIT_CODE].sort());
    expect(await service.listForSpace(isminSe, mod)).toHaveLength(3);
    expect(await outcome(service.pin(P.club5, mod, isminSe))).toBe(SPACE_PIN_LIMIT_CODE);
    // Pinning one already shown is answered as done.
    expect(await outcome(service.pin(P.club1, mod, isminSe))).toBe('accepted');
  });

  it('a returning hidden pin never makes four shown: it waits, and an unpin promotes it', async () => {
    const mod = asUser('isminMod');
    for (const post of [P.club1, P.club2, P.club3]) await service.pin(post, mod, isminSe);
    await q(`UPDATE post_space_pins SET pinned_at = now() - interval '3 days' WHERE post_id = $1`, [
      P.club1,
    ]);
    await q(`UPDATE posts SET "hiddenByModeration" = true WHERE id = $1`, [P.club1]);
    // Hidden: kept, not shown, not counted - so a new one fits.
    expect(await outcome(service.pin(P.club4, mod, isminSe))).toBe('accepted');
    await q(`UPDATE posts SET "hiddenByModeration" = false WHERE id = $1`, [P.club1]);

    expect(await pinnedFor('isminReader')).toEqual([P.club2, P.club3, P.club4].sort());
    const list = await service.listForSpace(isminSe, mod);
    expect(list.map((e) => [e.postId, e.state])).toEqual([
      [P.club4, 'shown'],
      [P.club3, 'shown'],
      [P.club2, 'shown'],
      [P.club1, 'pending'],
    ]);
    expect((await service.pinSpacesFor([P.club1], mod)).get(P.club1)).toEqual([
      { spaceId: isminSe, formation: 'ISMIN', campus: 'saint-etienne', state: 'pending' },
    ]);
    // The cap counts the SHOWN pins: still refused, "en attente" or not.
    expect(await outcome(service.pin(P.club5, mod, isminSe))).toBe(SPACE_PIN_LIMIT_CODE);

    await service.unpin(P.club3, mod, isminSe);
    expect(await pinnedFor('isminReader')).toEqual([P.club1, P.club2, P.club4].sort());
  });

  it('authorises before it looks: an unauthorised caller is told 403 whether or not the post exists', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    for (const act of ['pin', 'unpin'] as const) {
      const run = (post: string, who: PinActor, space: string) =>
        outcome(service[act](post, who, space));
      // Named space the caller does not govern: the same 403 for a real post and a missing one.
      expect(await run(P.inst, asUser('icmMod'), isminSe)).toBe(SPACE_PIN_FORBIDDEN);
      expect(await run(missing, asUser('icmMod'), isminSe)).toBe(SPACE_PIN_FORBIDDEN);
      // A missing space is no more telling than a foreign one - only the admin hears 404.
      expect(await run(P.inst, asUser('icmMod'), missing)).toBe(SPACE_PIN_FORBIDDEN);
      expect(await run(P.inst, GRANT, missing)).toBe(SPACE_NOT_FOUND);
      // Authorised, the missing post is a typed 404.
      expect(await run(missing, asUser('isminMod'), isminSe)).toBe(POST_NOT_FOUND);
    }
  });

  it('migration 128 moves the global pin to every governed space where the post is visible, and names every pin it does not carry', async () => {
    const client = new Client({ connectionString: URL });
    await client.connect();
    const notices: string[] = [];
    client.on('notice', (n) => notices.push(n.message ?? ''));
    try {
      await client.query(`SET search_path TO ${schema}, public`);
      await client.query(`UPDATE posts SET pinned = (id = ANY($1::uuid[]))`, [
        [P.inst, P.gaOnly, P.scheduled],
      ]);
      // ICM x saint-etienne is full before the run: the institution's post has no room there.
      await client.query(
        `INSERT INTO post_space_pins (post_id, space_id, pinned_by)
         SELECT unnest($1::uuid[]), $2::uuid, 'fixture'`,
        [[P.club1, P.club2, P.club3], icmSe]
      );
      await client.query(migration('128_move_global_pin_to_spaces.sql'));
      // A replay writes nothing more.
      await client.query(migration('128_move_global_pin_to_spaces.sql'));
      const rows = (
        await client.query<{ post_id: string; space_id: string; pinned_by: string }>(
          `SELECT post_id, space_id, pinned_by FROM post_space_pins
            WHERE pinned_by = 'migration:128' ORDER BY space_id`
        )
      ).rows;
      expect(rows.map((r) => `${r.post_id} in ${r.space_id}`)).toEqual([`${P.inst} in ${isminSe}`]);
      // The full space is named with the post it could not take (once per run: two runs, two).
      expect(notices.filter((n) => n.includes(P.inst) && n.includes(icmSe))).toHaveLength(2);
      expect(notices.filter((n) => n.includes(P.inst) && !n.includes(icmSe))).toEqual([]);
      // Visible in no governed space, and not live at run time: each named, pinned nowhere.
      expect(notices.some((n) => n.includes(P.gaOnly))).toBe(true);
      expect(notices.some((n) => n.includes(P.scheduled))).toBe(true);
    } finally {
      await client.query(`UPDATE posts SET pinned = false`);
      await client.query(`DELETE FROM post_space_pins`);
      await client.end();
    }
  });
});
