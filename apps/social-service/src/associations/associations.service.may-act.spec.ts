import { AssociationsService } from './associations.service';
import {
  ASSOCIATIONS_UNDER_BDE_FLAG_SQL,
  BDE_FLAG_HOLDERS_OVER_SQL,
  HOLDS_BDE_FLAG_OVER_SQL,
} from '../spaces/bde';
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
  /**
   * When this row's association is the BDE of a space: the associations whose rules reach that
   * space, i.e. the ones it GOVERNS (WP6c step 2). The SQL that computes this from `spaces` and
   * `association_audiences` is proven against PostgreSQL in `bde.integration.spec.ts`; here it is
   * given, so these tests are about how `mayAct` folds the tiers.
   */
  governs?: string[];
}

function makeService(rows: Row[]) {
  /** The two scoped BDE queries `mayAct` / `mayActOnAny` reach, answered from the seeded rows. */
  const query = jest.fn((sql: string, params: unknown[]) => {
    if (sql === HOLDS_BDE_FLAG_OVER_SQL) {
      const [userId, associationId, flag] = params as [string, string, number];
      const holds = rows.some(
        (r) =>
          r.userId === userId &&
          (r.governs ?? []).includes(associationId) &&
          (r.permissions & flag) !== 0
      );
      return Promise.resolve([{ holds }]);
    }
    if (sql === ASSOCIATIONS_UNDER_BDE_FLAG_SQL) {
      const [userId, flag] = params as [string, number];
      const ids = new Set(
        rows
          .filter((r) => r.userId === userId && (r.permissions & flag) !== 0)
          .flatMap((r) => r.governs ?? [])
      );
      return Promise.resolve([...ids].map((id) => ({ id })));
    }
    return Promise.reject(new Error(`unexpected query: ${sql}`));
  });
  const createQueryBuilder = jest.fn();

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
    query,
  };

  // POSITIONAL, AND THIRTEEN LONG - so a constructor change silently shifts every argument after
  // the one it touched. The comments are the guard: keep them aligned with the parameter list in
  // `associations.service.ts`, and change them in the same commit that changes it.
  const service = new AssociationsService(
    undefined as never, // assoRepo
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
    undefined as never // userTagService
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
    expect(memberRepo.query).not.toHaveBeenCalled();
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
      {
        userId: 'bde',
        associationId: 'bde-asso',
        permissions: MANAGE_ASSO,
        governs: ['asso1', 'a', 'b'],
      },
    ]);
    await expect(service.mayAct('bde', 'asso1', MANAGE_MEMBERS)).resolves.toBe(true);
  });

  // WP6c step 2: MANAGE_ASSO reaches the associations the BDE's space governs, and no others.
  it('refuses a BDE super-admin of ANOTHER space', async () => {
    const { service } = makeService([
      { userId: 'bde', associationId: 'bde-gardanne', permissions: MANAGE_ASSO, governs: ['ga1'] },
    ]);
    await expect(service.mayAct('bde', 'asso1', MANAGE_MEMBERS)).resolves.toBe(false);
    await expect(service.mayAct('bde', 'ga1', MANAGE_MEMBERS)).resolves.toBe(true);
  });

  it('does not grant MANAGE_ASSO outside a BDE association', async () => {
    const { service } = makeService([
      { userId: 'u1', associationId: 'club', permissions: MANAGE_ASSO },
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
      {
        userId: 'bde',
        associationId: 'bde-asso',
        permissions: MANAGE_ASSO,
        governs: ['asso1', 'a', 'b'],
      },
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
      {
        userId: 'bde',
        associationId: 'bde-asso',
        permissions: MANAGE_ASSO,
        governs: ['asso1', 'a', 'b'],
      },
    ]);
    await expect(service.mayActOnAny('bde', ['a', 'b'], MANAGE_MEMBERS)).resolves.toEqual(
      new Set(['a', 'b'])
    );
  });

  it('grants a BDE super-admin only the ids its space governs, plus its own memberships', async () => {
    const { service } = makeService([
      { userId: 'bde', associationId: 'bde-asso', permissions: MANAGE_ASSO, governs: ['a'] },
      { userId: 'bde', associationId: 'c', permissions: MANAGE_MEMBERS },
    ]);
    await expect(service.mayActOnAny('bde', ['a', 'b', 'c'], MANAGE_MEMBERS)).resolves.toEqual(
      new Set(['a', 'c'])
    );
  });

  // The half that matters for posts: speaking in an association's name is not administration, so
  // the BDE tier is judged on its own bitmask here like anybody else.
  it('withholds POST_AS_ASSO from a BDE super-admin, as `mayAct` does', async () => {
    const { service } = makeService([
      {
        userId: 'bde',
        associationId: 'bde-asso',
        permissions: MANAGE_ASSO,
        governs: ['asso1', 'a', 'b'],
      },
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

/**
 * WP6c step 2: the event verdict and the proposal notification read the BDE governing the EVENT'S
 * association. Which BDE that is, is SQL proven in `spaces/bde.integration.spec.ts`; these pin that
 * the service asks it about the right association and hands its answer through untouched.
 */
describe('AssociationsService scoped event governance', () => {
  function makeGovernanceService(opts: { holds?: boolean; holders?: string[] }) {
    const query = jest.fn((sql: string) =>
      Promise.resolve(
        sql === HOLDS_BDE_FLAG_OVER_SQL
          ? [{ holds: opts.holds ?? false }]
          : (opts.holders ?? []).map((userId) => ({ userId }))
      )
    );
    const calendarRepo = {
      findOne: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(where.id === 'ev1' ? { id: 'ev1', associationId: 'owner-asso' } : null)
      ),
    };
    const notifications = { createNotifications: jest.fn(() => Promise.resolve(1)) };
    const service = new AssociationsService(
      undefined as never, // assoRepo
      { query } as never, // memberRepo
      calendarRepo as never, // calendarRepo
      undefined as never, // coOwnerRepo
      undefined as never, // docRepo
      undefined as never, // reviewerGrantRepo
      undefined as never, // postRepo
      undefined as never, // formRepo
      undefined as never, // productRepo
      undefined as never, // redis
      undefined as never, // httpService
      notifications as never, // notifications
      undefined as never // userTagService
    );
    return { service, query, notifications };
  }

  it("judges an event on its OWN association's BDE, read from the row", async () => {
    const { service, query } = makeGovernanceService({ holds: true });
    await expect(service.mayValidateEvent('bde1', 'ev1')).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith(HOLDS_BDE_FLAG_OVER_SQL, [
      'bde1',
      'owner-asso',
      AssociationPermissionFlag.VALIDATE_EVENTS,
    ]);
  });

  it('refuses when the BDE does not govern the event association', async () => {
    const { service } = makeGovernanceService({ holds: false });
    await expect(service.mayValidateEvent('bde2', 'ev1')).resolves.toBe(false);
  });

  it('refuses an unknown event without asking any BDE', async () => {
    const { service, query } = makeGovernanceService({ holds: true });
    await expect(service.mayValidateEvent('bde1', 'missing')).resolves.toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it('lets a global admin validate any event, even of an association reaching no space', async () => {
    const { service, query } = makeGovernanceService({ holds: false });
    await expect(service.mayValidateEvent('admin', 'ev1', { isGlobalAdmin: true })).resolves.toBe(
      true
    );
    await expect(
      service.mayValidateEventsOf('admin', 'no-space-asso', { isGlobalAdmin: true })
    ).resolves.toBe(true);
    expect(query).not.toHaveBeenCalled();
  });

  it('tells exactly the VALIDATE_EVENTS holders of the BDE(s) governing the proposing association', async () => {
    const { service, query, notifications } = makeGovernanceService({ holders: ['se1', 'ga1'] });
    const notify = (
      service as unknown as {
        notifyEventValidatorsOfProposal: (a: string, actor: string, t: string) => Promise<void>;
      }
    ).notifyEventValidatorsOfProposal.bind(service);
    await notify('club', 'author', 'Gala');
    expect(query).toHaveBeenCalledWith(BDE_FLAG_HOLDERS_OVER_SQL, [
      'club',
      AssociationPermissionFlag.VALIDATE_EVENTS,
    ]);
    expect(notifications.createNotifications).toHaveBeenCalledWith(
      expect.objectContaining({ recipientIds: ['se1', 'ga1'], type: 'event_proposed' })
    );
  });
});
