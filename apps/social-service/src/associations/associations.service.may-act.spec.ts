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
