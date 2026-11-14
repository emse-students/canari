/**
 * "CARTE DE LA VIE ASSO" PER SPACE (owner, 2026-11-08), AGAINST A REAL POSTGRESQL.
 *
 * What a mock cannot prove: that migration 147 attaches, zones and switches a seeded schema as its
 * header says (and leaves an ambiguous live map offline), that its partial unique index allows one
 * live map PER SPACE and its CHECK none without a space, that a BDE manager never reaches another
 * BDE's map, and that the showcase's legacy no-space read answers only while one map is live.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; locally, against a throwaway
 * PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- poster.integration
 *
 * Each block builds its own throwaway schema - the tables the migration reads, shaped as production
 * has them, then migrations 021, 022, 035 and 064 as written - and drops it at the end.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpException, Logger, NotFoundException } from '@nestjs/common';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { PosterService } from './poster.service';
import { CARTE_SPACE_ASSOCIATIONS_SQL } from './poster-scope';
import { OFFERED_BY_SPACE_KEY_SQL } from '../spaces/public-space';
import { PosterProject } from './entities/poster-project.entity';
import { PosterZone } from './entities/poster-zone.entity';
import { PosterEntry } from './entities/poster-entry.entity';
import { AssociationPermissionFlag } from './entities/association-member.entity';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const MIGRATIONS = join(__dirname, '..', 'migrations');
const sql = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');
const MIGRATION_147 = sql('147_poster_spaces_and_zones.sql');

const { MANAGE_ASSO } = AssociationPermissionFlag;

/** The ids every block shares, so the assertions read as the scenario. */
const ID = {
  bde: randomUUID(), // slug `bde`: governs ICM and ISMIN at Saint-Etienne
  fsss: randomUUID(), // governs FSSS at Saint-Etienne
  a1: randomUUID(), // every Saint-Etienne space, category c1
  a2: randomUUID(), // every Saint-Etienne space, no category, a per-bubble override to c2
  a3: randomUUID(), // FSSS only, category c2: on the live map, outside its space
  a4: randomUUID(), // every Saint-Etienne space, never placed: offered as new
  archived: randomUUID(), // every Saint-Etienne space, archived: never offered
  c1: randomUUID(),
  c2: randomUUID(),
  c3: randomUUID(),
  icm: randomUUID(),
  ismin: randomUUID(),
  fsssSpace: randomUUID(),
  icmGardanne: randomUUID(),
  live: randomUUID(), // the live map
  fsssMap: randomUUID(), // drawn by the FSSS BDE's manager: one space, attached
  bdeDraft: randomUUID(), // drawn by the `bde` manager: two spaces, left unattached
};

/** The smallest document `sanitizePublishedCarte` accepts, one unit per association. */
function carte(assoIds: string[]) {
  return {
    aspectRatio: Math.SQRT2,
    stage: { w: 1600, h: 1131 },
    background: { dataUrl: null, scrimOpacity: 20 },
    style: {
      pageBg: '#fdf3e3',
      scrimColor: '#3a2a12',
      cardBg: '#ffffff',
      cardTextColor: '#374151',
      directoryBg: '#ffffff',
      directoryTextColor: '#1f2937',
      directoryMutedColor: '#6b7280',
    },
    title: {
      x: 48,
      y: 36,
      w: 1004,
      z: 0,
      size: 52,
      weight: 700,
      content: 'Carte',
      align: 'left',
      color: '#7c2d12',
    },
    units: assoIds.map((assoId, i) => ({
      assoId,
      x: 120 + i * 10,
      y: 90,
      w: 400,
      h: 430,
      scale: 0.5,
      z: 1,
      color: null,
      colorFallback: '#7c2d12',
      blob: { x: 95, y: 67, size: 210, radius: '50%' },
      logo: { x: 154, y: 88, w: 92, h: 92, radius: '12px', initialsSize: 36, initials: 'A' },
      name: { x: 123, y: 184, w: 154, size: 17, emailSize: 6 },
      cards: [],
    })),
    texts: [],
    directory: null,
  };
}
const FP = 'b'.repeat(64);

/**
 * A schema as production has it before 147: spaces, associations, audiences, members, the global
 * categories and the poster table of 022/035/064. `icmGardanne` makes the `bde` association govern
 * a SECOND ICM space, which is the ambiguous case.
 */
async function seed(db: Client, opts: { icmGardanne: boolean }): Promise<void> {
  await db.query(`CREATE TABLE associations (
    id uuid PRIMARY KEY, name varchar NOT NULL DEFAULT 'x', slug varchar UNIQUE,
    type varchar NOT NULL DEFAULT 'association', archived boolean NOT NULL DEFAULT false)`);
  await db.query(`CREATE TABLE spaces (
    id uuid PRIMARY KEY, formation varchar(16) NOT NULL, campus varchar(32) NOT NULL,
    "bdeAssociationId" uuid, UNIQUE (formation, campus))`);
  await db.query(`CREATE TABLE association_audiences (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "associationId" uuid NOT NULL,
    formation varchar(16), campus varchar(32))`);
  await db.query(`CREATE TABLE association_members (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "associationId" uuid NOT NULL,
    "userId" varchar(255) NOT NULL, role varchar NOT NULL DEFAULT 'Membre',
    permissions integer NOT NULL DEFAULT 0)`);
  for (const file of [
    '021_association_categories.sql',
    '022_poster_projects.sql',
    '035_poster_publication.sql',
    '064_poster_publication_fingerprint.sql',
  ]) {
    await db.query(sql(file));
  }
  await db.query(
    `INSERT INTO associations (id, slug, type) VALUES ($1, 'bde', 'association'), ($2, 'bde-fsss', 'association')`,
    [ID.bde, ID.fsss]
  );
  await db.query(
    `INSERT INTO spaces (id, formation, campus, "bdeAssociationId") VALUES
      ($1, 'ICM', 'saint-etienne', $4), ($2, 'ISMIN', 'saint-etienne', $4), ($3, 'FSSS', 'saint-etienne', $5)`,
    [ID.icm, ID.ismin, ID.fsssSpace, ID.bde, ID.fsss]
  );
  if (opts.icmGardanne) {
    await db.query(
      `INSERT INTO spaces (id, formation, campus, "bdeAssociationId") VALUES ($1, 'ICM', 'gardanne', $2)`,
      [ID.icmGardanne, ID.bde]
    );
  }
  await db.query(
    `INSERT INTO association_categories (id, label, slug, "sortOrder") VALUES
      ($1, 'Culture', 'culture', 0), ($2, 'Sport', 'sport', 1), ($3, 'Cuisine', 'cuisine', 2)`,
    [ID.c1, ID.c2, ID.c3]
  );
  await db.query(
    `INSERT INTO associations (id, slug, "categoryId", archived) VALUES
      ($1, 'a1', $6, false), ($2, 'a2', NULL, false), ($3, 'a3', $7, false),
      ($4, 'a4', NULL, false), ($5, 'archived', NULL, true)`,
    [ID.a1, ID.a2, ID.a3, ID.a4, ID.archived, ID.c1, ID.c2]
  );
  await db.query(
    `INSERT INTO association_audiences ("associationId", formation, campus) VALUES
      ($1, NULL, 'saint-etienne'), ($2, NULL, 'saint-etienne'), ($3, 'FSSS', 'saint-etienne'),
      ($4, NULL, 'saint-etienne'), ($5, NULL, 'saint-etienne')`,
    [ID.a1, ID.a2, ID.a3, ID.a4, ID.archived]
  );
  await db.query(
    `INSERT INTO association_members ("associationId", "userId", permissions) VALUES
      ($1, 'bde-manager', $3), ($2, 'fsss-manager', $3), ($1, 'bde-plain-member', 0)`,
    [ID.bde, ID.fsss, MANAGE_ASSO]
  );
  const layout = (ids: string[], override?: [string, string]) =>
    JSON.stringify({
      bubbles: ids.map((assoId) =>
        override && override[0] === assoId ? { assoId, categoryOverride: override[1] } : { assoId }
      ),
    });
  await db.query(
    `INSERT INTO poster_projects (id, name, layout, "createdBy", publication, "publishedAt", "publicationFingerprint") VALUES
      ($1, 'Carte live', $2::jsonb, 'bde-manager', $7::jsonb, now(), $5),
      ($3, 'Carte FSSS', $4::jsonb, 'fsss-manager', NULL, NULL, NULL),
      ($6, 'Brouillon', '{}'::jsonb, 'bde-manager', NULL, NULL, NULL)`,
    [
      ID.live,
      layout([ID.a1, ID.a2, ID.a3], [ID.a2, 'sport']),
      ID.fsssMap,
      layout([ID.a3]),
      FP,
      ID.bdeDraft,
      // The document that is live: a1 (switched ON by 147), a3 (FSSS only, switched OFF) and a4 (of
      // the space but never placed, so NO switch), as units and directory lines; one zone holds
      // only a3, one only a4.
      JSON.stringify({
        units: [
          { assoId: ID.a1, x: 1 },
          { assoId: ID.a3, x: 2 },
          { assoId: ID.a4, x: 3 },
        ],
        directory: {
          heading: 'Annuaire',
          zones: [
            { label: 'Culture', assos: [{ assoId: ID.a1, line: 'A' }] },
            {
              label: 'Sport',
              assos: [
                { assoId: ID.a3, line: 'C' },
                { assoId: ID.a2, line: 'B' },
              ],
            },
            { label: 'Cuisine', assos: [{ assoId: ID.a3, line: 'C' }] },
            { label: 'Nouvelles', assos: [{ assoId: ID.a4, line: 'D' }] },
            { label: 'Fin', assos: [{ assoId: ID.a1, line: 'A2' }] },
          ],
        },
      }),
    ]
  );
}

/** A fresh schema, seeded, with its own connection pinned to it. */
async function freshSchema(prefix: string, opts: { icmGardanne: boolean }) {
  const schema = `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
  const db = new Client({ connectionString: URL });
  await db.connect();
  await db.query(`CREATE SCHEMA ${schema}`);
  await db.query(`SET search_path TO ${schema}`);
  await seed(db, opts);
  return { schema, db };
}

/** The HTTP refusal's typed code, or the error itself. */
const refusal = (p: Promise<unknown>) =>
  p.then(
    () => 'written',
    (e: unknown) =>
      e instanceof NotFoundException
        ? 404
        : ((e instanceof HttpException
            ? (e.getResponse() as { code?: unknown }).code
            : undefined) ?? e)
  );

maybe('migration 147 on a seeded schema (the map is attachable)', () => {
  let db: Client;
  let schema: string;

  beforeAll(async () => {
    for (const level of ['log', 'warn', 'debug'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
    ({ db, schema } = await freshSchema('carte147_it', { icmGardanne: false }));
    await db.query(MIGRATION_147);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db.end();
  });

  const spaceOf = async (id: string) =>
    (
      await db.query(
        `SELECT "spaceId", publication IS NOT NULL AS live FROM poster_projects WHERE id = $1`,
        [id]
      )
    ).rows[0];

  it('keeps the live map live, attached to the ICM space of the `bde` association', async () => {
    await expect(spaceOf(ID.live)).resolves.toEqual({ spaceId: ID.icm, live: true });
  });

  it('keeps in the LIVE document only what is switched ON, drops an emptied zone, and nothing else', async () => {
    const { rows } = await db.query(
      `SELECT publication, "publicationFingerprint" AS fp FROM poster_projects WHERE id = $1`,
      [ID.live]
    );
    expect(rows[0].publication).toEqual({
      units: [{ assoId: ID.a1, x: 1 }],
      directory: {
        heading: 'Annuaire',
        zones: [
          { label: 'Culture', assos: [{ assoId: ID.a1, line: 'A' }] },
          { label: 'Sport', assos: [{ assoId: ID.a2, line: 'B' }] },
          // 'Cuisine' (only OFF) and 'Nouvelles' (only no-switch) are gone; the order holds.
          { label: 'Fin', assos: [{ assoId: ID.a1, line: 'A2' }] },
        ],
      },
    });
    // The fingerprint described the document before; it is unknown now, never a false match.
    expect(rows[0].fp).toBeNull();
  });

  it("attaches another map to the one space its creator manages, and leaves a two-space creator's map unattached", async () => {
    await expect(spaceOf(ID.fsssMap)).resolves.toEqual({ spaceId: ID.fsssSpace, live: false });
    await expect(spaceOf(ID.bdeDraft)).resolves.toEqual({ spaceId: null, live: false });
  });

  it('copies every platform category into every map as its own zone, in order', async () => {
    const { rows } = await db.query(
      `SELECT "posterProjectId" AS p, label, "sortOrder" AS o FROM poster_zones ORDER BY "posterProjectId", "sortOrder"`
    );
    expect(rows.filter((r) => r.p === ID.live).map((r) => r.label)).toEqual([
      'Culture',
      'Sport',
      'Cuisine',
    ]);
    expect(rows).toHaveLength(9);
  });

  it('switches every placed association: ON in the space, OFF outside it, zoned by its override or its category', async () => {
    const { rows } = await db.query(
      `SELECT e."associationId" AS a, e.enabled, z.label
       FROM poster_entries e LEFT JOIN poster_zones z ON z.id = e."zoneId"
       WHERE e."posterProjectId" = $1`,
      [ID.live]
    );
    const byAsso = Object.fromEntries(rows.map((r) => [r.a, { on: r.enabled, zone: r.label }]));
    expect(byAsso).toEqual({
      [ID.a1]: { on: true, zone: 'Culture' },
      [ID.a2]: { on: true, zone: 'Sport' }, // the per-bubble override wins over "no category"
      [ID.a3]: { on: false, zone: 'Sport' }, // of FSSS only: switched off, never deleted
    });
    // a4 is of the space and was never placed: no row, so the editor offers it as new.
  });

  it('is idempotent: a second run writes nothing', async () => {
    const count = async () =>
      (
        await db.query(
          `SELECT (SELECT count(*) FROM poster_zones) AS z, (SELECT count(*) FROM poster_entries) AS e,
                  (SELECT count(*) FILTER (WHERE "spaceId" IS NOT NULL) FROM poster_projects) AS s`
        )
      ).rows[0];
    const live = async () =>
      (await db.query(`SELECT publication FROM poster_projects WHERE id = $1`, [ID.live])).rows[0];
    const before = await count();
    const liveBefore = await live();
    await db.query(MIGRATION_147);
    await expect(count()).resolves.toEqual(before);
    await expect(live()).resolves.toEqual(liveBefore);
  });
  it('allows one live map per space, and none without a space', async () => {
    await db.query(
      `INSERT INTO poster_projects (id, name, "createdBy", "spaceId") VALUES ($1, 'x', 'u', $2)`,
      [randomUUID(), ID.icm]
    );
    await expect(
      db.query(
        `INSERT INTO poster_projects (id, name, "createdBy", "spaceId", publication, "publishedAt") VALUES ($1, 'x', 'u', $2, '{}'::jsonb, now())`,
        [randomUUID(), ID.icm]
      )
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      db.query(
        `INSERT INTO poster_projects (id, name, "createdBy", publication, "publishedAt") VALUES ($1, 'x', 'u', '{}'::jsonb, now())`,
        [randomUUID()]
      )
    ).rejects.toMatchObject({ code: '23514' });
    // Another space may have its own live map.
    await db.query(
      `INSERT INTO poster_projects (id, name, "createdBy", "spaceId", publication, "publishedAt") VALUES ($1, 'x', 'u', $2, '{}'::jsonb, now())`,
      [randomUUID(), ID.ismin]
    );
    const { rows } = await db.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'poster_projects'`,
      [schema]
    );
    const names = rows.map((r) => r.indexname);
    expect(names).toContain('idx_poster_projects_live_per_space');
    expect(names).not.toContain('idx_poster_projects_single_publication');
  });
});

maybe('migration 147 on a seeded schema (the live map is ambiguous)', () => {
  let db: Client;
  let schema: string;

  beforeAll(async () => {
    ({ db, schema } = await freshSchema('carte147_amb_it', { icmGardanne: true }));
    await db.query(MIGRATION_147);
  });

  afterAll(async () => {
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db.end();
  });

  it('attaches nothing and takes the live map offline when the `bde` association governs two ICM spaces', async () => {
    const { rows } = await db.query(
      `SELECT "spaceId", publication, "publishedAt", "publicationFingerprint" FROM poster_projects WHERE id = $1`,
      [ID.live]
    );
    expect(rows[0]).toEqual({
      spaceId: null,
      publication: null,
      publishedAt: null,
      publicationFingerprint: null,
    });
    // No space, so no switches: the platform admin attaches it from the editor.
    const { rows: entries } = await db.query(
      `SELECT count(*)::int AS n FROM poster_entries WHERE "posterProjectId" = $1`,
      [ID.live]
    );
    expect(entries[0].n).toBe(0);
  });
});

maybe('PosterService on the migrated schema (scope, publication, legacy read)', () => {
  let db: Client;
  let schema: string;
  let ds: DataSource;
  let service: PosterService;
  const ADMIN = { userId: 'platform-admin', isGlobalAdmin: true };
  const BDE = { userId: 'bde-manager', isGlobalAdmin: false };
  const FSSS = { userId: 'fsss-manager', isGlobalAdmin: false };
  const PLAIN = { userId: 'bde-plain-member', isGlobalAdmin: false };

  beforeAll(async () => {
    for (const level of ['log', 'warn', 'debug'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
    ({ db, schema } = await freshSchema('carte_svc_it', { icmGardanne: false }));
    await db.query(MIGRATION_147);
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [PosterProject, PosterZone, PosterEntry],
      synchronize: false,
      extra: { options: `-c search_path=${schema}` },
    });
    await ds.initialize();
    service = new PosterService(
      ds.getRepository(PosterProject),
      ds.getRepository(PosterZone),
      ds.getRepository(PosterEntry)
    );
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    if (ds?.isInitialized) await ds.destroy();
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db.end();
  });

  it("the directory's space filter and the carte share ONE definition: the carte's ids are the directory's living ones", async () => {
    const carte = (await db.query(CARTE_SPACE_ASSOCIATIONS_SQL, [ID.icm])).rows.map((r) => r.id);
    const directory = (await db.query(OFFERED_BY_SPACE_KEY_SQL, ['ICM', 'saint-etienne'])).rows.map(
      (r) => r.id
    );
    const { rows } = await db.query(`SELECT id FROM associations WHERE archived`);
    const archived = new Set(rows.map((r) => r.id));
    expect(directory.filter((id: string) => !archived.has(id))).toEqual(carte);
    expect(carte.length).toBeGreaterThan(0);
    // a3 addresses FSSS only: not of ICM, in either.
    expect(directory).not.toContain(ID.a3);
  });

  it('lists an archived association of the space in the directory, never in the carte, and not an archived one of another space', async () => {
    const offSpace = randomUUID();
    await db.query(
      `INSERT INTO associations (id, slug, archived) VALUES ($1, 'archived-fsss', true)`,
      [offSpace]
    );
    await db.query(
      `INSERT INTO association_audiences ("associationId", formation, campus) VALUES ($1, 'FSSS', 'saint-etienne')`,
      [offSpace]
    );
    const directory = (await db.query(OFFERED_BY_SPACE_KEY_SQL, ['ICM', 'saint-etienne'])).rows.map(
      (r) => r.id
    );
    const carte = (await db.query(CARTE_SPACE_ASSOCIATIONS_SQL, [ID.icm])).rows.map((r) => r.id);
    expect(directory).toContain(ID.archived); // archived, audience reaching saint-etienne
    // A LIST follows the same rule since 2026-11-14: of the directory when its audience reaches the
    // space, of no other space's, and never of the carte (type `association` only).
    const list = randomUUID();
    await db.query(`INSERT INTO associations (id, slug, type) VALUES ($1, 'liste-icm', 'list')`, [
      list,
    ]);
    await db.query(
      `INSERT INTO association_audiences ("associationId", formation, campus) VALUES ($1, 'ICM', 'saint-etienne')`,
      [list]
    );
    const idsOf = async (sql: string, params: unknown[]) =>
      (await db.query(sql, params)).rows.map((r) => r.id);
    expect(await idsOf(OFFERED_BY_SPACE_KEY_SQL, ['ICM', 'saint-etienne'])).toContain(list);
    expect(await idsOf(OFFERED_BY_SPACE_KEY_SQL, ['FSSS', 'saint-etienne'])).not.toContain(list);
    expect(await idsOf(CARTE_SPACE_ASSOCIATIONS_SQL, [ID.icm])).not.toContain(list);
    await db.query(`DELETE FROM association_audiences WHERE "associationId" = $1`, [list]);
    await db.query(`DELETE FROM associations WHERE id = $1`, [list]);
    expect(carte).not.toContain(ID.archived);
    expect(directory).not.toContain(offSpace);
    await db.query(`DELETE FROM association_audiences WHERE "associationId" = $1`, [offSpace]);
    await db.query(`DELETE FROM associations WHERE id = $1`, [offSpace]);
  });

  it('lists to each manager only the maps of the spaces its BDE governs', async () => {
    expect((await service.list(BDE)).map((p) => p.id)).toEqual([ID.live]);
    expect((await service.list(FSSS)).map((p) => p.id)).toEqual([ID.fsssMap]);
    expect(await service.list(PLAIN)).toEqual([]);
    expect((await service.list(ADMIN)).map((p) => p.id).sort()).toEqual(
      [ID.live, ID.fsssMap, ID.bdeDraft].sort()
    );
    expect((await service.listSpaces(BDE)).map((s) => s.id).sort()).toEqual(
      [ID.icm, ID.ismin].sort()
    );
  });

  it("refuses a manager every route of another BDE's map with a 404, and writes nothing", async () => {
    await expect(refusal(service.detail(ID.live, FSSS))).resolves.toBe(404);
    await expect(refusal(service.update(ID.live, { name: 'pris' }, FSSS))).resolves.toBe(404);
    await expect(
      refusal(service.publish(ID.live, { carte: carte([ID.a1]), fingerprint: FP }, FSSS))
    ).resolves.toBe(404);
    await expect(refusal(service.unpublish(ID.live, FSSS))).resolves.toBe(404);
    await expect(refusal(service.createZone(ID.live, 'Z', FSSS))).resolves.toBe(404);
    await expect(
      refusal(service.setEntries(ID.live, [{ associationId: ID.a1, enabled: false }], FSSS))
    ).resolves.toBe(404);
    await expect(refusal(service.remove(ID.live, FSSS))).resolves.toBe(404);
    // An unattached map is the platform admin's alone, even to the BDE that drew it.
    await expect(refusal(service.detail(ID.bdeDraft, BDE))).resolves.toBe(404);
    // Creating in a space one does not manage: the same 404.
    await expect(refusal(service.create({ name: 'x', spaceId: ID.icm }, FSSS))).resolves.toBe(404);
    const { rows } = await db.query(
      `SELECT name, publication IS NOT NULL AS live FROM poster_projects WHERE id = $1`,
      [ID.live]
    );
    expect(rows[0]).toEqual({ name: 'Carte live', live: true });
  });

  it('offers a new association of the space with no switch, and keeps it off the live map until switched on', async () => {
    const detail = await service.detail(ID.live, BDE);
    const seen = new Set(detail.entries.map((e) => e.associationId));
    expect(detail.spaceAssociationIds.filter((a) => !seen.has(a))).toEqual([ID.a4]);
    expect(detail.spaceAssociationIds).not.toContain(ID.archived);
    await expect(
      refusal(service.publish(ID.live, { carte: carte([ID.a1, ID.a4]), fingerprint: FP }, BDE))
    ).resolves.toBe('CARTE_UNIT_OUTSIDE_MAP');
    await expect(
      refusal(service.setEntries(ID.live, [{ associationId: ID.a3, enabled: true }], BDE))
    ).resolves.toBe('CARTE_ASSOCIATION_OUTSIDE_SPACE');
    await service.setEntries(ID.live, [{ associationId: ID.a4, enabled: true }], BDE);
    await expect(
      refusal(service.publish(ID.live, { carte: carte([ID.a1, ID.a4]), fingerprint: FP }, BDE))
    ).resolves.toBe('written');
  });

  it("publishing replaces only the same space's live map", async () => {
    // The FSSS map goes live beside the ICM one.
    await service.setEntries(ID.fsssMap, [{ associationId: ID.a3, enabled: true }], FSSS);
    await service.publish(ID.fsssMap, { carte: carte([ID.a3]), fingerprint: FP }, FSSS);
    // A second ICM map replaces the first one, and only that one.
    const second = await service.create({ name: 'Carte 2027', spaceId: ID.icm }, BDE);
    await service.publish(second.id, { carte: carte([ID.a1]), fingerprint: FP }, BDE);
    const { rows } = await db.query(
      `SELECT id FROM poster_projects WHERE publication IS NOT NULL ORDER BY id`
    );
    expect(rows.map((r) => r.id).sort()).toEqual([ID.fsssMap, second.id].sort());
    const icm = await service.getPublished({ formation: 'ICM', campus: 'saint-etienne' });
    expect(icm?.name).toBe('Carte 2027');
    await expect(
      service.getPublished({ formation: 'ISMIN', campus: 'saint-etienne' })
    ).resolves.toBeNull();
  });

  it('serialises two publishes in one space: both succeed, one map is live', async () => {
    const one = await service.create({ name: 'Concurrente A', spaceId: ID.icm }, BDE);
    const two = await service.create({ name: 'Concurrente B', spaceId: ID.icm }, BDE);
    // Started together, on two pooled connections: without the space lock the later of the two
    // inserts hits the per-space unique index (a 500); with it, the later one replaces the earlier.
    await expect(
      Promise.all([
        refusal(service.publish(one.id, { carte: carte([ID.a1]), fingerprint: FP }, BDE)),
        refusal(service.publish(two.id, { carte: carte([ID.a1]), fingerprint: FP }, BDE)),
      ])
    ).resolves.toEqual(['written', 'written']);
    const { rows } = await db.query(
      `SELECT id FROM poster_projects WHERE publication IS NOT NULL AND "spaceId" = $1`,
      [ID.icm]
    );
    expect(rows).toHaveLength(1);
    expect([one.id, two.id]).toContain(rows[0].id);
    // Back to the state the next test expects: 'Carte 2027' is the ICM live map.
    await service.remove(one.id, BDE);
    await service.remove(two.id, BDE);
    const again = (await service.list(BDE)).find((p) => p.name === 'Carte 2027');
    await service.publish(again!.id, { carte: carte([ID.a1]), fingerprint: FP }, BDE);
  });

  it('[LEGACY] serves the no-space read only while exactly one map is live', async () => {
    // Two maps are live from the test above: no guess.
    await expect(service.getSoleLegacyPublished()).resolves.toBeNull();
    await service.unpublish(ID.fsssMap, FSSS);
    await expect(service.getSoleLegacyPublished()).resolves.toMatchObject({ name: 'Carte 2027' });
  });

  it('attaches an unattached map once, seeding ON what its layout placed, and never moves it again', async () => {
    await db.query(`UPDATE poster_projects SET layout = $2::jsonb WHERE id = $1`, [
      ID.bdeDraft,
      JSON.stringify({ bubbles: [{ assoId: ID.a1 }] }),
    ]);
    await service.update(ID.bdeDraft, { spaceId: ID.ismin }, ADMIN);
    const detail = await service.detail(ID.bdeDraft, BDE);
    expect(detail.entries.map((e) => [e.associationId, e.enabled])).toEqual([[ID.a1, true]]);
    await expect(refusal(service.update(ID.bdeDraft, { spaceId: ID.icm }, ADMIN))).resolves.toBe(
      'CARTE_ALREADY_ATTACHED'
    );
  });
});
