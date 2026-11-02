import { HttpException, Logger } from '@nestjs/common';
import { AssociationsService } from './associations.service';
import { HOLDS_BDE_FLAG_OVER_SQL } from '../spaces/bde';
import {
  ALL_PERMISSION_FLAGS,
  AssociationPermissionFlag,
  SUPER_ADMIN_EXCLUDED_FLAGS,
} from './entities/association-member.entity';
import {
  INSTITUTION_MEMBERS_ADMIN_ONLY,
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
    // The last-admin guard counts the managers; two keeps it out of these cases.
    createQueryBuilder: jest.fn(() => {
      const qb = {
        where: () => qb,
        andWhere: () => qb,
        getCount: () => Promise.resolve(2),
      };
      return qb;
    }),
    update,
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
  return { service, update };
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
      manager: { query: jest.fn(() => Promise.resolve([])) },
      create: created,
      save: jest.fn((row: unknown) => Promise.resolve(row)),
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
    expect(auditLines()).toEqual([expect.stringContaining('POST_AS_ASSO|MANAGE_PAYOUT_ACCOUNT')]);
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
    ).toBe(INSTITUTION_MEMBERS_ADMIN_ONLY);
    expect(
      await settle(service.updateMemberRole(SCHOOL, 'target', 'Directeur', undefined, { granter }))
    ).toBe(INSTITUTION_MEMBERS_ADMIN_ONLY);
    expect(await settle(service.removeMember(SCHOOL, 'target', { granter }))).toBe(
      INSTITUTION_MEMBERS_ADMIN_ONLY
    );
    expect(update).not.toHaveBeenCalled();
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
});
