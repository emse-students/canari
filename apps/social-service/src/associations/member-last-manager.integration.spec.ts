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
import { ERASURE_ASSOCIATION_LOCK_SQL, ERASURE_ROW_STATEMENTS } from '../internal/account-erasure';

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
      // Named by the schema, so the lock-wait probe below counts this file's connections only.
      extra: { options: `-c search_path=${schema}`, application_name: schema },
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

  /**
   * THE RACE, MADE DETERMINISTIC WITH NO CLOCK. A third connection holds the association's lock, both
   * writes are started, and the probe waits for an EVENT: either both are blocked on a lock, or both
   * have settled. With the lock in `underMemberLock` they are always both waiting when the holder
   * commits, so they meet the guard one after the other; without it neither ever waits, both settle
   * first, and "both were waiting" fails - on every run, which is what makes the spec a witness.
   */
  const raceUnderHeldLock = async (asso: string, writes: () => Promise<unknown>[]) => {
    const holder = new Client({ connectionString: URL, options: `-c search_path=${schema}` });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM associations WHERE id = $1 FOR UPDATE`, [asso]);
      const outcomes = writes().map(settle);
      let settled = 0;
      for (const outcome of outcomes) void outcome.then(() => (settled += 1));
      let waiting = 0;
      // Ends on an event (both blocked, or both settled), never on a timer.
      while (waiting < outcomes.length && settled < outcomes.length) {
        const { rows } = await admin.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE application_name = $1 AND wait_event_type = 'Lock'`,
          [schema]
        );
        waiting = rows[0].n;
      }
      await holder.query('COMMIT');
      return { waiting, outcomes: await Promise.all(outcomes) };
    } finally {
      await holder.end();
    }
  };

  it('two managers leaving at once: exactly one leaves, the other is refused typed', async () => {
    const asso = await association([
      ['a', MANAGE_MEMBERS],
      ['b', MANAGE_MEMBERS],
    ]);
    const { waiting, outcomes } = await raceUnderHeldLock(asso, () => [
      service.leaveAssociation(asso, 'a'),
      service.leaveAssociation(asso, 'b'),
    ]);
    expect(waiting).toBe(2);
    expect(outcomes.filter((o) => o === 'written')).toHaveLength(1);
    expect(outcomes.filter((o) => o === LAST_MEMBER_MANAGER)).toHaveLength(1);
    expect(await managers(asso)).toBe(1);
  });

  it('two managers demoting each other at once: exactly one is demoted', async () => {
    const asso = await association([
      ['a', MANAGE_MEMBERS | PROPOSE_EVENT],
      ['b', MANAGE_MEMBERS | PROPOSE_EVENT],
    ]);
    const { waiting, outcomes } = await raceUnderHeldLock(asso, () => [
      service.updateMemberRole(asso, 'b', undefined, PROPOSE_EVENT, {
        granter: { userId: 'a', isGlobalAdmin: false },
      }),
      service.updateMemberRole(asso, 'a', undefined, PROPOSE_EVENT, {
        granter: { userId: 'b', isGlobalAdmin: false },
      }),
    ]);
    expect(waiting).toBe(2);
    expect(outcomes.filter((o) => o === 'written')).toHaveLength(1);
    expect(outcomes.filter((o) => o === LAST_MEMBER_MANAGER)).toHaveLength(1);
    expect(await managers(asso)).toBe(1);
  });

  /**
   * THE ACCOUNT ERASURE TAKES THE SAME LOCK FIRST. Its first statement locks every association the
   * account touches, in id order, `FOR NO KEY UPDATE` - a strength that conflicts with the member
   * guard's `FOR UPDATE` - before its `association_members` delete. So an erasure and a leave on one
   * association meet the guard one after the other. Here the erasure of manager `a` holds the lock
   * and deletes its row; the leave of `b`, started meanwhile, waits, then counts one holder and is
   * refused. The erasure itself is never refused: erasing the LAST manager leaves none, which the
   * super-admin or the platform admin recovers (association-permissions.md).
   */
  it('an erasure of one manager and a leave of the other meet the guard in turn', async () => {
    // The probe below reproduces the erasure's own lock strength; this ties the two.
    expect(ERASURE_ASSOCIATION_LOCK_SQL.trim().endsWith('FOR NO KEY UPDATE OF a')).toBe(true);
    const memberDelete = ERASURE_ROW_STATEMENTS.find((st) => st.label === 'association_members');
    expect(memberDelete).toBeDefined();
    const asso = await association([
      ['a', MANAGE_MEMBERS],
      ['b', MANAGE_MEMBERS],
    ]);
    const erasure = new Client({ connectionString: URL, options: `-c search_path=${schema}` });
    await erasure.connect();
    try {
      await erasure.query('BEGIN');
      await erasure.query(
        `SELECT a.id FROM associations a WHERE a.id = $1 FOR NO KEY UPDATE OF a`,
        [asso]
      );
      await erasure.query(memberDelete!.sql, ['a']);
      const leave = settle(service.leaveAssociation(asso, 'b'));
      let settledFirst = false;
      void leave.then(() => (settledFirst = true));
      let waiting = 0;
      while (waiting < 1 && !settledFirst) {
        const { rows } = await admin.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE application_name = $1 AND wait_event_type = 'Lock'`,
          [schema]
        );
        waiting = rows[0].n;
      }
      expect(waiting).toBe(1);
      await erasure.query('COMMIT');
      expect(await leave).toBe(LAST_MEMBER_MANAGER);
    } finally {
      await erasure.end();
    }
    expect(await managers(asso)).toBe(1);
  });

  it('the last manager demoting itself never takes the BDE bypass', async () => {
    const asso = await association([['last', MANAGE_MEMBERS | PROPOSE_EVENT]]);
    expect(
      await settle(
        service.updateMemberRole(asso, 'last', undefined, PROPOSE_EVENT, {
          granter: { userId: 'last', isGlobalAdmin: false },
          bypassLastAdmin: true,
        })
      )
    ).toBe(LAST_MEMBER_MANAGER);
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
