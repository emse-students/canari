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
  /**
   * The tables a transaction touches, in order, between its BEGIN and its COMMIT - the group's seat
   * lock named `seat-lock`, since it is a function call and not a table.
   */
  const tablesInTransaction = (statements: RecordedStatement[]): string[] => {
    const begin = statements.findIndex((s) => s.sql === 'BEGIN');
    const commit = statements.findIndex((s, i) => i > begin && s.sql === 'COMMIT');
    return statements
      .slice(begin + 1, commit)
      .map((s) => (s.sql.includes('pg_advisory_xact_lock') ? 'seat-lock' : tableOf(s.sql)))
      .filter((t): t is string => t !== null);
  };

  /**
   * What the database answers a SELECT: one row for the group and for bob's ADMITTED seat, and one
   * key package per device - built from the column aliases the real builder wrote, so the row is the
   * shape TypeORM hydrates.
   */
  const answerAsAdmitted = (stmt: RecordedStatement): unknown[] => {
    if (!stmt.sql.startsWith('SELECT') || stmt.sql.includes('pg_advisory_xact_lock')) return [];
    const aliases = [...stmt.sql.matchAll(/AS "([A-Za-z]+)_([A-Za-z]+)"/g)];
    // A raw query (the block check) is no entity read: it answers nothing, as with no block.
    if (aliases.length === 0) return [];
    const row = (deviceId: string) =>
      Object.fromEntries(
        aliases.map(([, entity, field]) => [
          `${entity}_${field}`,
          (
            {
              id: 'row-1',
              groupId: 'g-1',
              userId: 'bob',
              deviceId,
              deletedAt: null,
              awaitingAdmission: false,
            } as Record<string, unknown>
          )[field] ?? null,
        ])
      );
    return tableOf(stmt.sql) === 'key_package' ? [row('b1'), row('b2')] : [row('b1')];
  };

  async function controllerOn(answer?: (stmt: RecordedStatement) => unknown) {
    const recorded = await recordingDataSource(answer);
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
      // The caller holds an ADMITTED seat, so the membership guard passes.
      {
        ...repo(),
        findOne: jest.fn().mockResolvedValue({ id: 'seat', awaitingAdmission: false }),
      } as never,
      repo() as never,
      repo() as never,
      keyPackageRepo as never,
      repo() as never,
      repo() as never,
      repo() as never,
      repo() as never, // RevokedDevice
      repo() as never, // RevokedDeviceGroup
      redis as never,
      recorded.dataSource
    );
    return { controller, statements: recorded.statements };
  }

  it('both take the seat lock first, then the roster row, then the device rows', async () => {
    // The route enrols nobody but a creator (ADM-3): for a person an accepted commit admitted, it
    // re-reads their ADMITTED seat under the group's seat lock and writes their device rows.
    const add = await controllerOn(answerAsAdmitted);
    await add.controller.addGroupMember('g-1', { userId: 'bob' }, 'alice', undefined);
    const remove = await controllerOn();
    await remove.controller.removeGroupMember('g-1', 'bob', 'alice', undefined);

    const addOrder = tablesInTransaction(add.statements);
    const removeOrder = tablesInTransaction(remove.statements);
    expect(addOrder).toEqual([
      'seat-lock',
      'dm_groups',
      'dm_group_members',
      'key_package',
      'dm_device_group_memberships',
    ]);
    // The removal first reads whether the seat was an open invitation-link ask (to announce its
    // end): a plain SELECT, no row lock, so the write order below it is unchanged.
    expect(removeOrder.filter((t) => t !== 'seat-lock' && t !== 'dm_groups')).toEqual([
      'dm_group_members',
      'dm_group_members',
      'dm_group_membership_intervals',
      'queued_message',
      'dm_device_group_memberships',
    ]);
    expect(removeOrder[0]).toBe('seat-lock');
  });

  it('the add of a person no commit admitted writes nothing, under the lock', async () => {
    // No seat for bob: the typed 409 MEMBER_NOT_ADMITTED, and not one INSERT.
    const add = await controllerOn((stmt) =>
      tableOf(stmt.sql) === 'dm_group_members' ? [] : answerAsAdmitted(stmt)
    );
    await expect(
      add.controller.addGroupMember('g-1', { userId: 'bob' }, 'alice', undefined)
    ).rejects.toMatchObject({ status: 409, response: { code: 'MEMBER_NOT_ADMITTED' } });
    expect(add.statements.some((s) => s.sql.startsWith('INSERT'))).toBe(false);
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

  /**
   * A DECLINE IS NOT A REMOVAL: it is answered only by an ADMITTED member, never by the asker, and
   * its outcomes against a real database are in `services/admission.integration.spec.ts`.
   */
  describe('the Decline of an invitation-link ask', () => {
    async function declineAs(callerSeat: { awaitingAdmission: boolean } | null) {
      const recorded = await recordingDataSource();
      const groupMemberRepo = { findOne: jest.fn().mockResolvedValue(callerSeat) };
      const controller = new MembersController(
        groupMemberRepo as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        recorded.dataSource
      );
      return { controller, statements: recorded.statements };
    }

    it('refuses a caller who holds no seat (403) and writes nothing', async () => {
      const { controller, statements } = await declineAs(null);
      await expect(controller.declineJoinRequest('g-1', 'bob', 'alice')).rejects.toMatchObject({
        response: { code: 'NOT_A_MEMBER' },
      });
      expect(statements).toEqual([]);
    });

    it('answers a caller whose own seat still waits the 409 awaiting_admission, and writes nothing', async () => {
      const { controller, statements } = await declineAs({ awaitingAdmission: true });
      await expect(controller.declineJoinRequest('g-1', 'bob', 'alice')).rejects.toMatchObject({
        status: 409,
        response: { error: 'awaiting_admission' },
      });
      expect(statements).toEqual([]);
    });

    it('refuses the asker declining their own ask', async () => {
      const { controller } = await declineAs({ awaitingAdmission: false });
      await expect(controller.declineJoinRequest('g-1', 'bob', 'bob')).rejects.toMatchObject({
        response: { code: 'NOT_A_MEMBER' },
      });
    });
  });
});
