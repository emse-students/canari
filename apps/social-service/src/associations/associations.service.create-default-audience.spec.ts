import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { COTISATION_TAG_COLLISION } from './cotisation-namespace';
import { BDE_SPACE_STANDINGS_SQL } from '../spaces/bde';
import type { SpaceStanding } from '../spaces/audience-policy';
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
  /** The creator's BDE standing over every opened space (`BDE_SPACE_STANDINGS_SQL`). */
  standings: SpaceStanding[] = [],
  /** Other associations' slugs and tier keys, read by the cotisation-stem guard. */
  stems: { slug: string; variantKey: string | null }[] = []
) {
  const manager = {
    save: jest.fn((row: object) => Promise.resolve({ ...row, id: 'new-asso' })),
    query: jest.fn((sql: string) =>
      Promise.resolve(
        sql.includes('association_products')
          ? stems
          : sql === BDE_SPACE_STANDINGS_SQL
            ? standings
            : [{ campus }]
      )
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

/** Gardanne's two opened spaces, each governed or not by the creator's BDE. */
const gardanne = (ismin: boolean, icm: boolean): SpaceStanding[] => [
  { formation: 'ISMIN', campus: 'gardanne', governed: ismin },
  { formation: 'ICM', campus: 'gardanne', governed: icm },
  { formation: 'ICM', campus: 'saint-etienne', governed: false },
];

describe('AssociationsService.create - a non-admin creator gets an audience it may edit (owner, 2026-11-03)', () => {
  it('writes the whole campus when its BDE governs every space of it', async () => {
    const { service, manager } = makeService('gardanne', gardanne(true, true));

    await service.create(dto, 'star-1', false);

    expect(manager.insert).toHaveBeenCalledWith(AssociationAudience, [
      { associationId: 'new-asso', formation: null, campus: 'gardanne' },
    ]);
  });

  it('writes only its governed spaces when the campus is shared with another BDE', async () => {
    const { service, manager } = makeService('gardanne', gardanne(true, false));

    await service.create(dto, 'star-1', false);

    expect(manager.insert).toHaveBeenCalledWith(AssociationAudience, [
      { associationId: 'new-asso', formation: 'ISMIN', campus: 'gardanne' },
    ]);
  });

  it('REFUSES with a typed 403 when no space of the profile campus is governed, and writes no rule', async () => {
    for (const standings of [[], gardanne(false, false)]) {
      const { service, manager } = makeService('gardanne', standings);
      const err = await service.create(dto, 'star-2', false).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        code: 'AUDIENCE_OUTSIDE_BDE_CAMPUS',
      });
      expect(manager.insert).not.toHaveBeenCalled();
    }
  });

  it('leaves a global admin unchanged: the whole campus, no standing query at all', async () => {
    const { service, manager } = makeService('gardanne', []);

    await service.create(dto, 'admin-1', true);

    expect(manager.query).not.toHaveBeenCalledWith(BDE_SPACE_STANDINGS_SQL, expect.anything());
    expect(manager.insert).toHaveBeenCalledWith(AssociationAudience, [
      { associationId: 'new-asso', formation: null, campus: 'gardanne' },
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
