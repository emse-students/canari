import { AssociationsService } from './associations.service';
import {
  AssociationPermissionFlag,
  SUPER_ADMIN_EXCLUDED_FLAGS,
} from './entities/association-member.entity';

/**
 * `mayAct` is THE association permission predicate, so the three tiers it folds in are tested
 * against the real implementation rather than a mock: the platform administrator, the
 * cross-association super-admin, and the association's own bitmask.
 *
 * Every call site was measured on 2026-08-26 and there were four different spellings of this
 * question; two forgot the super-admin entirely. See `docs/wiki/permissions.md`.
 */
interface Row {
  userId: string;
  associationId: string;
  permissions: number;
  isBDE?: boolean;
}

function makeService(rows: Row[]) {
  /**
   * Only `callerHasAnyBdeFlag`'s query builder is modelled - it is the one `mayAct` reaches. The
   * bound parameters are collected from every `where`/`andWhere` call, then the count is computed
   * from the seeded rows.
   */
  const createQueryBuilder = jest.fn(() => {
    const params: Record<string, unknown> = {};
    const chain = {
      innerJoin: jest.fn(() => chain),
      where: jest.fn((_sql: string, p?: Record<string, unknown>) => {
        Object.assign(params, p ?? {});
        return chain;
      }),
      andWhere: jest.fn((_sql: string, p?: Record<string, unknown>) => {
        Object.assign(params, p ?? {});
        return chain;
      }),
      getCount: jest.fn(() =>
        Promise.resolve(
          rows.filter(
            (r) =>
              r.userId === params.userId &&
              r.isBDE === true &&
              (r.permissions & (params.flag as number)) !== 0
          ).length
        )
      ),
    };
    return chain;
  });

  const memberRepo = {
    findOne: jest.fn(({ where }: { where: { associationId: string; userId: string } }) =>
      Promise.resolve(
        rows.find((r) => r.userId === where.userId && r.associationId === where.associationId) ??
          null
      )
    ),
    /**
     * `mayActOnAny`'s batch read. TypeORM hands the ids over as an `In(...)` operator, so the
     * seeded rows are filtered against its `value`, exactly as the driver would.
     */
    find: jest.fn(({ where }: { where: { userId: string; associationId: { value: string[] } } }) =>
      Promise.resolve(
        rows.filter(
          (r) => r.userId === where.userId && where.associationId.value.includes(r.associationId)
        )
      )
    ),
    createQueryBuilder,
  };

  const service = new AssociationsService(
    undefined as never,
    memberRepo as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined,
    undefined
  );
  return { service, memberRepo };
}

const { MANAGE_MEMBERS, MANAGE_ASSO, MANAGE_FORMS, MANAGE_STRIPE_CONNECT, POST_AS_ASSO } =
  AssociationPermissionFlag;

describe('AssociationsService.mayAct', () => {
  it('grants a platform administrator a right they hold in no association', async () => {
    const { service } = makeService([]);
    await expect(
      service.mayAct('admin', 'asso1', MANAGE_MEMBERS, { isGlobalAdmin: true })
    ).resolves.toBe(true);
  });

  it('does not consult the member table for a platform administrator', async () => {
    const { service, memberRepo } = makeService([]);
    await service.mayAct('admin', 'asso1', MANAGE_MEMBERS, { isGlobalAdmin: true });
    expect(memberRepo.findOne).not.toHaveBeenCalled();
    expect(memberRepo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('refuses a stranger to the association', async () => {
    const { service } = makeService([]);
    await expect(service.mayAct('nobody', 'asso1', MANAGE_MEMBERS)).resolves.toBe(false);
  });

  it('grants a member holding the flag', async () => {
    const { service } = makeService([
      { userId: 'u1', associationId: 'asso1', permissions: MANAGE_MEMBERS },
    ]);
    await expect(service.mayAct('u1', 'asso1', MANAGE_MEMBERS)).resolves.toBe(true);
  });

  it('refuses a member holding a different flag', async () => {
    const { service } = makeService([
      { userId: 'u1', associationId: 'asso1', permissions: MANAGE_FORMS },
    ]);
    await expect(service.mayAct('u1', 'asso1', MANAGE_MEMBERS)).resolves.toBe(false);
  });

  it('grants a BDE super-admin on an association they are not a member of', async () => {
    const { service } = makeService([
      { userId: 'bde', associationId: 'bde-asso', permissions: MANAGE_ASSO, isBDE: true },
    ]);
    await expect(service.mayAct('bde', 'asso1', MANAGE_MEMBERS)).resolves.toBe(true);
  });

  it('does not grant MANAGE_ASSO outside a BDE association', async () => {
    const { service } = makeService([
      { userId: 'u1', associationId: 'club', permissions: MANAGE_ASSO, isBDE: false },
    ]);
    await expect(service.mayAct('u1', 'asso1', MANAGE_MEMBERS)).resolves.toBe(false);
  });

  // The exclusion set is DATA with a reason, not an omission at a call site: a super-admin
  // administers an association, and neither its bank account nor its voice is administration.
  it.each([
    ['MANAGE_STRIPE_CONNECT', MANAGE_STRIPE_CONNECT],
    ['POST_AS_ASSO', POST_AS_ASSO],
  ])('withholds %s from a BDE super-admin', async (_name, flag) => {
    const { service } = makeService([
      { userId: 'bde', associationId: 'bde-asso', permissions: MANAGE_ASSO, isBDE: true },
    ]);
    await expect(service.mayAct('bde', 'asso1', flag)).resolves.toBe(false);
  });

  it('still grants an excluded flag to the association own member holding it', async () => {
    const { service } = makeService([
      { userId: 'u1', associationId: 'asso1', permissions: MANAGE_STRIPE_CONNECT },
    ]);
    await expect(service.mayAct('u1', 'asso1', MANAGE_STRIPE_CONNECT)).resolves.toBe(true);
  });

  it('still grants an excluded flag to the platform administrator', async () => {
    const { service } = makeService([]);
    await expect(
      service.mayAct('admin', 'asso1', MANAGE_STRIPE_CONNECT, { isGlobalAdmin: true })
    ).resolves.toBe(true);
  });

  it('keeps the exclusion set to the two flags that are not administration', () => {
    expect(SUPER_ADMIN_EXCLUDED_FLAGS).toBe(MANAGE_STRIPE_CONNECT | POST_AS_ASSO);
  });
});

/**
 * The batch form. It must answer exactly what `mayAct` answers, one association at a time - the
 * feed asks it for a page of a dozen associations and draws an edit control from the result, so a
 * divergence here is a control shown where the write is refused.
 */
describe('AssociationsService.mayActOnAny', () => {
  it('returns every id for a platform administrator, with no query at all', async () => {
    const { service, memberRepo } = makeService([]);
    await expect(
      service.mayActOnAny('admin', ['a', 'b'], POST_AS_ASSO, { isGlobalAdmin: true })
    ).resolves.toEqual(new Set(['a', 'b']));
    expect(memberRepo.find).not.toHaveBeenCalled();
  });

  it('returns only the associations where the member holds the flag', async () => {
    const { service } = makeService([
      { userId: 'u1', associationId: 'a', permissions: POST_AS_ASSO },
      { userId: 'u1', associationId: 'b', permissions: MANAGE_FORMS },
    ]);
    await expect(service.mayActOnAny('u1', ['a', 'b', 'c'], POST_AS_ASSO)).resolves.toEqual(
      new Set(['a'])
    );
  });

  it('grants nothing to an anonymous reader', async () => {
    const { service, memberRepo } = makeService([
      { userId: 'u1', associationId: 'a', permissions: POST_AS_ASSO },
    ]);
    await expect(service.mayActOnAny(undefined, ['a'], POST_AS_ASSO)).resolves.toEqual(new Set());
    expect(memberRepo.find).not.toHaveBeenCalled();
  });

  it('queries nothing when there is no association to judge', async () => {
    const { service, memberRepo } = makeService([]);
    await expect(service.mayActOnAny('u1', [], POST_AS_ASSO)).resolves.toEqual(new Set());
    expect(memberRepo.find).not.toHaveBeenCalled();
  });

  it('grants every id to a BDE super-admin for a flag they inherit', async () => {
    const { service } = makeService([
      { userId: 'bde', associationId: 'bde-asso', permissions: MANAGE_ASSO, isBDE: true },
    ]);
    await expect(service.mayActOnAny('bde', ['a', 'b'], MANAGE_MEMBERS)).resolves.toEqual(
      new Set(['a', 'b'])
    );
  });

  // The half that matters for posts: speaking in an association's name is not administration, so
  // the BDE tier is judged on its own bitmask here like anybody else.
  it('withholds POST_AS_ASSO from a BDE super-admin, as `mayAct` does', async () => {
    const { service } = makeService([
      { userId: 'bde', associationId: 'bde-asso', permissions: MANAGE_ASSO, isBDE: true },
    ]);
    await expect(service.mayActOnAny('bde', ['a', 'b'], POST_AS_ASSO)).resolves.toEqual(new Set());
  });

  it('agrees with `mayAct` on each id it was given', async () => {
    const rows = [
      { userId: 'u1', associationId: 'a', permissions: POST_AS_ASSO },
      { userId: 'u1', associationId: 'b', permissions: MANAGE_FORMS },
    ];
    const ids = ['a', 'b', 'c'];
    const { service } = makeService(rows);
    const batch = await service.mayActOnAny('u1', ids, POST_AS_ASSO);
    for (const id of ids) {
      expect(batch.has(id)).toBe(await service.mayAct('u1', id, POST_AS_ASSO));
    }
  });
});
