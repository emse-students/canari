/// <reference types="jest" />

import { MembersController } from './members.controller';
import {
  recordingDataSource,
  tableOf,
  type RecordedStatement,
} from '../testing/recordingDataSource';

/**
 * AN ADD AND A REMOVAL OF THE SAME PERSON TAKE THEIR LOCKS IN THE SAME ORDER: `dm_group_members`
 * first, then the membership interval, then (on a removal, the queued Welcomes and) the device
 * rows - the one delete order of `utils/seat-eviction.ts`. Two transactions that lock the same rows in the same order wait for each other and
 * never deadlock; the removal used to delete the device rows first and the add to write the
 * roster first, which is the crossing that can.
 *
 * Read off the SQL the real TypeORM builder produces, one transaction each (`recordingDataSource`).
 * What it cannot show is two live sessions - there is no server here; the ordering is what makes
 * the pair safe on one.
 */
describe('MembersController - lock order of an add and a removal', () => {
  /** The tables a transaction writes, in order, between its BEGIN and its COMMIT. */
  const tablesInTransaction = (statements: RecordedStatement[]): string[] => {
    const begin = statements.findIndex((s) => s.sql === 'BEGIN');
    const commit = statements.findIndex((s, i) => i > begin && s.sql === 'COMMIT');
    return statements
      .slice(begin + 1, commit)
      .map((s) => tableOf(s.sql))
      .filter((t): t is string => t !== null);
  };

  async function controllerOn() {
    const recorded = await recordingDataSource();
    const repo = () => ({
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(1),
    });
    const keyPackageRepo = repo();
    keyPackageRepo.find.mockResolvedValue([{ deviceId: 'b1' }, { deviceId: 'b2' }]);
    const redis = {
      hset: jest.fn().mockResolvedValue(1),
      smembers: jest.fn().mockResolvedValue([]),
      srem: jest.fn().mockResolvedValue(0),
    };
    const controller = new MembersController(
      repo() as never,
      repo() as never,
      repo() as never,
      keyPackageRepo as never,
      repo() as never,
      repo() as never,
      repo() as never,
      repo() as never, // RevokedDevice
      redis as never,
      recorded.dataSource
    );
    return { controller, statements: recorded.statements };
  }

  it('both write dm_group_members before the device rows', async () => {
    const add = await controllerOn();
    await add.controller.addGroupMember('g-1', { userId: 'bob' }, 'alice', undefined);
    const remove = await controllerOn();
    await remove.controller.removeGroupMember('g-1', 'bob', 'alice', undefined);

    const addOrder = tablesInTransaction(add.statements);
    const removeOrder = tablesInTransaction(remove.statements);
    // The enrolment reads the last departure and the earliest device row before it opens the
    // interval (`admittedAt`): two plain SELECTs, which take no row lock, so the write order
    // below them is unchanged.
    expect(addOrder).toEqual([
      'dm_group_members',
      'dm_group_membership_intervals',
      'dm_device_group_memberships',
      'dm_group_membership_intervals',
      'dm_device_group_memberships',
      'dm_device_group_memberships',
    ]);
    expect(removeOrder).toEqual([
      'dm_group_members',
      'dm_group_membership_intervals',
      'queued_message',
      'dm_device_group_memberships',
    ]);
  });

  it('the removal takes the queued Welcomes inside the transaction that ends the membership', async () => {
    const remove = await controllerOn();
    await remove.controller.removeGroupMember('g-1', 'bob', 'bob', undefined);

    const begin = remove.statements.findIndex((s) => s.sql === 'BEGIN');
    const commit = remove.statements.findIndex((s) => s.sql === 'COMMIT');
    const welcomes = remove.statements.findIndex(
      (s) => tableOf(s.sql) === 'queued_message' && s.sql.startsWith('DELETE')
    );
    expect(begin).toBeLessThan(welcomes);
    expect(welcomes).toBeLessThan(commit);
    expect(remove.statements[welcomes].params).toEqual(['bob', 'g-1', true]);
  });
});
