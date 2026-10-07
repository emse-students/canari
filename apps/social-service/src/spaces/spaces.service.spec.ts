import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { DataSource, Repository } from 'typeorm';
import type { Association } from '../associations/entities/association.entity';
import { AssociationAudience } from './association-audience.entity';
import { Space, SPACE_CAMPUSES, SPACE_FORMATIONS } from './space.entity';
import { SpacesService, normaliseRules, ruleReachesSpace, smallestRules } from './spaces.service';

const space = { formation: 'ICM', campus: 'saint-etienne' } as const;

describe('ruleReachesSpace', () => {
  it('matches a pair exactly', () => {
    expect(ruleReachesSpace({ formation: 'ICM', campus: 'saint-etienne' }, space)).toBe(true);
    expect(ruleReachesSpace({ formation: 'ISMIN', campus: 'saint-etienne' }, space)).toBe(false);
  });

  it('treats null as any: a campus rule reaches every formation on that campus', () => {
    expect(ruleReachesSpace({ formation: null, campus: 'saint-etienne' }, space)).toBe(true);
    expect(ruleReachesSpace({ formation: null, campus: 'gardanne' }, space)).toBe(false);
    expect(ruleReachesSpace({ formation: null, campus: null }, space)).toBe(true);
  });
});

describe('normaliseRules', () => {
  it('turns absent into null and collapses duplicates', () => {
    expect(
      normaliseRules([{ campus: 'gardanne' }, { formation: null, campus: 'gardanne' }, {}])
    ).toEqual([
      { formation: null, campus: 'gardanne' },
      { formation: null, campus: null },
    ]);
  });
});

/** D36: a new association's default reach, written the way the admin grid writes it. */
describe('smallestRules', () => {
  const pairs = (formations: readonly string[], campus: string) =>
    formations.map((formation) => ({ formation, campus }) as Space);

  it('gives no rule for no space', () => {
    expect(smallestRules([])).toEqual([]);
  });

  it('writes one pair rule per space short of a whole campus', () => {
    expect(smallestRules(pairs(['ICM', 'ISMIN'], 'saint-etienne'))).toEqual([
      { formation: 'ICM', campus: 'saint-etienne' },
      { formation: 'ISMIN', campus: 'saint-etienne' },
    ]);
  });

  it('collapses a whole campus into one campus rule', () => {
    expect(smallestRules(pairs(SPACE_FORMATIONS, 'gardanne'))).toEqual([
      { formation: null, campus: 'gardanne' },
    ]);
  });

  it('collapses every pair into the one everyone rule, duplicates ignored', () => {
    const all = [
      ...pairs(SPACE_FORMATIONS, 'saint-etienne'),
      ...pairs(SPACE_FORMATIONS, 'gardanne'),
      ...pairs(['ICM'], 'gardanne'),
    ];
    expect(smallestRules(all)).toEqual([{ formation: null, campus: null }]);
  });

  it('reaches exactly the pairs it was given', () => {
    const given = pairs(['FSSS', 'PDIS'], 'gardanne');
    const rules = smallestRules(given);
    for (const campus of SPACE_CAMPUSES) {
      for (const formation of SPACE_FORMATIONS) {
        const reached = rules.some((r) => ruleReachesSpace(r, { formation, campus }));
        const wanted = given.some((p) => p.formation === formation && p.campus === campus);
        expect(reached).toBe(wanted);
      }
    }
  });
});

describe('SpacesService', () => {
  function make(opts: {
    space?: Partial<Space> | null;
    association?: Partial<Association> | null;
    spaceRows?: Partial<Space>[];
    rules?: Partial<AssociationAudience>[];
    /** The spaces the association governs, as the transaction reads them. */
    governed?: Partial<Space>[];
  }) {
    const update = jest.fn().mockResolvedValue(undefined);
    const save = jest.fn().mockImplementation(async (s: Partial<Space>) => s);
    const spaces = {
      findOne: jest.fn().mockResolvedValue(opts.space ?? null),
      update,
      create: jest.fn().mockImplementation((s: Partial<Space>) => s),
      save,
      find: jest.fn().mockResolvedValue(opts.spaceRows ?? []),
    } as unknown as Repository<Space>;
    const associations = {
      findOne: jest.fn().mockResolvedValue(opts.association ?? null),
      exists: jest.fn().mockResolvedValue(!!opts.association),
      find: jest.fn().mockResolvedValue([]),
    } as unknown as Repository<Association>;
    const audiences = {
      find: jest.fn().mockResolvedValue(opts.rules ?? []),
    } as unknown as Repository<AssociationAudience>;
    const manager = {
      delete: jest.fn(),
      insert: jest.fn(),
      update: jest.fn(),
      find: jest
        .fn()
        .mockImplementation(async (entity: unknown) =>
          entity === Space ? (opts.governed ?? []) : (opts.rules ?? [])
        ),
    };
    const dataSource = {
      transaction: jest.fn().mockImplementation(async (cb: (m: unknown) => unknown) => cb(manager)),
    } as unknown as DataSource;
    const redis = { deleteByPattern: jest.fn().mockResolvedValue(3) };
    return {
      service: new SpacesService(spaces, associations, audiences, dataSource, redis as never),
      save,
      manager,
      redis,
    };
  }

  it('refuses a list as a BDE and an unknown space or association', async () => {
    await expect(make({}).service.setBde('s', null)).rejects.toBeInstanceOf(NotFoundException);
    await expect(make({ space: { id: 's' } }).service.setBde('s', 'a')).rejects.toBeInstanceOf(
      NotFoundException
    );
    await expect(
      make({ space: { id: 's' }, association: { id: 'a', type: 'list' } }).service.setBde('s', 'a')
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('designates and clears a BDE', async () => {
    const { service, manager } = make({
      space: { id: 's', formation: 'ICM', campus: 'saint-etienne' },
      association: { id: 'a', type: 'association' },
      rules: [{ associationId: 'a', formation: 'ICM', campus: 'saint-etienne' }],
    });
    await service.setBde('s', 'a');
    expect(manager.update).toHaveBeenCalledWith(Space, { id: 's' }, { bdeAssociationId: 'a' });
    await service.setBde('s', null);
    expect(manager.update).toHaveBeenLastCalledWith(Space, { id: 's' }, { bdeAssociationId: null });
  });

  it('lets one association be the BDE of several spaces', async () => {
    const { service, manager } = make({
      space: { id: 's' },
      association: { id: 'a', type: 'association' },
      rules: [{ associationId: 'a', formation: null, campus: null }],
    });
    await service.setBde('s1', 'a');
    await service.setBde('s2', 'a');
    expect(manager.update).toHaveBeenCalledTimes(2);
  });

  it('adds the reach when the new BDE did not cover its space, and only then', async () => {
    const uncovered = make({
      space: { id: 's', formation: 'ICM', campus: 'gardanne' },
      association: { id: 'a', type: 'association' },
      rules: [{ associationId: 'a', formation: 'ICM', campus: 'saint-etienne' }],
    });
    await uncovered.service.setBde('s', 'a');
    expect(uncovered.manager.insert).toHaveBeenCalledWith(AssociationAudience, {
      associationId: 'a',
      formation: 'ICM',
      campus: 'gardanne',
    });
    const covered = make({
      space: { id: 's', formation: 'ICM', campus: 'gardanne' },
      association: { id: 'a', type: 'association' },
      rules: [{ associationId: 'a', formation: null, campus: 'gardanne' }],
    });
    await covered.service.setBde('s', 'a');
    expect(covered.manager.insert).not.toHaveBeenCalled();
  });

  it('lists every space with its BDE', async () => {
    const { service } = make({
      spaceRows: [
        { id: 's1', formation: 'ICM', campus: 'saint-etienne', bdeAssociationId: 'a' },
        { id: 's2', formation: 'ISMIN', campus: 'gardanne', bdeAssociationId: 'a' },
        { id: 's3', formation: 'FSSS', campus: 'gardanne', bdeAssociationId: null },
      ],
    });
    const spaces = await service.list();
    expect(spaces.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
    expect(spaces[2].bde).toBeNull();
  });

  it('lists the rules of every association', async () => {
    const { service } = make({
      rules: [
        { associationId: 'a', formation: 'ICM', campus: 'saint-etienne' },
        { associationId: 'b', formation: null, campus: 'saint-etienne' },
      ],
    });
    expect(await service.listAudiences()).toEqual([
      { associationId: 'a', formation: 'ICM', campus: 'saint-etienne' },
      { associationId: 'b', formation: null, campus: 'saint-etienne' },
    ]);
  });

  it('replaces the rules in one transaction, de-duplicated', async () => {
    const { service, manager } = make({ association: { id: 'a' } });
    await service.setAudiences('a', [{ campus: 'saint-etienne' }, { campus: 'saint-etienne' }]);
    expect(manager.delete).toHaveBeenCalled();
    expect(manager.insert).toHaveBeenCalledWith(expect.anything(), [
      { associationId: 'a', formation: null, campus: 'saint-etienne' },
    ]);
  });

  it('accepts an empty set: the association then reaches nobody', async () => {
    const { service, manager } = make({ association: { id: 'a' } });
    await expect(service.setAudiences('a', [])).resolves.toEqual([]);
    expect(manager.delete).toHaveBeenCalled();
    expect(manager.insert).not.toHaveBeenCalled();
  });

  it('puts back the pair an association governs as BDE, whatever is submitted', async () => {
    const { service, manager } = make({
      association: { id: 'a' },
      governed: [{ id: 's', formation: 'ICM', campus: 'gardanne' }],
    });
    const saved = await service.setAudiences('a', [{ campus: 'saint-etienne' }]);
    expect(saved).toEqual([
      { formation: null, campus: 'saint-etienne' },
      { formation: 'ICM', campus: 'gardanne' },
    ]);
    expect(manager.insert).toHaveBeenCalled();
  });

  it('drops every cached feed page when who an association reaches changes (WP6b)', async () => {
    // The list cache is keyed per reader and the rules decide which posts each reader gets, so a
    // rule change - by the grid or by designating a BDE - is a change to every reader's pages.
    const rules = make({ association: { id: 'a' } });
    await rules.service.setAudiences('a', [{ campus: 'gardanne' }]);
    expect(rules.redis.deleteByPattern).toHaveBeenCalledWith('posts:list:v2:*');

    const bde = make({
      space: { id: 's', formation: 'ICM', campus: 'gardanne' },
      association: { id: 'a', type: 'association' },
    });
    await bde.service.setBde('s', 'a');
    expect(bde.redis.deleteByPattern).toHaveBeenCalledWith('posts:list:v2:*');
  });

  it('does not drop the cache for a write it refused', async () => {
    const refused = make({});
    await expect(refused.service.setAudiences('a', [])).rejects.toBeInstanceOf(NotFoundException);
    expect(refused.redis.deleteByPattern).not.toHaveBeenCalled();
  });
});
