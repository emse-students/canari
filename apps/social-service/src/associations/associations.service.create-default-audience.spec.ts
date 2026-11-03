import { BadRequestException, ConflictException } from '@nestjs/common';
import { COTISATION_TAG_COLLISION } from './cotisation-namespace';
import { BDES_WHERE_USER_HOLDS_SQL } from '../spaces/bde';
import {
  DEPENDENCY_INSTITUTION,
  DEPENDENCY_PARENT_CHOICE_REQUIRED,
  DEPENDENCY_PARENT_NOT_A_BDE,
  DEPENDENCY_PARENT_NOT_YOURS,
} from '../spaces/dependency-rules';
import { SLUG_EXHAUSTED } from './association-slug.util';
import { AssociationsService } from './associations.service';
import { AssociationAudience } from '../spaces/association-audience.entity';
import { READER_PROFILE_SQL } from '../spaces/reader-spaces';

/**
 * A NEW ASSOCIATION OR LIST REACHES ITS CREATOR'S CAMPUS BY DEFAULT (user, 2026-10-07; D36's
 * "creator's spaces" replaced): one rule, every formation + the profile campus, written in the SAME
 * transaction as the row. A creator with no campus is refused with a typed error and nothing is
 * kept. An institution keeps no default rule.
 */
function makeService(
  campus: string | null,
  /** Unused since WP-D1 (a non-admin's default audience is its parent's spaces); kept positional. */
  _standings: unknown[] = [],
  /** Other associations' slugs and tier keys, read by the cotisation-stem guard. */
  stems: { slug: string; variantKey: string | null }[] = []
) {
  const manager = {
    save: jest.fn((row: object) => Promise.resolve({ ...row, id: 'new-asso' })),
    query: jest.fn((sql: string) =>
      Promise.resolve(sql.includes('association_products') ? stems : [{ campus }])
    ),
    insert: jest.fn(() => Promise.resolve()),
  };
  const assoRepo = {
    findOne: jest.fn(() => Promise.resolve(null)),
    /** The catalog read of the violated index's columns: `*slug*` indexes cover `slug`, others `name`. */
    query: jest.fn((_sql: string, params: unknown[]) =>
      Promise.resolve(
        String(params[0]).includes('slug') ? [{ attname: 'slug' }] : [{ attname: 'name' }]
      )
    ),
    create: jest.fn((row: object) => row),
    save: jest.fn(),
    manager: { transaction: jest.fn((work: (m: typeof manager) => unknown) => work(manager)) },
  };
  // POSITIONAL, AND FOURTEEN LONG - keep aligned with the constructor in `associations.service.ts`.
  const service = new AssociationsService(
    assoRepo as never, // assoRepo
    undefined as never, // memberRepo
    undefined as never, // calendarRepo
    undefined as never, // coOwnerRepo
    undefined as never, // docRepo
    undefined as never, // reviewerGrantRepo
    undefined as never, // postRepo
    undefined as never, // formRepo
    undefined as never, // productRepo
    undefined as never, // redis
    undefined as never, // httpService
    undefined as never, // notifications
    undefined as never, // userTagService
    { enabled: () => false, tell: async () => 0 } as never // lydiaNotifier
  );
  return { service, manager, assoRepo };
}

const dto = { name: 'Club', slug: 'club' } as never;
const institutionDto = { name: 'Ecole', slug: 'ecole', type: 'institution' } as never;

describe('AssociationsService.create - the default reach (campus, every formation)', () => {
  it("writes ONE rule, the creator's campus and every formation, inside the transaction", async () => {
    const { service, manager, assoRepo } = makeService('saint-etienne');

    const saved = await service.create(dto, 'creator-1', true);

    expect(saved).toMatchObject({ id: 'new-asso', createdBy: 'creator-1' });
    expect(assoRepo.save).not.toHaveBeenCalled();
    expect(manager.query).toHaveBeenCalledWith(READER_PROFILE_SQL, ['creator-1']);
    expect(manager.insert).toHaveBeenCalledWith(AssociationAudience, [
      { associationId: 'new-asso', formation: null, campus: 'saint-etienne' },
    ]);
  });

  it('gives a list the same default', async () => {
    const { service, manager } = makeService('gardanne');

    await service.create({ ...(dto as object), type: 'list' } as never, 'creator-2', true);

    expect(manager.insert).toHaveBeenCalledWith(AssociationAudience, [
      { associationId: 'new-asso', formation: null, campus: 'gardanne' },
    ]);
  });

  it('REFUSES a creator with no campus, typed, and writes no rule', async () => {
    for (const campus of [null, '', 'lyon']) {
      const { service, manager } = makeService(campus);
      const err = await service.create(dto, 'no-campus', true).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        code: 'AUDIENCE_CREATOR_CAMPUS_REQUIRED',
      });
      expect(manager.insert).not.toHaveBeenCalled();
    }
  });

  it('writes NO rule for an institution, even for a creator who has a campus (user, 2026-10-05)', async () => {
    const { service, manager } = makeService('saint-etienne');

    const saved = await service.create(institutionDto, 'admin-with-campus', true);

    expect(saved).toMatchObject({ id: 'new-asso' });
    expect(manager.query).not.toHaveBeenCalledWith(READER_PROFILE_SQL, expect.anything());
    expect(manager.insert).not.toHaveBeenCalled();
  });

  it("REFUSES a slug whose cotisation tags would coincide with another association's, writing nothing", async () => {
    const { service, manager } = makeService(
      'saint-etienne',
      [],
      [{ slug: 'cercle', variantKey: 'club' }]
    );

    const err = await service
      .create({ name: 'Club', slug: 'cercle-club' } as never, 'creator-1', true)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: COTISATION_TAG_COLLISION,
    });
    expect(manager.save).not.toHaveBeenCalled();
  });
});

/**
 * THE PARENT A NEW ENTITY IS CREATED UNDER, AND THE DEFAULT AUDIENCE IT DERIVES (WP-D1, reform 2.5,
 * owner B1): the creating BDE, picked among several; a non-BDE named as parent becomes the G3 label;
 * an institution has none. The audience is the spaces the parent governs.
 */
describe('AssociationsService.create - the governing parent and its default audience (WP-D1)', () => {
  /** Associations by id, as `manager.findOne` reads them; the ids of the spaces' governors. */
  function withDependencies(
    opts: {
      byId?: Record<string, { id: string; type: string }>;
      governing?: Record<string, { formation: string; campus: string }[]>;
      mine?: string[];
    } = {}
  ) {
    const made = makeService('saint-etienne');
    const { manager } = made as unknown as {
      manager: Record<string, jest.Mock> & { query: jest.Mock };
    };
    manager.findOne = jest.fn(async (_e: unknown, { where }: { where: { id: string } }) =>
      opts.byId?.[where.id] ? opts.byId[where.id] : null
    );
    manager.count = jest.fn(
      async (_e: unknown, { where }: { where: { bdeAssociationId: string } }) =>
        (opts.governing?.[where.bdeAssociationId] ?? []).length
    );
    manager.find = jest.fn(
      async (_e: unknown, { where }: { where: { bdeAssociationId: string } }) =>
        opts.governing?.[where.bdeAssociationId] ?? []
    );
    const base = manager.query.getMockImplementation() as (sql: string) => Promise<unknown>;
    manager.query.mockImplementation(async (sql: string) =>
      sql === BDES_WHERE_USER_HOLDS_SQL ? (opts.mine ?? []).map((id) => ({ id })) : base(sql)
    );
    return made;
  }
  const BDE = { id: 'bde', type: 'association' };
  const FSSS = { id: 'fsss', type: 'association' };
  const BDS = { id: 'bds', type: 'association' };
  const SCHOOL = { id: 'school', type: 'institution' };
  const SE = (formation: string) => ({ formation, campus: 'saint-etienne' });
  const governing = { bde: ['ICM', 'ISMIN', 'PDIS', 'Autre'].map(SE), fsss: [SE('FSSS')] };

  async function codeOf(p: Promise<unknown>): Promise<string | null> {
    const e = await p.then(
      () => null,
      (err: unknown) => err
    );
    return e ? ((e as ConflictException).getResponse() as { code: string }).code : null;
  }

  it("gives a non-admin creator's entity its only BDE as parent, journaled, and that BDE's spaces", async () => {
    const { service, manager, assoRepo } = withDependencies({ governing, mine: ['bde'] });

    await service.create(dto, 'star-1', false);

    expect(assoRepo.create.mock.results[0].value).toMatchObject({
      parentAssociationId: 'bde',
      displayParentAssociationId: null,
    });
    expect(manager.query).toHaveBeenCalledWith(expect.stringContaining('dependency_journal'), [
      'entity',
      'new-asso',
      null,
      'bde',
      'star-1',
      'create',
    ]);
    expect(manager.insert).toHaveBeenCalledWith(AssociationAudience, [
      { associationId: 'new-asso', formation: 'ICM', campus: 'saint-etienne' },
      { associationId: 'new-asso', formation: 'ISMIN', campus: 'saint-etienne' },
      { associationId: 'new-asso', formation: 'PDIS', campus: 'saint-etienne' },
      { associationId: 'new-asso', formation: 'Autre', campus: 'saint-etienne' },
    ]);
  });

  it('makes a creator managing two BDEs pick one, and holds the pick to its own BDEs', async () => {
    const two = withDependencies({
      byId: { bde: BDE, fsss: FSSS },
      governing,
      mine: ['bde', 'fsss'],
    });
    expect(await codeOf(two.service.create(dto, 'star-2', false))).toBe(
      DEPENDENCY_PARENT_CHOICE_REQUIRED
    );
    expect(two.manager.save).not.toHaveBeenCalled();

    const picked = withDependencies({
      byId: { bde: BDE, fsss: FSSS },
      governing,
      mine: ['bde', 'fsss'],
    });
    await picked.service.create(
      { ...(dto as object), parentAssociationId: 'fsss' } as never,
      'star-2',
      false
    );
    expect(picked.manager.insert).toHaveBeenCalledWith(AssociationAudience, [
      { associationId: 'new-asso', formation: 'FSSS', campus: 'saint-etienne' },
    ]);

    const notMine = withDependencies({ byId: { bde: BDE, fsss: FSSS }, governing, mine: ['bde'] });
    expect(
      await codeOf(
        notMine.service.create(
          { ...(dto as object), parentAssociationId: 'fsss' } as never,
          'star-1',
          false
        )
      )
    ).toBe(DEPENDENCY_PARENT_NOT_YOURS);
  });

  it('keeps a parent that governs nothing (the BDS) as the G3 label, under the default BDE', async () => {
    const { service, assoRepo } = withDependencies({
      byId: { bde: BDE, bds: BDS },
      governing,
      mine: ['bde'],
    });

    await service.create(
      { ...(dto as object), type: 'list', parentAssociationId: 'bds' } as never,
      'star-1',
      false
    );

    expect(assoRepo.create.mock.results[0].value).toMatchObject({
      parentAssociationId: 'bde',
      displayParentAssociationId: 'bds',
    });
  });

  // F6: the trigger is the last word on every door. A refusal it raises during the create (a write
  // that raced the check, a placement naming a parented governor) is the same typed 409, never a 500.
  it('turns a trigger refusal of the insert into the typed 409, and lets any other error through', async () => {
    const raced = withDependencies({ governing, mine: ['bde'] });
    raced.manager.save.mockRejectedValueOnce(
      Object.assign(new Error('dependency refused'), {
        driverError: { code: '23514', constraint: DEPENDENCY_PARENT_NOT_A_BDE },
      })
    );
    expect(await codeOf(raced.service.create(dto, 'star-1', false))).toBe(
      DEPENDENCY_PARENT_NOT_A_BDE
    );

    const other = withDependencies({ governing, mine: ['bde'] });
    const boom = Object.assign(new Error('other check'), {
      driverError: { code: '23514', constraint: 'some_other_check' },
    });
    other.manager.save.mockRejectedValueOnce(boom);
    await expect(other.service.create(dto, 'star-1', false)).rejects.toBe(boom);
  });

  it('refuses a parent for an institution, and an institution as a parent', async () => {
    const { service } = withDependencies({ byId: { bde: BDE, school: SCHOOL }, governing });
    expect(
      await codeOf(
        service.create(
          { ...(institutionDto as object), parentAssociationId: 'bde' } as never,
          'admin',
          true
        )
      )
    ).toBe(DEPENDENCY_INSTITUTION);
    expect(
      await codeOf(
        service.create(
          { ...(dto as object), parentAssociationId: 'school' } as never,
          'admin',
          true
        )
      )
    ).toBe(DEPENDENCY_PARENT_NOT_A_BDE);
  });

  it("lets a platform admin pick a BDE (its spaces) or none (the admin's campus)", async () => {
    const picked = withDependencies({ byId: { fsss: FSSS }, governing });
    await picked.service.create(
      { ...(dto as object), parentAssociationId: 'fsss' } as never,
      'admin',
      true
    );
    expect(picked.manager.insert).toHaveBeenCalledWith(AssociationAudience, [
      { associationId: 'new-asso', formation: 'FSSS', campus: 'saint-etienne' },
    ]);

    const none = withDependencies({ governing });
    await none.service.create(dto, 'admin', true);
    expect(none.manager.query).not.toHaveBeenCalledWith(
      BDES_WHERE_USER_HOLDS_SQL,
      expect.anything()
    );
    expect(none.manager.insert).toHaveBeenCalledWith(AssociationAudience, [
      { associationId: 'new-asso', formation: null, campus: 'saint-etienne' },
    ]);
  });
});

describe('AssociationsService.create - the slug is derived, never typed (user, 2026-10-26)', () => {
  const unique = (constraint = 'UQ_associations_slug') =>
    Object.assign(new Error('duplicate key'), { code: '23505', constraint });

  it('derives the slug from the name when none is sent, accents folded', async () => {
    const { service, assoRepo } = makeService('gardanne');

    await service.create({ name: 'Bureau des Élèves' } as never, 'u', true);

    expect(assoRepo.findOne).not.toHaveBeenCalled();
    expect(assoRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'bureau-des-eleves' })
    );
  });

  it('appends -2, -3 on each unique violation, the index being the arbiter', async () => {
    const { service, manager, assoRepo } = makeService('gardanne');
    manager.save
      .mockRejectedValueOnce(unique())
      .mockRejectedValueOnce(unique())
      .mockImplementation((row: object) => Promise.resolve({ ...row, id: 'new-asso' }));

    const saved = await service.create({ name: 'Club' } as never, 'u', true);

    expect(saved).toMatchObject({ slug: 'club-3' });
    expect(assoRepo.create.mock.calls.map((c) => (c[0] as { slug: string }).slug)).toEqual([
      'club',
      'club-2',
      'club-3',
    ]);
  });

  it("walks past a derived candidate whose cotisation stem collides with another association's", async () => {
    const { service, manager } = makeService('gardanne', [], [{ slug: 'bde', variantKey: null }]);

    const saved = await service.create({ name: 'BDE 2026-2027' } as never, 'u', true);

    expect(saved).toMatchObject({ slug: 'bde-2026-2027-2' });
    expect(manager.save).toHaveBeenCalledTimes(1);
  });

  it('rethrows a failure that is not a unique violation, without retrying', async () => {
    const { service, manager } = makeService('gardanne');
    manager.save.mockRejectedValueOnce(new Error('connection lost'));

    await expect(service.create({ name: 'Club' } as never, 'u', true)).rejects.toThrow(
      'connection lost'
    );
    expect(manager.save).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a unique violation on another COLUMN, and rethrows it', async () => {
    const { service, manager } = makeService('gardanne');
    manager.save.mockRejectedValueOnce(unique('UQ_some_other_index'));

    await expect(service.create({ name: 'Club' } as never, 'u', true)).rejects.toMatchObject({
      constraint: 'UQ_some_other_index',
    });
    expect(manager.save).toHaveBeenCalledTimes(1);
  });

  it('walks on a violation of the slug column whatever its constraint is called', async () => {
    const { service, manager, assoRepo } = makeService('gardanne');
    manager.save.mockRejectedValueOnce(unique('live_hand_named_slug_key'));

    const saved = await service.create({ name: 'Club' } as never, 'u', true);

    expect(saved).toMatchObject({ slug: 'club-2' });
    expect(assoRepo.query).toHaveBeenCalledWith(expect.any(String), [
      'live_hand_named_slug_key',
      null,
    ]);
  });

  it('refuses with a TYPED code once every candidate is taken', async () => {
    const { service, manager } = makeService('gardanne');
    manager.save.mockRejectedValue(unique());

    const err = await service.create({ name: '日本' } as never, 'u', true).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({ code: SLUG_EXHAUSTED });
  });

  it('suffixes a name deriving to a reserved route word, and refuses it as an explicit slug', async () => {
    const { service, assoRepo } = makeService('gardanne');

    await service.create({ name: 'New' } as never, 'u', true);
    expect(assoRepo.create).toHaveBeenCalledWith(expect.objectContaining({ slug: 'new-2' }));
    await expect(
      service.create({ name: 'X', slug: 'new' } as never, 'u', true)
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('still refuses an explicit slug that is taken, and validates its shape', async () => {
    const { service, assoRepo } = makeService('gardanne');
    assoRepo.findOne.mockResolvedValueOnce({ id: 'other' } as never);

    await expect(
      service.create({ name: 'Club', slug: 'club' } as never, 'u', true)
    ).rejects.toThrow('already exists');
    await expect(
      service.create({ name: 'Club', slug: 'Bad Slug' } as never, 'u', true)
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses an explicit slug that loses the race at the unique index', async () => {
    const { service, manager } = makeService('gardanne');
    manager.save.mockRejectedValueOnce(unique());

    await expect(
      service.create({ name: 'Club', slug: 'club' } as never, 'u', true)
    ).rejects.toThrow('already exists');
  });
});
