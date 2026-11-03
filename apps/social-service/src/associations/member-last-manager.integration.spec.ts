/**
 * THE LAST MEMBER MANAGER, AGAINST A REAL POSTGRESQL: the guard and the write it protects are one
 * step under the association's `FOR UPDATE` lock, so two managers leaving - or demoting each
 * other - at the same moment leave exactly one holder, never none. And the passation the owner
 * asked for (2026-11-03) runs end to end with no platform admin and no BDE.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; CI's
 * `test-social-integration` sets it. Locally, against a throwaway PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- member-last-manager.integration
 *
 * Everything happens in a throwaway schema (see `association-member-write-gone.integration.spec.ts`
 * for the shape), dropped at the end. Only `association_members` and the `associations` row the
 * lock takes exist there: the kind, the super-admin tier and the association read are stubbed,
 * since each has its own spec.
 */
import * as crypto from 'crypto';
import { HttpException, Logger } from '@nestjs/common';
import { Client } from 'pg';
import { DataSource, Repository } from 'typeorm';
import { AssociationsService } from './associations.service';
import { AssociationMember, AssociationPermissionFlag } from './entities/association-member.entity';
import { LAST_MEMBER_MANAGER } from './member-flag-ceiling';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const {
  MANAGE_MEMBERS,
  PROPOSE_EVENT,
  POST_AS_ASSO,
  MANAGE_PAYOUT_ACCOUNT,
  MANAGE_PRODUCTS,
  MANAGE_FORMS,
} = AssociationPermissionFlag;

maybe('the last member manager against PostgreSQL', () => {
  const schema = `asso_last_mgr_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let service: AssociationsService;
  let members: Repository<AssociationMember>;

  /** A fresh association: its lock row, and its roster as given. */
  const association = async (roster: [string, number][]) => {
    const id = crypto.randomUUID();
    await ds.query(`INSERT INTO associations (id) VALUES ($1)`, [id]);
    for (const [userId, permissions] of roster) {
      await members.save(
        members.create({ associationId: id, userId, role: 'Membre', permissions })
      );
    }
    return id;
  };
  const managers = async (associationId: string) =>
    (await members.find({ where: { associationId } })).filter(
      (m) => (m.permissions & MANAGE_MEMBERS) !== 0
    ).length;
  const settle = (p: Promise<unknown>) =>
    p.then(
      () => 'written',
      (e: unknown) =>
        (e instanceof HttpException ? (e.getResponse() as { code?: unknown }).code : undefined) ?? e
    );

  beforeAll(async () => {
    for (const level of ['log', 'warn', 'debug'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [AssociationMember],
      synchronize: false,
      uuidExtension: 'pgcrypto',
      installExtensions: false,
      extra: { options: `-c search_path=${schema}` },
    });
    await ds.initialize();
    await ds.synchronize();
    // The row `underMemberLock` takes FOR UPDATE; nothing else of an association is read here.
    await ds.query(`CREATE TABLE associations (id uuid PRIMARY KEY)`);
    members = ds.getRepository(AssociationMember);
    const unused = {} as never;
    const assoRepo = { findOne: async () => ({ id: 'a', type: 'association' }) } as never;
    service = new AssociationsService(
      assoRepo,
      members,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      {} as never,
      unused,
      unused,
      unused,
      { enabled: () => false, tell: async () => 0 } as never // lydiaNotifier
    );
    // Nobody here is a BDE super-admin: the passation is between ordinary members.
    jest.spyOn(service, 'isAssociationSuperAdminOf').mockResolvedValue(false);
    jest
      .spyOn(service, 'findById')
      .mockImplementation(async (id: string) => ({ id, type: 'association' }) as never);
    jest
      .spyOn(
        service as unknown as { invalidatePostListCaches: () => Promise<void> },
        'invalidatePostListCaches'
      )
      .mockResolvedValue(undefined);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    if (ds?.isInitialized) await ds.destroy();
    if (!admin) return;
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it('two managers leaving at once: exactly one leaves, the other is refused typed', async () => {
    const asso = await association([
      ['a', MANAGE_MEMBERS],
      ['b', MANAGE_MEMBERS],
    ]);
    const outcomes = await Promise.all([
      settle(service.leaveAssociation(asso, 'a')),
      settle(service.leaveAssociation(asso, 'b')),
    ]);
    expect(outcomes.filter((o) => o === 'written')).toHaveLength(1);
    expect(outcomes.filter((o) => o === LAST_MEMBER_MANAGER)).toHaveLength(1);
    expect(await managers(asso)).toBe(1);
  });

  it('two managers demoting each other at once: exactly one is demoted', async () => {
    const asso = await association([
      ['a', MANAGE_MEMBERS | PROPOSE_EVENT],
      ['b', MANAGE_MEMBERS | PROPOSE_EVENT],
    ]);
    const outcomes = await Promise.all([
      settle(
        service.updateMemberRole(asso, 'b', undefined, PROPOSE_EVENT, {
          granter: { userId: 'a', isGlobalAdmin: false },
        })
      ),
      settle(
        service.updateMemberRole(asso, 'a', undefined, PROPOSE_EVENT, {
          granter: { userId: 'b', isGlobalAdmin: false },
        })
      ),
    ]);
    expect(outcomes.filter((o) => o === 'written')).toHaveLength(1);
    expect(outcomes.filter((o) => o === LAST_MEMBER_MANAGER)).toHaveLength(1);
    expect(await managers(asso)).toBe(1);
  });

  it('a leaver never takes the BDE bypass: the last manager stays through the member route', async () => {
    const asso = await association([['last', MANAGE_MEMBERS]]);
    expect(
      await settle(
        service.removeMember(asso, 'last', {
          granter: { userId: 'last', isGlobalAdmin: false },
          bypassLastAdmin: true,
        })
      )
    ).toBe(LAST_MEMBER_MANAGER);
    expect(await managers(asso)).toBe(1);
  });

  /**
   * "Tout ce qui concerne une passation doit pouvoir se faire sans admin plateforme. Si le
   * secrétaire veut ajouter et mettre les permissions au nouveau secrétaire (respectivement
   * président, trésorier...) puis se retirer, il faut que ce soit faisable." (owner, 2026-11-03)
   */
  it('the passation: the president hands its whole mask to a newcomer, then leaves', async () => {
    const PRESIDENT =
      MANAGE_MEMBERS | POST_AS_ASSO | MANAGE_PAYOUT_ACCOUNT | MANAGE_PRODUCTS | PROPOSE_EVENT;
    const asso = await association([
      ['old-pres', PRESIDENT],
      ['sec', MANAGE_MEMBERS | MANAGE_FORMS],
    ]);
    const granter = { userId: 'old-pres', isGlobalAdmin: false };
    expect(
      await settle(
        service.addMember(
          { associationId: asso, userId: 'new-pres', role: 'President', permissions: PRESIDENT },
          granter
        )
      )
    ).toBe('written');
    expect(await settle(service.leaveAssociation(asso, 'old-pres'))).toBe('written');
    const roster = await members.find({ where: { associationId: asso }, order: { userId: 'ASC' } });
    expect(roster.map((m) => [m.userId, m.permissions])).toEqual([
      ['new-pres', PRESIDENT],
      ['sec', MANAGE_MEMBERS | MANAGE_FORMS],
    ]);
  });

  it('the passation to a member already there: promoted with the treasurer mask, then the old one leaves', async () => {
    const TREASURER = MANAGE_MEMBERS | MANAGE_PAYOUT_ACCOUNT | MANAGE_PRODUCTS;
    const asso = await association([
      ['old-treasurer', TREASURER],
      ['member', PROPOSE_EVENT],
    ]);
    expect(
      await settle(
        service.updateMemberRole(asso, 'member', 'Tresorier', TREASURER | PROPOSE_EVENT, {
          granter: { userId: 'old-treasurer', isGlobalAdmin: false },
        })
      )
    ).toBe('written');
    expect(await settle(service.leaveAssociation(asso, 'old-treasurer'))).toBe('written');
    expect(
      await members.findOne({ where: { associationId: asso, userId: 'member' } })
    ).toMatchObject({ role: 'Tresorier', permissions: TREASURER | PROPOSE_EVENT });
  });
});
