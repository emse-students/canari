/// <reference types="jest" />

import type { EntityManager } from 'typeorm';
import type Redis from 'ioredis';
import { deleteGroupOwnedRows, deleteGroupRedisKeys, totalGroupOwnedRows } from './group-purge';
import { QueuedMessage } from '../entities/queued-message.entity';
import { GroupMember } from '../entities/group-member.entity';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { MlsCommitLog } from '../entities/mls-commit-log.entity';
import { MlsGroupInfo } from '../entities/mls-group-info.entity';
import { GroupInvite } from '../entities/group-invite.entity';
import { UserDismissedGroup } from '../entities/user-dismissed-group.entity';

/**
 * This function is the single definition of "what a group owns", so what is pinned here is the
 * LIST, not the SQL - a mocked manager never runs a query.
 *
 * It is worth pinning because the omission is invisible: prod carried 21 orphaned `mls_group_info`
 * rows out of 69 and 293 of 452 `mls_commit_log` for as long as those two tables were missing from
 * the reaper, and nothing anywhere said so. A table dropped from this list would regress exactly
 * that way, silently, so the test names all seven.
 */
describe('deleteGroupOwnedRows', () => {
  /** Every entity a group owns. Deliberately spelled out rather than imported from the module. */
  const OWNED = [
    QueuedMessage,
    GroupMember,
    DeviceGroupMembership,
    MlsCommitLog,
    MlsGroupInfo,
    GroupInvite,
    UserDismissedGroup,
  ];

  const makeManager = (affected = 1) => {
    const asked: unknown[] = [];
    const manager = {
      getRepository: jest.fn((entity: unknown) => {
        asked.push(entity);
        return { delete: jest.fn().mockResolvedValue({ affected }) };
      }),
    } as unknown as EntityManager;
    return { manager, asked };
  };

  it('deletes from every table a group owns, and from no other', async () => {
    const { manager, asked } = makeManager();

    await deleteGroupOwnedRows(manager, ['g1', 'g2']);

    expect(asked).toEqual(OWNED);
  });

  it('reports what each table gave up, so the caller can log evidence', async () => {
    const { manager } = makeManager(3);

    const counts = await deleteGroupOwnedRows(manager, ['g1']);

    expect(counts).toEqual({
      queuedMessages: 3,
      members: 3,
      deviceMemberships: 3,
      commitLog: 3,
      groupInfo: 3,
      invites: 3,
      dismissals: 3,
    });
    expect(totalGroupOwnedRows(counts)).toBe(21);
  });

  it('spares the per-user dismissal markers when the group row SURVIVES', async () => {
    // `UserDismissedGroup` is not a fact about the group - it is a fact about a PERSON, recording
    // that they asked for a conversation to be gone from all their devices. Its entity says so
    // twice: text rather than a foreign key "so it outlives the group row", and "independent of the
    // group's own lifecycle". Discovery reads it to tell "I dismissed this" from "somebody else
    // deleted it", and only the first may be purged silently - so a soft delete that took the
    // marker with it would show a deleted banner to the one person who had asked for silence.
    //
    // Measured the day this option was added: three delete routes had just been moved onto this
    // list, all three soft, all three dropping the marker.
    const { manager, asked } = makeManager();

    const counts = await deleteGroupOwnedRows(manager, ['g1'], { groupRowSurvives: true });

    expect(asked).toEqual(OWNED.filter((e) => e !== UserDismissedGroup));
    expect(counts.dismissals).toBe(0);
    // Everything else still goes: sparing one table is not softening the sweep.
    expect(counts.queuedMessages).toBe(1);
    expect(counts.groupInfo).toBe(1);
  });

  it('takes them when the group row goes too, because nothing will ever ask again', async () => {
    const { manager, asked } = makeManager();

    const counts = await deleteGroupOwnedRows(manager, ['g1']);

    expect(asked).toContain(UserDismissedGroup);
    expect(counts.dismissals).toBe(1);
  });

  it('touches nothing when there are no groups', async () => {
    const { manager, asked } = makeManager();

    const counts = await deleteGroupOwnedRows(manager, []);

    expect(asked).toEqual([]);
    expect(totalGroupOwnedRows(counts)).toBe(0);
  });

  it('scopes every delete to the given groups', async () => {
    const deletes: unknown[] = [];
    const manager = {
      getRepository: jest.fn(() => ({
        delete: jest.fn((where: unknown) => {
          deletes.push(where);
          return Promise.resolve({ affected: 0 });
        }),
      })),
    } as unknown as EntityManager;

    await deleteGroupOwnedRows(manager, ['g1', 'g2']);

    // An allowlist: seven deletes, each carrying the same explicit id set and nothing else.
    expect(deletes).toHaveLength(7);
    for (const where of deletes) {
      expect(Object.keys(where as object)).toEqual(['groupId']);
      expect(JSON.stringify(where)).toContain('g1');
      expect(JSON.stringify(where)).toContain('g2');
    }
  });
});

describe('deleteGroupRedisKeys', () => {
  const makeRedis = () => {
    const calls: string[][] = [];
    const redis = {
      del: jest.fn((...keys: string[]) => {
        calls.push(keys);
        return Promise.resolve(keys.length);
      }),
    } as unknown as Redis;
    return { redis, calls };
  };

  it('deletes the three keys a group owns', async () => {
    const { redis, calls } = makeRedis();

    await deleteGroupRedisKeys(redis, ['g1']);

    expect(calls.flat()).toEqual(['history:g1', 'group:members:g1', 'pending_welcome:g1']);
  });

  it('does not name the MLS locks, which expire on their own', async () => {
    const { redis, calls } = makeRedis();

    await deleteGroupRedisKeys(redis, ['g1']);

    expect(calls.flat().join(' ')).not.toContain('mls:');
  });

  it('chunks a large reap rather than building one huge argument list', async () => {
    const { redis, calls } = makeRedis();
    const ids = Array.from({ length: 400 }, (_, i) => `g${i}`);

    await deleteGroupRedisKeys(redis, ids);

    expect(calls.flat()).toHaveLength(1200);
    for (const chunk of calls) expect(chunk.length).toBeLessThanOrEqual(500);
  });

  it('issues no command at all when there are no groups', async () => {
    const { redis, calls } = makeRedis();

    await deleteGroupRedisKeys(redis, []);

    expect(calls).toEqual([]);
  });
});
