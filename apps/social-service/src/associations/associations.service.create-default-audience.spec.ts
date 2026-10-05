import { AssociationsService } from './associations.service';
import { AssociationAudience } from '../spaces/association-audience.entity';
import { READER_SPACES_SQL } from '../spaces/reader-spaces';

/**
 * D36 (user, 2026-10-04): A NEW ASSOCIATION REACHES ITS CREATOR'S SPACES BY DEFAULT.
 *
 * The rules are written in the SAME transaction as the row - the save, the read of the creator's
 * spaces and the insert all go through the transaction's manager, never the repository - so the
 * association never exists without its default. The rule set is the smallest one (the grid's
 * canonical form), and a creator with no space writes nothing. Which readers those rules then reach
 * is proven against PostgreSQL in `reader-spaces.integration.spec.ts`.
 */
function makeService(creatorSpaces: { formation: string; campus: string }[]) {
  const manager = {
    save: jest.fn((row: object) => Promise.resolve({ ...row, id: 'new-asso' })),
    query: jest.fn(() => Promise.resolve(creatorSpaces)),
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

describe('AssociationsService.create - the default reach (D36)', () => {
  it("writes the creator's spaces as the smallest rule set, inside the transaction", async () => {
    const { service, manager, assoRepo } = makeService([
      { formation: 'ICM', campus: 'saint-etienne' },
      { formation: 'ISMIN', campus: 'saint-etienne' },
    ]);

    const saved = await service.create(dto, 'creator-1');

    expect(saved).toMatchObject({ id: 'new-asso', createdBy: 'creator-1' });
    expect(assoRepo.save).not.toHaveBeenCalled();
    expect(manager.query).toHaveBeenCalledWith(READER_SPACES_SQL, ['creator-1']);
    expect(manager.insert).toHaveBeenCalledWith(AssociationAudience, [
      { associationId: 'new-asso', formation: 'ICM', campus: 'saint-etienne' },
      { associationId: 'new-asso', formation: 'ISMIN', campus: 'saint-etienne' },
    ]);
  });

  it('collapses a whole campus into one campus rule', async () => {
    const { service, manager } = makeService(
      ['ICM', 'ISMIN', 'FSSS', 'PDIS', 'Autre'].map((formation) => ({
        formation,
        campus: 'gardanne',
      }))
    );

    await service.create(dto, 'creator-2');

    expect(manager.insert).toHaveBeenCalledWith(AssociationAudience, [
      { associationId: 'new-asso', formation: null, campus: 'gardanne' },
    ]);
  });

  it('writes no rule for a creator with no space', async () => {
    const { service, manager } = makeService([]);

    const saved = await service.create(dto, 'admin-no-space');

    expect(saved).toMatchObject({ id: 'new-asso' });
    expect(manager.insert).not.toHaveBeenCalled();
  });

  it('writes NO rule for an institution, even for a creator who has spaces (user, 2026-10-05)', async () => {
    const { service, manager } = makeService([{ formation: 'ICM', campus: 'saint-etienne' }]);

    const saved = await service.create(institutionDto, 'admin-with-spaces');

    expect(saved).toMatchObject({ id: 'new-asso' });
    expect(manager.query).not.toHaveBeenCalled();
    expect(manager.insert).not.toHaveBeenCalled();
  });
});
