import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { BDE_GOVERNED_CAMPUSES_SQL } from '../spaces/bde';
import { AssociationsService } from './associations.service';
import { AssociationAudience } from '../spaces/association-audience.entity';
import { READER_PROFILE_SQL } from '../spaces/reader-spaces';

/**
 * A NEW ASSOCIATION OR LIST REACHES ITS CREATOR'S CAMPUS BY DEFAULT (user, 2026-10-07; D36's
 * "creator's spaces" replaced): one rule, every formation + the profile campus, written in the SAME
 * transaction as the row. A creator with no campus is refused with a typed error and nothing is
 * kept. An institution keeps no default rule.
 */
function makeService(campus: string | null, governed: string[] = []) {
  const manager = {
    save: jest.fn((row: object) => Promise.resolve({ ...row, id: 'new-asso' })),
    query: jest.fn((sql: string) =>
      Promise.resolve(
        sql === BDE_GOVERNED_CAMPUSES_SQL ? governed.map((c) => ({ campus: c })) : [{ campus }]
      )
    ),
    insert: jest.fn(() => Promise.resolve()),
  };
  const assoRepo = {
    findOne: jest.fn(() => Promise.resolve(null)),
    create: jest.fn((row: object) => row),
    save: jest.fn(),
    manager: { transaction: jest.fn((work: (m: typeof manager) => unknown) => work(manager)) },
  };
  // POSITIONAL, AND THIRTEEN LONG - keep aligned with the constructor in `associations.service.ts`.
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
    undefined as never // userTagService
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
    expect(manager.query).not.toHaveBeenCalled();
    expect(manager.insert).not.toHaveBeenCalled();
  });
});

describe('AssociationsService.create - a non-admin creator is bound to the campuses its BDE governs', () => {
  it('creates when the default campus is governed by the creator BDE', async () => {
    const { service, manager } = makeService('gardanne', ['gardanne']);

    await service.create(dto, 'star-1', false);

    expect(manager.insert).toHaveBeenCalledWith(AssociationAudience, [
      { associationId: 'new-asso', formation: null, campus: 'gardanne' },
    ]);
  });

  it('REFUSES with a typed 403 when the profile campus is not governed, and writes no rule', async () => {
    for (const governed of [[], ['saint-etienne']]) {
      const { service, manager } = makeService('gardanne', governed);
      const err = await service.create(dto, 'star-2', false).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        code: 'AUDIENCE_OUTSIDE_BDE_CAMPUS',
      });
      expect(manager.insert).not.toHaveBeenCalled();
    }
  });

  it('leaves a global admin unchanged: no governed-campus query at all', async () => {
    const { service, manager } = makeService('gardanne', []);

    await service.create(dto, 'admin-1', true);

    expect(manager.query).not.toHaveBeenCalledWith(BDE_GOVERNED_CAMPUSES_SQL, expect.anything());
    expect(manager.insert).toHaveBeenCalled();
  });
});
