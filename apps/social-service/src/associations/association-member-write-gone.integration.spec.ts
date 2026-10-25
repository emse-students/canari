/**
 * AN ASSOCIATION MEMBER'S ROLE WRITE NEVER INSERTS A ROW, AGAINST A REAL POSTGRESQL.
 *
 * `updateMemberRole` reads the membership, judges it, then writes the columns it changes, keyed by
 * the row it read - 0 rows updated is "the membership is gone". A TypeORM `save` of the entity read
 * would insert the row again when it is missing. The removal runs from inside the service's own read,
 * so it commits between the read and the write deterministically (never a sleep).
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; CI's
 * `test-social-integration` sets it. Locally, against a throwaway PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- association-member-write-gone.integration
 *
 * Everything happens in a throwaway schema created BEFORE the DataSource initializes (see
 * `channel-unread-clear.integration.spec.ts` for why that order), dropped at the end.
 */
import * as crypto from 'crypto';
import { Logger, NotFoundException } from '@nestjs/common';
import { Client } from 'pg';
import { DataSource, Repository } from 'typeorm';
import { AssociationsService } from './associations.service';
import { AssociationMember } from './entities/association-member.entity';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

maybe('an association member write against PostgreSQL', () => {
  const schema = `asso_member_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let service: AssociationsService;
  let members: Repository<AssociationMember>;

  const seat = async (associationId: string, userId: string, permissions: number) =>
    members.save(members.create({ associationId, userId, role: 'Membre', permissions }));
  const rowOf = (associationId: string, userId: string) =>
    members.findOne({ where: { associationId, userId } });

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
    members = ds.getRepository(AssociationMember);
    // Only the membership repository is read or written by the two calls under test; the feed-cache
    // sweep a removal makes is best-effort and logs its own failure against this empty Redis.
    const unused = {} as never;
    service = new AssociationsService(
      unused,
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
      unused
    );
    // No budget here: every integration spec has one, `jest-integration-budget.cjs`.
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    if (ds?.isInitialized) await ds.destroy();
    if (!admin) return;
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it('a role change across a removal leaves no membership row', async () => {
    const asso = crypto.randomUUID();
    await seat(asso, 'target', 0);
    const original = members.findOne.bind(members);
    let ran = false;
    const spy = jest.spyOn(members, 'findOne').mockImplementation((async (
      o: Parameters<typeof original>[0]
    ) => {
      const answer = await original(o);
      spy.mockRestore();
      ran = true;
      await service.removeMember(asso, 'target');
      return answer;
    }) as never);

    const outcome = await service.updateMemberRole(asso, 'target', 'Tresorier', 1).then(
      () => 'set',
      (e: unknown) => e
    );
    expect(ran).toBe(true);
    expect(outcome).toBeInstanceOf(NotFoundException);
    expect(await rowOf(asso, 'target')).toBeNull();
  });

  it('a role change with no removal writes only what it names', async () => {
    const asso = crypto.randomUUID();
    await seat(asso, 'target', 4);
    const answer = await service.updateMemberRole(asso, 'target', 'Tresorier');
    expect(answer).toMatchObject({ role: 'Tresorier', permissions: 4 });
    expect(await rowOf(asso, 'target')).toMatchObject({ role: 'Tresorier', permissions: 4 });
  });
});
