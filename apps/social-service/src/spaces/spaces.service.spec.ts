import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { DataSource, Repository } from 'typeorm';
import type { Association } from '../associations/entities/association.entity';
import { AssociationAudience } from './association-audience.entity';
import { Space, SPACE_CAMPUSES, SPACE_FORMATIONS } from './space.entity';
import {
  FORMER_PARENT_SEATS_SQL,
  SpacesService,
  normaliseRules,
  ruleReachesSpace,
  smallestRules,
} from './spaces.service';
import { ENTITY_GOVERNOR_SPACE_STANDINGS_SQL, HOLDS_BDE_FLAG_OVER_SQL } from './bde';
import {
  DEPENDENCY_CHILD_IS_A_BDE,
  DEPENDENCY_INSTITUTION,
  DEPENDENCY_LABEL_INVALID,
  DEPENDENCY_PARENT_NOT_A_BDE,
  SPACE_GOVERNOR_TYPE,
} from './dependency-rules';

const space = { formation: 'ICM', campus: 'saint-etienne' } as const;
const ADMIN = { userId: 'admin-1', isGlobalAdmin: true };
const STAR = { userId: 'star-1', isGlobalAdmin: false };
const ACTOR = { userId: 'admin-1' };

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
    /** The campuses whose every space a BDE where the caller holds MANAGE_ASSO governs. */
    bdeCampuses?: string[];
    /**
     * Whether the caller holds MANAGE_ASSO in the entity's PARENT (WP-D2). By default: the entity has
     * a rule on one of `bdeCampuses`, the shape of the fixtures written before the parent existed.
     */
    governs?: boolean;
    /** The campuses whose every space the entity's PARENT governs; by default `bdeCampuses`. */
    parentCampuses?: string[];
    /** What `FORMER_PARENT_SEATS_SQL` answers: the child's rows held by the former parent's officers. */
    formerParentSeats?: { userId: string; permissions: number }[];
    /** Associations by id, when a test needs more than one (`setParent`). */
    byId?: Record<string, Partial<Association>>;
    /** What `spaces.count` answers: the spaces a former governor still governs. */
    governedCount?: number;
    /** What `associations.count` answers: the entities depending on a former governor. */
    children?: number;
    /** A failure of the write transaction (a trigger refusal). */
    writeFails?: unknown;
  }) {
    const update = jest.fn().mockResolvedValue(undefined);
    const save = jest.fn().mockImplementation(async (s: Partial<Space>) => s);
    const spaces = {
      findOne: jest.fn().mockResolvedValue(opts.space ?? null),
      count: jest.fn().mockResolvedValue(opts.governedCount ?? 0),
      update,
      create: jest.fn().mockImplementation((s: Partial<Space>) => s),
      save,
      find: jest.fn().mockResolvedValue(opts.spaceRows ?? []),
    } as unknown as Repository<Space>;
    const associations = {
      findOne: jest
        .fn()
        .mockImplementation(async ({ where }: { where: { id: string } }) =>
          opts.byId ? (opts.byId[where.id] ?? null) : (opts.association ?? null)
        ),
      count: jest.fn().mockResolvedValue(opts.children ?? 0),
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
      query: jest.fn(),
      find: jest
        .fn()
        .mockImplementation(async (entity: unknown) =>
          entity === Space ? (opts.governed ?? []) : (opts.rules ?? [])
        ),
    };
    const dataSource = {
      transaction: jest.fn().mockImplementation(async (cb: (m: unknown) => unknown) => {
        if (opts.writeFails) throw opts.writeFails;
        return cb(manager);
      }),
      // Every opened space of the two campuses; the star's BDE governs all of `bdeCampuses`. The
      // management predicate (does the star govern THIS entity) answers from the same campuses: a
      // rule of the entity on one of them reaches a governed space.
      query: jest.fn().mockImplementation(async (sql: string) => {
        if (sql === FORMER_PARENT_SEATS_SQL) return opts.formerParentSeats ?? [];
        if (sql === HOLDS_BDE_FLAG_OVER_SQL) {
          return [
            {
              holds:
                opts.governs ??
                (opts.rules ?? []).some(
                  (r) => r.campus != null && (opts.bdeCampuses ?? []).includes(r.campus)
                ),
            },
          ];
        }
        const campuses =
          sql === ENTITY_GOVERNOR_SPACE_STANDINGS_SQL
            ? (opts.parentCampuses ?? opts.bdeCampuses ?? [])
            : (opts.bdeCampuses ?? []);
        return SPACE_CAMPUSES.flatMap((campus) =>
          SPACE_FORMATIONS.map((formation) => ({
            formation,
            campus,
            governed: campuses.includes(campus),
          }))
        );
      }),
    } as unknown as DataSource;
    const redis = {
      incr: jest.fn().mockResolvedValue(1),
      deleteByPattern: jest.fn().mockResolvedValue(3),
    };
    return {
      service: new SpacesService(spaces, associations, audiences, dataSource, redis as never),
      save,
      manager,
      redis,
    };
  }

  /** The typed `code` a refused promise carries, or null when it resolved. */
  const codeOf = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return (e as { getResponse: () => { code: string } }).getResponse().code;
    }
    return null;
  };

  it('refuses a list as a governor and an unknown space or association', async () => {
    await expect(make({}).service.setBde('s', null, ACTOR)).rejects.toBeInstanceOf(
      NotFoundException
    );
    await expect(
      make({ space: { id: 's' } }).service.setBde('s', 'a', ACTOR)
    ).rejects.toBeInstanceOf(NotFoundException);
    const list = make({ space: { id: 's' }, association: { id: 'a', type: 'list' } });
    await expect(list.service.setBde('s', 'a', ACTOR)).rejects.toBeInstanceOf(BadRequestException);
    expect(await codeOf(list.service.setBde('s', 'a', ACTOR))).toBe(SPACE_GOVERNOR_TYPE);
  });

  it('designates and clears a governor, journaling each change with its admin (2.7)', async () => {
    const { service, manager } = make({
      space: { id: 's', formation: 'ICM', campus: 'saint-etienne', bdeAssociationId: null },
      association: { id: 'a', type: 'association', parentAssociationId: null },
    });
    await service.setBde('s', 'a', ACTOR);
    expect(manager.update).toHaveBeenCalledWith(Space, { id: 's' }, { bdeAssociationId: 'a' });
    expect(manager.query).toHaveBeenCalledWith(expect.stringContaining('dependency_journal'), [
      'space',
      's',
      null,
      'a',
      'admin-1',
      'admin',
    ]);
    const cleared = make({ space: { id: 's', bdeAssociationId: 'a' } });
    await cleared.service.setBde('s', null, ACTOR);
    expect(cleared.manager.update).toHaveBeenCalledWith(
      Space,
      { id: 's' },
      { bdeAssociationId: null }
    );
  });

  it('lets an INSTITUTION govern a space (D3, closes P10)', async () => {
    const { service, manager } = make({
      space: { id: 's', formation: 'PDIS', campus: 'gardanne', bdeAssociationId: null },
      association: { id: 'school', type: 'institution', parentAssociationId: null },
    });
    await service.setBde('s', 'school', ACTOR);
    expect(manager.update).toHaveBeenCalledWith(Space, { id: 's' }, { bdeAssociationId: 'school' });
  });

  it('refuses a governor that depends on a BDE (DEPENDENCY_CHILD_IS_A_BDE)', async () => {
    const { service, manager } = make({
      space: { id: 's', bdeAssociationId: null },
      association: { id: 'a', type: 'association', parentAssociationId: 'bde' },
    });
    expect(await codeOf(service.setBde('s', 'a', ACTOR))).toBe(DEPENDENCY_CHILD_IS_A_BDE);
    expect(manager.update).not.toHaveBeenCalled();
  });

  it('writes no rule when designating: governance and audience are decoupled (2.5)', async () => {
    const { service, manager } = make({
      space: { id: 's', formation: 'ICM', campus: 'gardanne', bdeAssociationId: null },
      association: { id: 'a', type: 'association', parentAssociationId: null },
      rules: [{ associationId: 'a', formation: 'ICM', campus: 'saint-etienne' }],
    });
    await service.setBde('s', 'a', ACTOR);
    expect(manager.insert).not.toHaveBeenCalled();
  });

  it('writes nothing, journal included, when the governor is unchanged', async () => {
    const { service, manager } = make({
      space: { id: 's', bdeAssociationId: 'a' },
      association: { id: 'a', type: 'association', parentAssociationId: null },
    });
    await service.setBde('s', 'a', ACTOR);
    expect(manager.update).not.toHaveBeenCalled();
    expect(manager.query).not.toHaveBeenCalled();
  });

  it('allows removing the last space of a BDE with children, and accuses it at WARN', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service, manager } = make({
      space: { id: 's', formation: 'ICM', campus: 'gardanne', bdeAssociationId: 'old' },
      governedCount: 0,
      children: 3,
    });
    await service.setBde('s', null, ACTOR);
    expect(manager.update).toHaveBeenCalledWith(Space, { id: 's' }, { bdeAssociationId: null });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('governs no space any more'));
    warn.mockRestore();
  });

  it('turns a trigger refusal into the same typed 409, and lets any other error through', async () => {
    const raced = make({
      space: { id: 's', bdeAssociationId: null },
      association: { id: 'a', type: 'association', parentAssociationId: null },
      writeFails: { code: '23514', constraint: DEPENDENCY_CHILD_IS_A_BDE },
    });
    const refused = raced.service.setBde('s', 'a', ACTOR);
    await expect(refused).rejects.toBeInstanceOf(ConflictException);
    expect(await codeOf(raced.service.setBde('s', 'a', ACTOR))).toBe(DEPENDENCY_CHILD_IS_A_BDE);
    const other = make({
      space: { id: 's', bdeAssociationId: null },
      association: { id: 'a', type: 'association', parentAssociationId: null },
      writeFails: new Error('connection reset'),
    });
    await expect(other.service.setBde('s', 'a', ACTOR)).rejects.toThrow('connection reset');
  });

  it('lets one association be the governor of several spaces', async () => {
    const { service, manager } = make({
      space: { id: 's', bdeAssociationId: null },
      association: { id: 'a', type: 'association', parentAssociationId: null },
    });
    await service.setBde('s1', 'a', ACTOR);
    await service.setBde('s2', 'a', ACTOR);
    expect(manager.update).toHaveBeenCalledTimes(2);
  });

  describe('setParent - the governing parent (2.2, 2.7)', () => {
    const BDE = { id: 'bde', type: 'association' as const, parentAssociationId: null };
    const CLUB = {
      id: 'club',
      type: 'association' as const,
      parentAssociationId: null,
      displayParentAssociationId: null,
    };
    /** `governing`: the ids the spaces table names as governors. */
    const withParents = (
      byId: Record<string, Partial<Association>>,
      governing: string[],
      extra: Parameters<typeof make>[0] = {}
    ) => {
      const made = make({ byId, ...extra });
      (made.service as unknown as { spaces: { find: jest.Mock } }).spaces.find = jest
        .fn()
        .mockResolvedValue(governing.map((id) => ({ bdeAssociationId: id })));
      return made;
    };

    it('sets a BDE as parent and journals it with the admin', async () => {
      const { service, manager } = withParents({ bde: BDE, club: CLUB }, ['bde']);
      await service.setParent('club', 'bde', ACTOR);
      expect(manager.update).toHaveBeenCalledWith(
        expect.anything(),
        { id: 'club' },
        { parentAssociationId: 'bde' }
      );
      expect(manager.query).toHaveBeenCalledWith(expect.stringContaining('dependency_journal'), [
        'entity',
        'club',
        null,
        'bde',
        'admin-1',
        'admin',
      ]);
    });

    it("names at WARN the child's rows the FORMER parent's officers hold, and revokes none (WP-D2)", async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        const other = { id: 'other', type: 'association' as const, parentAssociationId: null };
        const moved = withParents(
          { bde: BDE, other, club: { ...CLUB, parentAssociationId: 'bde' } },
          ['bde', 'other'],
          { formerParentSeats: [{ userId: 'officer-of-bde-1', permissions: 255 }] }
        );
        await moved.service.setParent('club', 'other', ACTOR);
        const query = (moved.service as unknown as { dataSource: { query: jest.Mock } }).dataSource
          .query;
        expect(query).toHaveBeenCalledWith(FORMER_PARENT_SEATS_SQL, ['club', 'bde', 1 << 6]);
        expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
          '[DEPENDENCY] club left parent bde: 1 member row(s) held by its MANAGE_ASSO holders stay - review them: officer-=255',
        ]);
        // Nothing is deleted: the only writes are the parent and its journal line.
        expect(moved.manager.delete).not.toHaveBeenCalled();

        // A first parent (none before) has no former officers to name.
        warn.mockClear();
        const first = withParents({ bde: BDE, club: CLUB }, ['bde'], {
          formerParentSeats: [{ userId: 'x', permissions: 1 }],
        });
        await first.service.setParent('club', 'bde', ACTOR);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    it.each([
      [
        'an institution as child',
        { club: { ...CLUB, type: 'institution' as const } },
        ['bde'],
        DEPENDENCY_INSTITUTION,
      ],
      ['a BDE as child', {}, ['bde', 'club'], DEPENDENCY_CHILD_IS_A_BDE],
      ['a parent governing nothing', {}, [], DEPENDENCY_PARENT_NOT_A_BDE],
      [
        'an institution governing a space as parent',
        { bde: { ...BDE, type: 'institution' as const } },
        ['bde'],
        DEPENDENCY_PARENT_NOT_A_BDE,
      ],
    ])('refuses %s, typed, before any write', async (_label, over, governing, code) => {
      const { service, manager } = withParents({ bde: BDE, club: CLUB, ...over }, governing);
      expect(await codeOf(service.setParent('club', 'bde', ACTOR))).toBe(code);
      expect(manager.update).not.toHaveBeenCalled();
    });

    // F4: an older client resending the parent it read, or a label-only edit, must not be judged on
    // a state it did not create - a row the triggers would refuse today (here: a parent governing
    // nothing) is left as it is, with no 409.
    it('judges only a change: an unchanged parent is never refused, a label-only edit goes through', async () => {
      const stale = { ...CLUB, parentAssociationId: 'bds' };
      const bds = { id: 'bds', type: 'association' as const, parentAssociationId: null };
      const same = withParents({ bds, club: stale }, []);
      await expect(same.service.setParent('club', 'bds', ACTOR)).resolves.toBeUndefined();
      expect(same.manager.update).not.toHaveBeenCalled();

      const label = withParents({ bds, club: stale }, []);
      await label.service.setParent('club', 'bds', ACTOR, 'bds');
      expect(label.manager.update).toHaveBeenCalledWith(
        expect.anything(),
        { id: 'club' },
        { displayParentAssociationId: 'bds' }
      );

      const moved = withParents({ bds, club: stale }, []);
      expect(await codeOf(moved.service.setParent('club', null, ACTOR))).toBeNull();
      const toNothing = withParents({ bds, club: { ...CLUB } }, []);
      expect(await codeOf(toNothing.service.setParent('club', 'bds', ACTOR))).toBe(
        DEPENDENCY_PARENT_NOT_A_BDE
      );
    });

    it('clears a parent, and writes nothing when nothing changes', async () => {
      const set = withParents({ club: { ...CLUB, parentAssociationId: 'bde' } }, ['bde']);
      await set.service.setParent('club', null, ACTOR);
      expect(set.manager.update).toHaveBeenCalledWith(
        expect.anything(),
        { id: 'club' },
        { parentAssociationId: null }
      );
      const same = withParents({ bde: BDE, club: { ...CLUB, parentAssociationId: 'bde' } }, [
        'bde',
      ]);
      await same.service.setParent('club', 'bde', ACTOR);
      expect(same.manager.update).not.toHaveBeenCalled();
      expect(same.manager.query).not.toHaveBeenCalled();
    });

    it('sets the G3 label, journaled as a label line, and refuses an invalid one', async () => {
      const bds = { id: 'bds', type: 'association' as const, parentAssociationId: 'bde' };
      const { service, manager } = withParents(
        { bde: BDE, bds, club: { ...CLUB, parentAssociationId: 'bde' } },
        ['bde']
      );
      await service.setParent('club', 'bde', ACTOR, 'bds');
      expect(manager.update).toHaveBeenCalledWith(
        expect.anything(),
        { id: 'club' },
        { displayParentAssociationId: 'bds' }
      );
      expect(manager.query).toHaveBeenCalledTimes(1);
      expect(manager.query).toHaveBeenCalledWith(expect.stringContaining('dependency_journal'), [
        'label',
        'club',
        null,
        'bds',
        'admin-1',
        'admin',
      ]);
      expect(await codeOf(service.setParent('club', 'bde', ACTOR, 'club'))).toBe(
        DEPENDENCY_LABEL_INVALID
      );
      expect(await codeOf(service.setParent('club', 'bde', ACTOR, 'nobody'))).toBe(
        DEPENDENCY_LABEL_INVALID
      );
    });
  });

  it('lists every entity with its parent and its mismatches (2.5)', async () => {
    const { service } = make({
      spaceRows: [
        { id: 'se-icm', formation: 'ICM', campus: 'saint-etienne', bdeAssociationId: 'bde' },
        { id: 'se-fsss', formation: 'FSSS', campus: 'saint-etienne', bdeAssociationId: 'fsss' },
      ],
      rules: [
        { associationId: 'inside', formation: 'ICM', campus: 'saint-etienne' },
        { associationId: 'wide', formation: null, campus: 'saint-etienne' },
      ],
    });
    (service as unknown as { associations: { find: jest.Mock } }).associations.find = jest
      .fn()
      .mockResolvedValue([
        { id: 'bde', name: 'BDE', type: 'association', parentAssociationId: null },
        { id: 'fsss', name: 'FSSS', type: 'association', parentAssociationId: null },
        { id: 'inside', name: 'In', type: 'association', parentAssociationId: 'bde' },
        { id: 'wide', name: 'Wide', type: 'association', parentAssociationId: 'bde' },
        { id: 'orphan', name: 'Orphan', type: 'list', parentAssociationId: 'gone' },
        { id: 'free', name: 'Free', type: 'list', parentAssociationId: null },
      ]);
    const views = new Map((await service.listDependencies()).map((v) => [v.id, v]));
    expect(views.get('bde')).toMatchObject({ governs: true, mismatches: [] });
    expect(views.get('inside')?.mismatches).toEqual([]);
    expect(views.get('wide')?.mismatches).toEqual(['reaches_outside_parent']);
    expect(views.get('orphan')?.mismatches).toEqual(['parent_missing']);
    expect(views.get('free')).toMatchObject({ governs: false, mismatches: [] });
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

  it('replaces the rules in one transaction, de-duplicated', async () => {
    const { service, manager } = make({ association: { id: 'a' } });
    await service.setAudiences(
      'a',
      [{ campus: 'saint-etienne' }, { campus: 'saint-etienne' }],
      ADMIN
    );
    expect(manager.delete).toHaveBeenCalled();
    expect(manager.insert).toHaveBeenCalledWith(expect.anything(), [
      { associationId: 'a', formation: null, campus: 'saint-etienne' },
    ]);
  });

  it('accepts an empty set: the association then reaches nobody', async () => {
    const { service, manager } = make({ association: { id: 'a' } });
    await expect(service.setAudiences('a', [], ADMIN)).resolves.toEqual([]);
    expect(manager.delete).toHaveBeenCalled();
    expect(manager.insert).not.toHaveBeenCalled();
  });

  it('stores what is submitted, never adding back the spaces it governs (2.5, WP-D1)', async () => {
    const { service, manager } = make({
      association: { id: 'a' },
      governed: [{ id: 's', formation: 'ICM', campus: 'gardanne' }],
    });
    const saved = await service.setAudiences('a', [{ campus: 'saint-etienne' }], ADMIN);
    expect(saved).toEqual([{ formation: null, campus: 'saint-etienne', editable: true }]);
    expect(manager.insert).toHaveBeenCalledWith(expect.anything(), [
      { associationId: 'a', formation: null, campus: 'saint-etienne' },
    ]);
  });

  it('drops every cached feed page when who an association reaches changes (WP6b)', async () => {
    // The list cache is keyed per reader and the rules decide which posts each reader gets, so a
    // rule change - by the grid or by designating a BDE - is a change to every reader's pages.
    const rules = make({ association: { id: 'a' } });
    await rules.service.setAudiences('a', [{ campus: 'gardanne' }], ADMIN);
    expect(rules.redis.deleteByPattern).toHaveBeenCalledWith('posts:list:v3:*');

    const bde = make({
      space: { id: 's', formation: 'ICM', campus: 'gardanne', bdeAssociationId: null },
      association: { id: 'a', type: 'association', parentAssociationId: null },
    });
    await bde.service.setBde('s', 'a', ACTOR);
    expect(bde.redis.deleteByPattern).toHaveBeenCalledWith('posts:list:v3:*');
  });

  it('does not drop the cache for a write it refused', async () => {
    const refused = make({});
    await expect(refused.service.setAudiences('a', [], ADMIN)).rejects.toBeInstanceOf(
      NotFoundException
    );
    expect(refused.redis.deleteByPattern).not.toHaveBeenCalled();
  });

  describe('the audience policy on every write (WP-A, user 2026-10-07)', () => {
    const code = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        return (e as { getResponse: () => { code: string } }).getResponse().code;
      }
      return null;
    };

    it('refuses an everyone rule on an association or a list, even from a global admin', async () => {
      for (const type of ['association', 'list']) {
        const { service, manager } = make({ association: { id: 'a', type: type as never } });
        expect(await code(service.setAudiences('a', [{ campus: null }], ADMIN))).toBe(
          'AUDIENCE_EVERYONE_INSTITUTION_ONLY'
        );
        // a formation across campuses is the same multi-campus audience
        expect(await code(service.setAudiences('a', [{ formation: 'ICM' }], ADMIN))).toBe(
          'AUDIENCE_EVERYONE_INSTITUTION_ONLY'
        );
        expect(manager.insert).not.toHaveBeenCalled();
      }
    });

    it('lets an institution address everyone', async () => {
      const { service } = make({ association: { id: 'i', type: 'institution' } });
      await expect(service.setAudiences('i', [{ campus: null }], ADMIN)).resolves.toEqual([
        { formation: null, campus: null, editable: true },
      ]);
    });

    it('lets a BDE star write the audience of an entity of its own campus', async () => {
      const { service, manager } = make({
        association: { id: 'a', type: 'association' },
        rules: [{ associationId: 'a', formation: null, campus: 'gardanne' }],
        bdeCampuses: ['gardanne'],
      });
      // The write answers in the read's shape, so the editor renders it with no second read.
      await expect(
        service.setAudiences('a', [{ formation: 'ICM', campus: 'gardanne' }], STAR)
      ).resolves.toEqual([{ formation: 'ICM', campus: 'gardanne', editable: true }]);
      expect(manager.insert).toHaveBeenCalledWith(AssociationAudience, [
        { associationId: 'a', formation: 'ICM', campus: 'gardanne' },
      ]);
    });

    it('refuses a BDE star on another campus, an everyone rule, an institution and an unruled entity', async () => {
      const own: Partial<AssociationAudience>[] = [
        { associationId: 'a', formation: null, campus: 'gardanne' },
      ];
      const other = make({
        association: { id: 'a', type: 'association' },
        rules: [{ associationId: 'a', formation: null, campus: 'saint-etienne' }],
        bdeCampuses: ['gardanne'],
      });
      expect(await code(other.service.setAudiences('a', [{ campus: 'gardanne' }], STAR))).toBe(
        'AUDIENCE_OUTSIDE_BDE_CAMPUS'
      );
      const beyond = make({
        association: { id: 'a', type: 'association' },
        rules: own,
        bdeCampuses: ['gardanne'],
      });
      // Governed, but the added rule leaves its spaces: the platform admin's to widen.
      expect(
        await code(beyond.service.setAudiences('a', [{ campus: 'saint-etienne' }], STAR))
      ).toBe('AUDIENCE_RULE_BEYOND_BDE_SPACES');
      expect(await code(beyond.service.setAudiences('a', [{ campus: null }], STAR))).toBe(
        'AUDIENCE_EVERYONE_INSTITUTION_ONLY'
      );
      const inst = make({
        association: { id: 'i', type: 'institution' },
        rules: own,
        bdeCampuses: ['gardanne'],
      });
      expect(await code(inst.service.setAudiences('i', [{ campus: 'gardanne' }], STAR))).toBe(
        'AUDIENCE_INSTITUTION_ADMIN_ONLY'
      );
      const unruled = make({
        association: { id: 'a', type: 'association' },
        rules: [],
        bdeCampuses: ['gardanne'],
      });
      expect(await code(unruled.service.setAudiences('a', [{ campus: 'gardanne' }], STAR))).toBe(
        'AUDIENCE_OUTSIDE_BDE_CAMPUS'
      );
      for (const r of [other, beyond, inst, unruled]) {
        expect(r.manager.insert).not.toHaveBeenCalled();
        expect(r.redis.deleteByPattern).not.toHaveBeenCalled();
      }
    });

    it('logs every refusal at WARN with its typed code, like the member ceiling', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        const beyond = make({
          association: { id: 'a', type: 'association' },
          rules: [{ associationId: 'a', formation: null, campus: 'gardanne' }],
          bdeCampuses: ['gardanne'],
        });
        await code(beyond.service.setAudiences('a', [{ campus: 'saint-etienne' }], STAR));
        await code(beyond.service.setAudiences('a', [{ campus: null }], ADMIN));
        expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
          '[AUDIENCE] write refused: association=a code=AUDIENCE_RULE_BEYOND_BDE_SPACES',
          '[AUDIENCE] write refused: association=a code=AUDIENCE_EVERYONE_INSTITUTION_ONLY',
        ]);
      } finally {
        warn.mockRestore();
      }
    });

    describe('reading the rules (user, 2026-10-08: the star reads its own campus only)', () => {
      const read = (o: Opts, actor = STAR) => make(o).service.getAudiencesFor('a', actor);
      type Opts = Parameters<typeof make>[0];
      const gardanne: Partial<AssociationAudience>[] = [
        { associationId: 'a', formation: null, campus: 'gardanne' },
      ];

      it('returns the rules to a BDE star for an entity of its own campus, and to an admin', async () => {
        const o: Opts = {
          association: { id: 'a', type: 'association' },
          rules: gardanne,
          bdeCampuses: ['gardanne'],
        };
        await expect(read(o)).resolves.toEqual([
          { formation: null, campus: 'gardanne', editable: true },
        ]);
        await expect(read({ ...o, bdeCampuses: [] }, ADMIN)).resolves.toEqual([
          { formation: null, campus: 'gardanne', editable: true },
        ]);
      });

      it("marks a rule beyond the star's spaces read-only, and still returns it", async () => {
        // A two-campus entity: the star governs gardanne only, so the saint-etienne rule is read,
        // never editable ("Lire tout, modifier dans ses espaces", owner 2026-11-03).
        const o: Opts = {
          association: { id: 'a', type: 'association' },
          rules: [
            { associationId: 'a', formation: null, campus: 'gardanne' },
            { associationId: 'a', formation: null, campus: 'saint-etienne' },
          ],
          bdeCampuses: ['gardanne'],
        };
        await expect(read(o)).resolves.toEqual([
          { formation: null, campus: 'gardanne', editable: true },
          { formation: null, campus: 'saint-etienne', editable: false },
        ]);
      });

      it('refuses another campus, an institution and a caller who is not a star', async () => {
        const base: Opts = { association: { id: 'a', type: 'association' }, rules: gardanne };
        expect(await code(read({ ...base, bdeCampuses: ['saint-etienne'] }))).toBe(
          'AUDIENCE_OUTSIDE_BDE_CAMPUS'
        );
        expect(
          await code(
            read({
              ...base,
              association: { id: 'a', type: 'institution' },
              bdeCampuses: ['gardanne'],
            })
          )
        ).toBe('AUDIENCE_INSTITUTION_ADMIN_ONLY');
        expect(await code(read({ ...base, bdeCampuses: [] }))).toBe(
          'AUDIENCE_ADMIN_OR_BDE_REQUIRED'
        );
      });
    });

    describe('governance by PARENT (WP-D2, G8)', () => {
      const wide: Partial<AssociationAudience>[] = [
        { associationId: 'a', formation: null, campus: 'gardanne' },
      ];

      it('refuses a BDE whose spaces the entity reaches but which is not its parent, and shows it read-only', async () => {
        // The shared-campus case: the star governs gardanne, the entity reaches it, its parent is
        // another BDE - read, never written.
        const o = {
          association: { id: 'a', type: 'association' as const },
          rules: wide,
          bdeCampuses: ['gardanne'],
          governs: false,
        };
        expect(await code(make(o).service.setAudiences('a', [{ campus: 'gardanne' }], STAR))).toBe(
          'AUDIENCE_OUTSIDE_BDE_CAMPUS'
        );
        await expect(make(o).service.getAudiencesFor('a', STAR)).resolves.toEqual([
          { formation: null, campus: 'gardanne', editable: false },
        ]);
      });

      it("writes inside the PARENT's spaces only, though the star manages a BDE elsewhere too", async () => {
        const o = {
          association: { id: 'a', type: 'list' as const },
          rules: wide,
          bdeCampuses: ['gardanne', 'saint-etienne'],
          parentCampuses: ['gardanne'],
          governs: true,
        };
        const { service, manager } = make(o);
        expect(
          await code(
            service.setAudiences('a', [{ campus: 'gardanne' }, { campus: 'saint-etienne' }], STAR)
          )
        ).toBe('AUDIENCE_RULE_BEYOND_BDE_SPACES');
        expect(manager.insert).not.toHaveBeenCalled();
        await expect(
          make(o).service.setAudiences('a', [{ formation: 'ICM', campus: 'gardanne' }], STAR)
        ).resolves.toEqual([{ formation: 'ICM', campus: 'gardanne', editable: true }]);
      });

      it('lets a parent read its child reaching outside its campus, and leaves the rule outside it to the admin', async () => {
        const o = {
          association: { id: 'a', type: 'association' as const },
          rules: [
            { associationId: 'a', formation: 'ICM' as const, campus: 'saint-etienne' as const },
          ],
          bdeCampuses: ['gardanne'],
          governs: true,
        };
        await expect(make(o).service.getAudiencesFor('a', STAR)).resolves.toEqual([
          { formation: 'ICM', campus: 'saint-etienne', editable: false },
        ]);
        // Removing that rule is beyond its spaces: the platform admin's.
        expect(await code(make(o).service.setAudiences('a', [], STAR))).toBe(
          'AUDIENCE_RULE_BEYOND_BDE_SPACES'
        );
      });
    });

    it('refuses a caller who is neither a global admin nor a BDE star', async () => {
      const { service } = make({
        association: { id: 'a', type: 'association' },
        rules: [{ associationId: 'a', formation: null, campus: 'gardanne' }],
        bdeCampuses: [],
      });
      await expect(
        service.setAudiences('a', [{ campus: 'gardanne' }], STAR)
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(await code(service.setAudiences('a', [{ campus: 'gardanne' }], STAR))).toBe(
        'AUDIENCE_ADMIN_OR_BDE_REQUIRED'
      );
    });
  });
});
