/**
 * THE PLATFORM ADMIN'S CREATE AND CATALOGUE (`/admin/spaces`, owner 2026-11-02), AGAINST A REAL
 * POSTGRESQL.
 *
 * What a mock cannot prove: that a placement's rules and its first admin land in the SAME
 * transaction as the row (a refused first admin leaves no row), that the derived slug walks to `-2`
 * through the unique index exactly as `POST /associations` does, that the slug preview names the
 * slug the create then takes, and that the keyset page `(name, id) > cursor` neither skips nor
 * repeats a row when names tie.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; locally, against a throwaway
 * PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- admin-create.integration
 *
 * Everything happens in a throwaway schema, dropped at the end. The `users` table is a three-column
 * stand-in, which is all the create reads of it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { Client } from 'pg';
import { DataSource, Repository } from 'typeorm';
import { AssociationsService } from './associations.service';
import { Association } from './entities/association.entity';
import { AssociationProduct } from './entities/association-product.entity';
import { AssociationMember, AssociationPermissionFlag } from './entities/association-member.entity';
import { AssociationAudience } from '../spaces/association-audience.entity';
import { Space } from '../spaces/space.entity';
import { ADMIN_ASSOCIATION_ERROR } from './admin-catalogue';
import { AUDIENCE_ERROR } from '../spaces/audience-policy';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

/** The admin preset the client sends for an association (`adminPresetFor('association')`). */
const ADMIN_PRESET =
  AssociationPermissionFlag.POST_AS_ASSO |
  AssociationPermissionFlag.PROPOSE_EVENT |
  AssociationPermissionFlag.MANAGE_MEMBERS;

/** The granter of a member write the platform admin makes from the roster editor. */
const PLATFORM_ADMIN = { userId: 'platform-admin', isGlobalAdmin: true };

maybe('platform admin create and catalogue against PostgreSQL', () => {
  const schema = `admin_create_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let service: AssociationsService;
  let assos: Repository<Association>;
  let members: Repository<AssociationMember>;
  let audiences: Repository<AssociationAudience>;
  let warnSpy: jest.SpyInstance;

  /** The platform admin has NO campus: the explicit placement must not need one. */
  const adminCreate = (
    name: string,
    opts: {
      type?: 'association' | 'list' | 'institution';
      audiences?: { formation: null; campus: 'saint-etienne' | 'gardanne' | null }[];
      firstAdmin?: { userId: string; permissions: number };
    } = {}
  ) =>
    service.create({ name, type: opts.type ?? 'association' } as never, 'platform-admin', true, {
      audiences: opts.audiences ?? [],
      firstAdmin: opts.firstAdmin,
    });

  beforeAll(async () => {
    for (const level of ['log', 'debug', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [Association, AssociationAudience, AssociationProduct, AssociationMember, Space],
      synchronize: false,
      uuidExtension: 'pgcrypto',
      installExtensions: false,
      extra: { options: `-c search_path=${schema}` },
    });
    await ds.initialize();
    await ds.synchronize();
    // The dependency journal (WP-D1) is a migration-only table: a create under a parent writes it.
    await ds.query(
      readFileSync(join(__dirname, '..', 'migrations', '129_dependencies_schema.sql'), 'utf8')
    );
    await ds.query(`CREATE TABLE users (id text PRIMARY KEY, campus text, cursus text)`);
    await ds.query(
      `INSERT INTO users (id, campus) VALUES ('platform-admin', NULL), ('officer', 'gardanne'), ('bde-star', 'gardanne')`
    );
    assos = ds.getRepository(Association);
    members = ds.getRepository(AssociationMember);
    audiences = ds.getRepository(AssociationAudience);
    const unused = {} as never;
    service = new AssociationsService(
      assos,
      members,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused, // redis: the post-cache sweep after addMember is caught and logged
      unused,
      unused,
      unused,
      { enabled: () => false, tell: async () => 0 } as never // lydiaNotifier
    );
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    if (ds?.isInitialized) await ds.destroy();
    if (!admin) return;
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it('creates with NO member at all by default - the platform admin does not become one', async () => {
    const created = await adminCreate('Sans Membre', {
      audiences: [{ formation: null, campus: 'gardanne' }],
    });

    expect(await members.count({ where: { associationId: created.id } })).toBe(0);
    expect(created.createdBy).toBe('platform-admin');
    // Manageable afterwards: adding the first member later works on the empty roster.
    await service.addMember(
      {
        associationId: created.id,
        userId: 'officer',
        role: 'Admin',
        permissions: ADMIN_PRESET,
      },
      PLATFORM_ADMIN
    );
    const roster = await members.find({ where: { associationId: created.id } });
    expect(roster.map((r) => [r.userId, r.sortOrder])).toEqual([['officer', 0]]);
  });

  it('creates with a first admin, in the same transaction, holding the preset sent', async () => {
    const created = await adminCreate('Avec Admin', {
      firstAdmin: { userId: 'officer', permissions: ADMIN_PRESET },
    });

    const roster = await members.find({ where: { associationId: created.id } });
    expect(roster).toHaveLength(1);
    // No title typed by code: the column's own default, as for any member added without one.
    expect(roster[0]).toMatchObject({
      userId: 'officer',
      role: 'Membre',
      permissions: ADMIN_PRESET,
    });
  });

  it('a first admin naming no account is a typed 400 and leaves no row behind', async () => {
    const before = await assos.count();
    await expect(
      adminCreate('Fantome', {
        firstAdmin: { userId: 'nobody', permissions: ADMIN_PRESET },
      })
    ).rejects.toMatchObject({
      response: { code: ADMIN_ASSOCIATION_ERROR.FIRST_ADMIN_UNKNOWN },
    });
    expect(await assos.count()).toBe(before);
  });

  it("an institution's first admin never manages its members - the platform admin's alone", async () => {
    const before = await assos.count();
    await expect(
      adminCreate('Mines Instit', {
        type: 'institution',
        firstAdmin: { userId: 'officer', permissions: ADMIN_PRESET },
      })
    ).rejects.toMatchObject({
      response: { code: ADMIN_ASSOCIATION_ERROR.INSTITUTION_MEMBERS_PLATFORM_ONLY },
    });
    expect(await assos.count()).toBe(before);

    const publisher = ADMIN_PRESET & ~AssociationPermissionFlag.MANAGE_MEMBERS;
    const created = await adminCreate('Mines Instit', {
      type: 'institution',
      firstAdmin: { userId: 'officer', permissions: publisher },
    });
    const [only] = await members.find({ where: { associationId: created.id } });
    expect(only.permissions & AssociationPermissionFlag.MANAGE_MEMBERS).toBe(0);
  });

  it('refuses it through the ONE member writer: the same code the roster editor gets, no row left', async () => {
    // The placement's first admin is written by `insertMembership`, the writer `addMember` uses:
    // one rule, one code, whichever door the write came through.
    const refusal = await adminCreate('Mines Instit Bis', {
      type: 'institution',
      firstAdmin: { userId: 'officer', permissions: AssociationPermissionFlag.MANAGE_MEMBERS },
    }).then(
      () => null,
      (e: { getStatus: () => number; getResponse: () => { code: string } }) => e
    );
    expect(refusal?.getStatus()).toBe(400);
    expect(refusal?.getResponse().code).toBe(
      ADMIN_ASSOCIATION_ERROR.INSTITUTION_MEMBERS_PLATFORM_ONLY
    );
    expect(await assos.count({ where: { name: 'Mines Instit Bis' } })).toBe(0);

    const school = await adminCreate('Mines Instit Ter', { type: 'institution' });
    // The platform admin adding a member manager later is the same 400 ...
    await expect(
      service.addMember(
        {
          associationId: school.id,
          userId: 'officer',
          role: 'Directeur',
          permissions: AssociationPermissionFlag.MANAGE_MEMBERS,
        },
        PLATFORM_ADMIN
      )
    ).rejects.toMatchObject({
      response: { code: ADMIN_ASSOCIATION_ERROR.INSTITUTION_MEMBERS_PLATFORM_ONLY },
    });
    // ... and anyone else adding any member is the 403 of the same rule.
    await expect(
      service.addMember(
        { associationId: school.id, userId: 'officer', role: 'Directeur', permissions: 0 },
        { userId: 'bde-star', isGlobalAdmin: false }
      )
    ).rejects.toMatchObject({
      status: 403,
      response: { code: ADMIN_ASSOCIATION_ERROR.INSTITUTION_MEMBERS_PLATFORM_ONLY },
    });
    expect(await members.count({ where: { associationId: school.id } })).toBe(0);
  });

  it('a name already taken gets -2, and the preview named it before the create', async () => {
    await adminCreate('Doublon');
    expect(await service.previewDerivedSlug('Doublon')).toBe('doublon-2');

    const second = await adminCreate('Doublon');

    expect(second.slug).toBe('doublon-2');
    expect(await service.previewDerivedSlug('Doublon')).toBe('doublon-3');
  });

  it('the preview walks past a cotisation-stem collision exactly as the create does', async () => {
    await adminCreate('Stem');
    warnSpy.mockClear();
    const preview = await service.previewDerivedSlug('Stem 2026-2027');
    // ASKED, never learned by failing: a preview logs no refusal it did not make.
    expect(warnSpy).not.toHaveBeenCalled();

    const dated = await adminCreate('Stem 2026-2027');

    expect(preview).toBe('stem-2026-2027-2');
    expect(dated.slug).toBe(preview);
  });

  it('writes exactly the spaces chosen - never the creator campus default', async () => {
    const created = await adminCreate('Placee', {
      audiences: [
        { formation: null, campus: 'saint-etienne' },
        { formation: null, campus: 'gardanne' },
      ],
    });
    const rules = await audiences.find({ where: { associationId: created.id } });
    expect(rules.map((r) => r.campus).sort()).toEqual(['gardanne', 'saint-etienne']);

    const nowhere = await adminCreate('Nulle Part');
    expect(await audiences.count({ where: { associationId: nowhere.id } })).toBe(0);
  });

  it('refuses an everyone rule on an association, before any write', async () => {
    const before = await assos.count();
    await expect(
      adminCreate('Partout', { audiences: [{ formation: null, campus: null }] })
    ).rejects.toMatchObject({ response: { code: AUDIENCE_ERROR.EVERYONE_INSTITUTION_ONLY } });
    expect(await assos.count()).toBe(before);

    const school = await adminCreate('Ecole', {
      type: 'institution',
      audiences: [{ formation: null, campus: null }],
    });
    expect(await audiences.count({ where: { associationId: school.id } })).toBe(1);
  });

  it('refuses a placement from anyone but a platform admin - a BDE MANAGE_ASSO holder included', async () => {
    const bde = await adminCreate('BDE Gardanne', {
      firstAdmin: {
        userId: 'bde-star',
        permissions: ADMIN_PRESET | AssociationPermissionFlag.MANAGE_ASSO,
      },
    });
    await ds.query(
      `INSERT INTO spaces (formation, campus, "bdeAssociationId") VALUES ('ICM', 'gardanne', $1)`,
      [bde.id]
    );
    const before = await assos.count();

    await expect(
      service.create({ name: 'Par Le BDE', type: 'association' } as never, 'bde-star', false, {
        audiences: [{ formation: null, campus: 'gardanne' }],
      })
    ).rejects.toMatchObject({ response: { code: ADMIN_ASSOCIATION_ERROR.PLATFORM_ADMIN_ONLY } });
    expect(await assos.count()).toBe(before);

    // Unchanged: the BDE still creates through its own path, in its own campus.
    const own = await service.create({ name: 'Club Du BDE' } as never, 'bde-star', false);
    expect(own.slug).toBe('club-du-bde');
  });

  it('pages every entity of a kind by keyset, ties on the name included, with search and counts', async () => {
    for (let i = 0; i < 5; i++) await adminCreate('Liste Pareille', { type: 'list' });
    await adminCreate('Autre Liste', {
      type: 'list',
      firstAdmin: { userId: 'officer', permissions: ADMIN_PRESET },
    });

    const seen: string[] = [];
    let after: string | undefined;
    let pages = 0;
    do {
      const page = await service.adminCatalogue({ type: 'list', limit: 2, after });
      seen.push(...page.rows.map((r) => r.id));
      after = page.next ?? undefined;
      pages++;
    } while (after);

    const all = await assos.find({ where: { type: 'list' } });
    expect(seen).toHaveLength(all.length);
    expect(new Set(seen).size).toBe(all.length);
    expect(pages).toBe(Math.ceil(all.length / 2));

    const found = await service.adminCatalogue({ type: 'list', q: 'AUTRE' });
    expect(found.rows.map((r) => r.name)).toEqual(['Autre Liste']);
    expect(found.rows[0].memberCount).toBe(1);
    expect(found.next).toBeNull();

    // Accents and case fold on both sides: "ecole" finds the name written with its acute accent.
    await adminCreate(`${String.fromCharCode(0xc9)}cole Doctorale`, { type: 'list' });
    const folded = await service.adminCatalogue({ type: 'list', q: 'ecole' });
    expect(folded.rows.map((r) => r.slug)).toEqual(['ecole-doctorale']);

    const bySlug = await service.adminCatalogue({ type: 'list', q: 'liste-pareille-3' });
    expect(bySlug.rows.map((r) => r.slug)).toEqual(['liste-pareille-3']);
  });

  it('a row carries its audience rules; a forged cursor is a typed 400', async () => {
    const page = await service.adminCatalogue({ type: 'association', q: 'placee' });
    expect(page.rows[0].audiences.map((r) => r.campus).sort()).toEqual([
      'gardanne',
      'saint-etienne',
    ]);

    const forged = (value: unknown) =>
      Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
    for (const after of [
      'not-a-cursor',
      // Well-formed, but its id is no UUID: a 400, never the driver's 22P02 as a 500.
      forged(['a', 'x']),
      // A name PostgreSQL text cannot hold.
      forged([`a${String.fromCharCode(0)}b`, '00000000-0000-4000-8000-000000000000']),
    ]) {
      await expect(service.adminCatalogue({ type: 'association', after })).rejects.toMatchObject({
        response: { code: ADMIN_ASSOCIATION_ERROR.BAD_CURSOR },
      });
    }
  });
});
