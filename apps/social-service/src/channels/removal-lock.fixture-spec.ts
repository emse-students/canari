/**
 * A test double of the community removal lock and of `distribution_evictions_owed`, shared by the
 * unit specs that drive a kick, a salon removal or an access-list update through mocked
 * repositories.
 *
 * NOT A SUITE AND NOT SHIPPED: jest selects `*.spec.ts`, which this name is not, and the build
 * excludes `**\/*spec.ts`, which it is.
 *
 * `memberRepo.manager.transaction` runs the work against the same repositories and reports whether
 * the lock is held at any moment (`lockHeld`), so a spec can assert that no call to chat-delivery
 * happens under it. The owed rows live in `owed`, written by the transaction's INSERT and read and
 * deleted by `memberRepo.query`, the statements `ChannelService` issues.
 */
import { ChannelMember } from './entities/channel-member.entity';
import { ChannelRole } from './entities/channel-role.entity';

/** One owed eviction, as the double stores it. */
export interface OwedRow {
  kind: string;
  scopeId: string;
  userId: string;
  reason: string;
  token: string;
}

/** What {@link installRemovalLock} hands back to the spec. */
export interface RemovalLockDouble {
  owed: OwedRow[];
  lockHeld: () => boolean;
  lockQueries: string[];
}

/**
 * Wires the removal lock's transaction and the owed-eviction table onto `memberRepo`.
 *
 * @param repos the spec's repository mocks; `memberRepo` gains `manager` and `query`
 */
export function installRemovalLock(repos: {
  memberRepo: object;
  roleRepo: object;
  channelRepo: object;
}): RemovalLockDouble {
  const owed: OwedRow[] = [];
  const lockQueries: string[] = [];
  let held = false;
  let tokens = 0;

  const tx = {
    query: (sql: string, params: unknown[] = []) => {
      if (sql.includes('pg_advisory_xact_lock')) {
        lockQueries.push(sql);
        held = true;
      } else if (sql.includes('INSERT INTO distribution_evictions_owed')) {
        const [kind, scopeId, userId, reason] = params as string[];
        const token = `t-${tokens++}`;
        const existing = owed.find(
          (r) => r.kind === kind && r.scopeId === scopeId && r.userId === userId
        );
        if (existing) Object.assign(existing, { reason, token });
        else owed.push({ kind, scopeId, userId, reason, token });
      }
      return Promise.resolve([]);
    },
    getRepository: (entity: unknown) =>
      entity === ChannelMember
        ? repos.memberRepo
        : entity === ChannelRole
          ? repos.roleRepo
          : repos.channelRepo,
  };

  Object.assign(repos.memberRepo, {
    manager: {
      transaction: async (work: (t: typeof tx) => unknown) => {
        // The double has no rollback: a refused removal writes nothing before it throws.
        const pending = owed.length;
        try {
          return await work(tx);
        } catch (e) {
          owed.splice(pending);
          throw e;
        } finally {
          held = false;
        }
      },
    },
    query: (sql: string, params: unknown[] = []) => {
      if (sql.includes('SELECT') && sql.includes('distribution_evictions_owed')) {
        return Promise.resolve(owed.map((r) => ({ ...r })));
      }
      if (sql.includes('DELETE FROM distribution_evictions_owed')) {
        const at = owed.findIndex((r) => r.token === params[0]);
        if (at >= 0) owed.splice(at, 1);
      }
      return Promise.resolve([]);
    },
  });

  return { owed, lockHeld: () => held, lockQueries };
}
