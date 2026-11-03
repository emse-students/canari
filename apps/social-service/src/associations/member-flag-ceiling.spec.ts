import { HttpException, Logger } from '@nestjs/common';
import { AssociationsService } from './associations.service';
import { HOLDS_BDE_FLAG_OVER_SQL } from '../spaces/bde';
import {
  ALL_PERMISSION_FLAGS,
  AssociationPermissionFlag,
  SUPER_ADMIN_EXCLUDED_FLAGS,
} from './entities/association-member.entity';
import { ADMIN_ASSOCIATION_ERROR } from './admin-catalogue';
import {
  LAST_MEMBER_MANAGER,
  MEMBER_FLAGS_BEYOND_GRANTER,
  flagNames,
  flagsBeyondCeiling,
  grantCeiling,
} from './member-flag-ceiling';

/**
 * THE GRANT CEILING: an ordinary member changes only the flags it holds itself, on add and on
 * update; the platform admin and a BDE super-admin are uncapped, the latter audited when it writes
 * an excluded flag; an institution's members are the platform admin's alone. The pure rule is tested
 * first, then the service, so a write path that forgot to ask it fails here.
 */
const {
  POST_AS_ASSO,
  PROPOSE_EVENT,
  MANAGE_MEMBERS,
  MANAGE_FORMS,
  MANAGE_DOCUMENTS,
  MANAGE_PAYOUT_ACCOUNT,
  MANAGE_PRODUCTS,
  MANAGE_ASSO,
} = AssociationPermissionFlag;

describe('grantCeiling', () => {
  it('gives the platform administrator every flag', () => {
    expect(grantCeiling({ isGlobalAdmin: true, isSuperAdminOf: false, ownPermissions: 0 })).toBe(
      ALL_PERMISSION_FLAGS
    );
  });

  it('caps an ordinary member at its own row', () => {
    const own = MANAGE_MEMBERS | MANAGE_FORMS;
    expect(grantCeiling({ isGlobalAdmin: false, isSuperAdminOf: false, ownPermissions: own })).toBe(
      own
    );
  });

  it('leaves a super-admin uncapped, the excluded flags included (owner, 2026-11-02)', () => {
    const ceiling = grantCeiling({ isGlobalAdmin: false, isSuperAdminOf: true, ownPermissions: 0 });
    expect(ceiling).toBe(ALL_PERMISSION_FLAGS);
    expect(ceiling & SUPER_ADMIN_EXCLUDED_FLAGS).toBe(SUPER_ADMIN_EXCLUDED_FLAGS);
  });
});

describe('flagNames', () => {
  it('names the bits of a mask', () => {
    expect(flagNames(POST_AS_ASSO | MANAGE_PAYOUT_ACCOUNT)).toEqual([
      'POST_AS_ASSO',
      'MANAGE_PAYOUT_ACCOUNT',
    ]);
  });
});

describe('flagsBeyondCeiling', () => {
  it('counts a granted bit and a revoked bit alike, and an untouched bit not at all', () => {
    const ceiling = MANAGE_MEMBERS;
    expect(flagsBeyondCeiling(ceiling, 0, POST_AS_ASSO)).toBe(POST_AS_ASSO);
    expect(flagsBeyondCeiling(ceiling, POST_AS_ASSO, 0)).toBe(POST_AS_ASSO);
    expect(flagsBeyondCeiling(ceiling, POST_AS_ASSO, POST_AS_ASSO | MANAGE_MEMBERS)).toBe(0);
  });
});

interface Row {
  userId: string;
  associationId: string;
  permissions: number;
  /** The associations this row's BDE governs (its spaces reach them), as in the may-act spec. */
  governs?: string[];
}

const ASSO = '11111111-1111-4111-8111-111111111111';
const SCHOOL = '22222222-2222-4222-8222-222222222222';
const BDE = '33333333-3333-4333-8333-333333333333';

function makeService(rows: Row[]) {
  const kinds: Record<string, string> = { [ASSO]: 'association', [SCHOOL]: 'institution' };
  kinds[BDE] = 'association';
  const assoRepo = {
    findOne: jest.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve(kinds[where.id] ? { id: where.id, type: kinds[where.id] } : null)
    ),
  };
  const update = jest.fn(() => Promise.resolve({ affected: 1 }));
  const remove = jest.fn(() => Promise.resolve({ affected: 1 }));
  const memberRepo = {
    findOne: jest.fn(({ where }: { where: { associationId: string; userId: string } }) =>
      Promise.resolve(
        rows.find((r) => r.userId === where.userId && r.associationId === where.associationId) ??
          null
      )
    ),
    count: jest.fn(() => Promise.resolve(rows.length)),
    query: jest.fn((sql: string, params: unknown[]) => {
      if (sql !== HOLDS_BDE_FLAG_OVER_SQL) return Promise.reject(new Error('unexpected query'));
      const [userId, associationId, flag] = params as [string, string, number];
      const holds = rows.some(
        (r) =>
          r.userId === userId &&
          (r.governs ?? []).includes(associationId) &&
          (r.permissions & flag) !== 0
      );
      return Promise.resolve([{ holds }]);
    }),
    // The last-admin guard counts the association's MANAGE_MEMBERS holders, from the rows. An add
    // reads the roster's last sort order before `insertMembership` judges the granter.
    createQueryBuilder: jest.fn(() => {
      let associationId = '';
      const qb = {
        select: () => qb,
        where: (_sql: string, params?: { associationId?: string }) => {
          associationId = params?.associationId ?? associationId;
          return qb;
        },
        andWhere: () => qb,
        getCount: () =>
          Promise.resolve(
            rows.filter(
              (r) => r.associationId === associationId && (r.permissions & MANAGE_MEMBERS) !== 0
            ).length
          ),
        getRawOne: () => Promise.resolve({ max: 0 }),
      };
      return qb;
    }),
    update,
    delete: remove,
  };

  // POSITIONAL, AND FOURTEEN LONG - keep aligned with the constructor in `associations.service.ts`.
  const service = new AssociationsService(
    assoRepo as never, // assoRepo
    memberRepo as never, // memberRepo
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
  // A removal sweeps the feed caches; that sweep is not this spec's subject.
  jest
    .spyOn(
      service as unknown as { invalidatePostListCaches: () => Promise<void> },
      'invalidatePostListCaches'
    )
    .mockResolvedValue(undefined);
  return { service, update, remove };
}

/** A refusal's typed code, or the outcome itself when the call did not throw a typed one. */
const codeOf = (e: unknown): unknown =>
  (e instanceof HttpException ? (e.getResponse() as { code?: unknown }).code : undefined) ?? e;

const settle = (p: Promise<unknown>) =>
  p.then(
    () => 'written',
    (e: unknown) => codeOf(e)
  );

/** A BDE member holding MANAGE_ASSO whose BDE governs ASSO and SCHOOL, and a member of neither. */
const superAdmin: Row = {
  userId: 'bde-admin',
  associationId: BDE,
  permissions: MANAGE_ASSO | MANAGE_MEMBERS,
  governs: [ASSO, SCHOOL],
};
const SUPER = { userId: 'bde-admin', isGlobalAdmin: false };
const PLATFORM = { userId: 'platform-admin', isGlobalAdmin: true };

let logSpy: jest.SpyInstance;
beforeAll(() => {
  for (const level of ['warn', 'debug'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
  logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
beforeEach(() => logSpy.mockClear());
afterAll(() => jest.restoreAllMocks());

/** The audit lines written so far, as strings. */
const auditLines = () =>
  logSpy.mock.calls
    .map((c: unknown[]) => String(c[0]))
    .filter((line: string) => line.includes('a BDE super-admin granted'));

describe('AssociationsService - the grant ceiling on a member write', () => {
  it.each([
    ['POST_AS_ASSO', POST_AS_ASSO],
    ['MANAGE_PAYOUT_ACCOUNT', MANAGE_PAYOUT_ACCOUNT],
    // Not excluded from inheritance, but an explicit row of it makes its holder one of the
    // association's own managers - the standing that accepts a list's payment delegation.
    ['MANAGE_PRODUCTS', MANAGE_PRODUCTS],
  ])('lets a super-admin grant itself %s, and audits it with no user id', async (name, flag) => {
    const { service, update } = makeService([
      superAdmin,
      { userId: 'bde-admin', associationId: ASSO, permissions: 0 },
    ]);
    expect(
      await settle(service.updateMemberRole(ASSO, 'bde-admin', undefined, flag, { granter: SUPER }))
    ).toBe('written');
    expect(update).toHaveBeenCalledTimes(1);
    const lines = auditLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(name);
    expect(lines[0]).toContain(ASSO);
    expect(lines[0]).not.toContain('bde-admin');
  });

  it('audits a super-admin ADDING itself with every right', async () => {
    const { service } = makeService([superAdmin]);
    const created = jest.fn((row: unknown) => row);
    Object.assign((service as unknown as { memberRepo: object }).memberRepo, {
      manager: {
        query: jest.fn(() => Promise.resolve([])),
        create: (_entity: unknown, row: unknown) => created(row),
        save: jest.fn((row: unknown) => Promise.resolve(row)),
      },
    });
    // The add's own plumbing (cohort, sort order, feed sweep) is not this spec's subject.
    jest
      .spyOn(
        service as unknown as { invalidatePostListCaches: () => Promise<void> },
        'invalidatePostListCaches'
      )
      .mockResolvedValue(undefined);
    const qb = { select: () => qb, where: () => qb, getRawOne: () => Promise.resolve({ max: 0 }) };
    Object.assign((service as unknown as { memberRepo: object }).memberRepo, {
      createQueryBuilder: () => qb,
    });
    const outcome = await settle(
      service.addMember(
        {
          associationId: ASSO,
          userId: 'bde-admin',
          role: 'Presidente',
          permissions: ALL_PERMISSION_FLAGS,
        },
        SUPER
      )
    );
    expect(outcome).toBe('written');
    expect(created).toHaveBeenCalledWith(
      expect.objectContaining({ permissions: ALL_PERMISSION_FLAGS })
    );
    expect(auditLines()).toEqual([
      expect.stringContaining('POST_AS_ASSO|MANAGE_PRODUCTS|MANAGE_PAYOUT_ACCOUNT'),
    ]);
  });

  it('writes no audit line for a super-admin granting an administration flag', async () => {
    const { service, update } = makeService([
      superAdmin,
      { userId: 'target', associationId: ASSO, permissions: 0 },
    ]);
    expect(
      await settle(
        service.updateMemberRole(ASSO, 'target', undefined, MANAGE_MEMBERS | MANAGE_FORMS, {
          granter: SUPER,
        })
      )
    ).toBe('written');
    expect(update).toHaveBeenCalledTimes(1);
    expect(auditLines()).toEqual([]);
  });

  it('refuses a member granting a flag it lacks', async () => {
    const { service, update } = makeService([
      { userId: 'sec', associationId: ASSO, permissions: MANAGE_MEMBERS | MANAGE_FORMS },
      { userId: 'target', associationId: ASSO, permissions: 0 },
    ]);
    const granter = { userId: 'sec', isGlobalAdmin: false };
    expect(
      await settle(
        service.updateMemberRole(ASSO, 'target', undefined, MANAGE_FORMS | POST_AS_ASSO, {
          granter,
        })
      )
    ).toBe(MEMBER_FLAGS_BEYOND_GRANTER);
    expect(
      await settle(
        service.addMember(
          { associationId: ASSO, userId: 'new', role: 'x', permissions: MANAGE_DOCUMENTS },
          granter
        )
      )
    ).toBe(MEMBER_FLAGS_BEYOND_GRANTER);
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses a member revoking a flag it lacks, and keeps it untouched otherwise', async () => {
    const treasurer = MANAGE_PAYOUT_ACCOUNT | PROPOSE_EVENT;
    const { service, update } = makeService([
      { userId: 'sec', associationId: ASSO, permissions: MANAGE_MEMBERS | PROPOSE_EVENT },
      { userId: 'treasurer', associationId: ASSO, permissions: treasurer },
    ]);
    const granter = { userId: 'sec', isGlobalAdmin: false };
    expect(
      await settle(
        service.updateMemberRole(ASSO, 'treasurer', undefined, PROPOSE_EVENT, { granter })
      )
    ).toBe(MEMBER_FLAGS_BEYOND_GRANTER);
    // The same granter may still change the bit it holds, the payout right riding along unchanged.
    expect(
      await settle(
        service.updateMemberRole(ASSO, 'treasurer', undefined, MANAGE_PAYOUT_ACCOUNT, { granter })
      )
    ).toBe('written');
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('lets a member pass on a flag it holds', async () => {
    const { service } = makeService([
      { userId: 'sec', associationId: ASSO, permissions: MANAGE_MEMBERS | MANAGE_FORMS },
      // Already a member: the add passes the ceiling and stops at the next check, by design.
      { userId: 'new', associationId: ASSO, permissions: 0 },
    ]);
    const outcome = await settle(
      service.addMember(
        { associationId: ASSO, userId: 'new', role: 'x', permissions: MANAGE_FORMS },
        { userId: 'sec', isGlobalAdmin: false }
      )
    );
    expect(outcome).toBeInstanceOf(HttpException);
    expect((outcome as HttpException).message).toBe('User is already a member');
  });

  it('leaves the platform administrator unrestricted', async () => {
    const { service, update } = makeService([
      { userId: 'target', associationId: ASSO, permissions: 0 },
    ]);
    expect(
      await settle(
        service.updateMemberRole(ASSO, 'target', undefined, ALL_PERMISSION_FLAGS, {
          granter: PLATFORM,
        })
      )
    ).toBe('written');
    expect(update).toHaveBeenCalledTimes(1);
  });
});

describe("AssociationsService - an institution's members are the platform admin's", () => {
  const rows = (): Row[] => [
    superAdmin,
    { userId: 'staff', associationId: SCHOOL, permissions: ALL_PERMISSION_FLAGS },
    { userId: 'target', associationId: SCHOOL, permissions: 0 },
  ];

  it.each([
    ['a member holding every flag', { userId: 'staff', isGlobalAdmin: false }],
    ['a BDE super-admin governing it', SUPER],
  ])('refuses add, update and remove by %s', async (_who, granter) => {
    const { service, update } = makeService(rows());
    expect(
      await settle(
        service.addMember(
          { associationId: SCHOOL, userId: 'new', role: 'x', permissions: 0 },
          granter
        )
      )
    ).toBe(ADMIN_ASSOCIATION_ERROR.INSTITUTION_MEMBERS_PLATFORM_ONLY);
    expect(
      await settle(service.updateMemberRole(SCHOOL, 'target', 'Directeur', undefined, { granter }))
    ).toBe(ADMIN_ASSOCIATION_ERROR.INSTITUTION_MEMBERS_PLATFORM_ONLY);
    expect(await settle(service.removeMember(SCHOOL, 'target', { granter }))).toBe(
      ADMIN_ASSOCIATION_ERROR.INSTITUTION_MEMBERS_PLATFORM_ONLY
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('lets a member of it leave: leaving writes no right onto anyone', async () => {
    const { service, remove } = makeService(rows());
    expect(
      await settle(
        service.removeMember(SCHOOL, 'target', {
          granter: { userId: 'target', isGlobalAdmin: false },
        })
      )
    ).toBe('written');
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('lets the platform administrator write one', async () => {
    const { service } = makeService(rows());
    expect(
      await settle(
        service.updateMemberRole(SCHOOL, 'target', undefined, POST_AS_ASSO | PROPOSE_EVENT, {
          granter: PLATFORM,
        })
      )
    ).toBe('written');
  });

  it('refuses even the platform administrator handing MANAGE_MEMBERS, and lets it take one back', async () => {
    const { service, update } = makeService([
      ...rows(),
      { userId: 'old-manager', associationId: SCHOOL, permissions: MANAGE_MEMBERS | POST_AS_ASSO },
    ]);
    expect(
      await settle(
        service.updateMemberRole(SCHOOL, 'target', undefined, MANAGE_MEMBERS, {
          granter: PLATFORM,
        })
      )
    ).toBe(ADMIN_ASSOCIATION_ERROR.INSTITUTION_MEMBERS_PLATFORM_ONLY);
    expect(update).not.toHaveBeenCalled();
    // An older row holding it: an edit that KEEPS it is no grant, and revoking it is free.
    expect(
      await settle(
        service.updateMemberRole(SCHOOL, 'old-manager', undefined, POST_AS_ASSO, {
          granter: PLATFORM,
        })
      )
    ).toBe('written');
  });
});

describe('AssociationsService - removing a member is a revocation of everything it holds', () => {
  const treasurer = MANAGE_PAYOUT_ACCOUNT | POST_AS_ASSO;
  const rows = (): Row[] => [
    superAdmin,
    { userId: 'sec', associationId: ASSO, permissions: MANAGE_MEMBERS },
    { userId: 'treasurer', associationId: ASSO, permissions: treasurer },
  ];

  it('refuses a member removing someone holding a flag it lacks', async () => {
    const { service, remove } = makeService(rows());
    expect(
      await settle(
        service.removeMember(ASSO, 'treasurer', {
          granter: { userId: 'sec', isGlobalAdmin: false },
        })
      )
    ).toBe(MEMBER_FLAGS_BEYOND_GRANTER);
    expect(remove).not.toHaveBeenCalled();
  });

  it('lets a super-admin remove them', async () => {
    const { service, remove } = makeService(rows());
    expect(await settle(service.removeMember(ASSO, 'treasurer', { granter: SUPER }))).toBe(
      'written'
    );
    expect(remove).toHaveBeenCalledWith({ id: undefined, permissions: treasurer });
  });

  it('lets the platform administrator remove them', async () => {
    const { service, remove } = makeService(rows());
    expect(await settle(service.removeMember(ASSO, 'treasurer', { granter: PLATFORM }))).toBe(
      'written'
    );
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('lets a member leave whatever it holds', async () => {
    const { service, remove } = makeService(rows());
    expect(
      await settle(
        service.removeMember(ASSO, 'treasurer', {
          granter: { userId: 'treasurer', isGlobalAdmin: false },
        })
      )
    ).toBe('written');
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('lets a member remove someone within its own flags', async () => {
    const { service } = makeService([
      ...rows(),
      { userId: 'plain', associationId: ASSO, permissions: 0 },
    ]);
    expect(
      await settle(
        service.removeMember(ASSO, 'plain', { granter: { userId: 'sec', isGlobalAdmin: false } })
      )
    ).toBe('written');
  });
});

describe('AssociationsService.leaveAssociation - the "Quitter" button (owner, 2026-11-03)', () => {
  it('lets an ordinary member leave, without asking anyone', async () => {
    const { service, remove } = makeService([
      { userId: 'pres', associationId: ASSO, permissions: MANAGE_MEMBERS },
      { userId: 'plain', associationId: ASSO, permissions: PROPOSE_EVENT },
    ]);
    expect(await settle(service.leaveAssociation(ASSO, 'plain'))).toBe('written');
    expect(remove).toHaveBeenCalledWith({ id: undefined, permissions: PROPOSE_EVENT });
  });

  it("lets a member of an institution leave, though its members are the platform admin's", async () => {
    const { service, remove } = makeService([
      { userId: 'staff', associationId: SCHOOL, permissions: POST_AS_ASSO },
    ]);
    expect(await settle(service.leaveAssociation(SCHOOL, 'staff'))).toBe('written');
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('refuses the last holder of MANAGE_MEMBERS, typed', async () => {
    const { service, remove } = makeService([
      { userId: 'pres', associationId: ASSO, permissions: MANAGE_MEMBERS | PROPOSE_EVENT },
      { userId: 'plain', associationId: ASSO, permissions: 0 },
    ]);
    expect(await settle(service.leaveAssociation(ASSO, 'pres'))).toBe(LAST_MEMBER_MANAGER);
    expect(remove).not.toHaveBeenCalled();
  });

  it('refuses the last holder even when it is also the BDE super-admin of the association', async () => {
    const { service, remove } = makeService([
      superAdmin,
      { userId: 'bde-admin', associationId: ASSO, permissions: MANAGE_MEMBERS },
    ]);
    expect(await settle(service.leaveAssociation(ASSO, 'bde-admin'))).toBe(LAST_MEMBER_MANAGER);
    expect(remove).not.toHaveBeenCalled();
  });

  it('acts on the caller only: a non-member leaving touches nobody', async () => {
    const { service, remove } = makeService([
      { userId: 'pres', associationId: ASSO, permissions: MANAGE_MEMBERS },
    ]);
    const outcome = await settle(service.leaveAssociation(ASSO, 'stranger'));
    expect(outcome).toBeInstanceOf(HttpException);
    expect((outcome as HttpException).getStatus()).toBe(404);
    expect(remove).not.toHaveBeenCalled();
  });
});

/**
 * PEER DEPOSITION AND THE PASSATION (owner, 2026-11-03): "Tout ce qui concerne une passation doit
 * pouvoir se faire sans admin plateforme. Si le secretaire veut ajouter et mettre les permissions au
 * nouveau secretaire (respectivement president, tresorier...) puis se retirer, il faut que ce soit
 * faisable." No platform admin and no BDE appear below.
 */
describe('AssociationsService - a passation needs no platform admin (owner, 2026-11-03)', () => {
  const SECRETARY = MANAGE_MEMBERS | MANAGE_FORMS | PROPOSE_EVENT;

  it('the secretary adds the new secretary with its own flags, then leaves', async () => {
    const rows: Row[] = [
      { userId: 'old-sec', associationId: ASSO, permissions: SECRETARY },
      { userId: 'pres', associationId: ASSO, permissions: PROPOSE_EVENT },
    ];
    const { service, remove } = makeService(rows);
    Object.assign((service as unknown as { memberRepo: object }).memberRepo, {
      manager: {
        query: jest.fn(() => Promise.resolve([])),
        create: (_entity: unknown, row: unknown) => row,
        // The added row is on the roster from here on, so the leave counts it as a manager.
        save: jest.fn((row: Row) => {
          rows.push(row);
          return Promise.resolve(row);
        }),
      },
    });
    const granter = { userId: 'old-sec', isGlobalAdmin: false };
    expect(
      await settle(
        service.addMember(
          { associationId: ASSO, userId: 'new-sec', role: 'Secretaire', permissions: SECRETARY },
          granter
        )
      )
    ).toBe('written');
    expect(rows.find((r) => r.userId === 'new-sec')?.permissions).toBe(SECRETARY);
    expect(await settle(service.leaveAssociation(ASSO, 'old-sec'))).toBe('written');
    expect(remove).toHaveBeenCalledWith({ id: undefined, permissions: SECRETARY });
  });

  it('a member manager removes MANAGE_MEMBERS from the president, who is not the last holder', async () => {
    const { service, update } = makeService([
      { userId: 'sec', associationId: ASSO, permissions: MANAGE_MEMBERS | PROPOSE_EVENT },
      { userId: 'pres', associationId: ASSO, permissions: MANAGE_MEMBERS | PROPOSE_EVENT },
    ]);
    expect(
      await settle(
        service.updateMemberRole(ASSO, 'pres', undefined, PROPOSE_EVENT, {
          granter: { userId: 'sec', isGlobalAdmin: false },
        })
      )
    ).toBe('written');
    expect(update).toHaveBeenCalledTimes(1);
  });
});
