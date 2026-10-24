import { Channel } from './entities/channel.entity';
import { ChannelMember } from './entities/channel-member.entity';

/** How a departure ended, keyed `groupId:userId:departure`, as `distribution_departures` holds it. */
export type DecidedDepartures = Map<string, 'departed' | 'cancelled'>;

/**
 * A fake of the manager `ChannelService.departDistributionGroups` and `decideDistributionDeparture`
 * run on - `memberRepo.manager` in the specs.
 *
 * WIRING, NOT THE RACE. Its job is to let the unit specs run the roster write: the transaction hands
 * its callback a manager whose `getRepository` returns the spec's own channel and member fakes, so
 * the write lands where the spec's assertions read. `distribution_departures` is the map `decided`,
 * keeping only its primary key's rule (the first writer of a `groupId:userId:departure` wins) so the
 * error path's steps can be pinned. The concurrency itself is proven on PostgreSQL, in
 * `distribution-departure.integration.spec.ts`.
 */
export function fakeDepartureManager(repos: () => { channelRepo: unknown; memberRepo: unknown }): {
  query: jest.Mock;
  transaction: jest.Mock;
  decided: DecidedDepartures;
  /** Every community removal lock taken, in order. */
  locks: string[];
} {
  const decided: DecidedDepartures = new Map();
  const locks: string[] = [];
  const keyOf = (params: unknown[]) => params.slice(0, 3).map(String).join(':');
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    const key = keyOf(params);
    if (sql.includes('INSERT INTO distribution_departures')) {
      if (decided.has(key)) return [];
      decided.set(key, sql.includes("'departed'") ? 'departed' : 'cancelled');
      return [{ departure: params[2] }];
    }
    if (sql.includes('pg_advisory_xact_lock')) {
      locks.push(`community_removal:${String(params[0])}`);
      return [];
    }
    if (sql.includes('DELETE FROM distribution_departures')) {
      const groups = params[0] as string[];
      for (const k of decided.keys()) {
        if (groups.includes(k.split(':')[0])) decided.delete(k);
      }
      return [];
    }
    if (sql.includes('SELECT "outcome" FROM distribution_departures')) {
      const outcome = decided.get(key);
      return outcome ? [{ outcome }] : [];
    }
    throw new Error(`fakeDepartureManager: unexpected query ${sql}`);
  });
  const getRepository = (entity: unknown) => {
    if (entity === Channel) return repos().channelRepo;
    if (entity === ChannelMember) return repos().memberRepo;
    throw new Error(`fakeDepartureManager: no repository for ${String(entity)}`);
  };
  // A callback that throws rolls back what it recorded, as the real transaction does.
  const transaction = jest.fn(async (cb: (m: unknown) => Promise<unknown>) => {
    const before = new Map(decided);
    try {
      return await cb({ query, getRepository });
    } catch (e) {
      decided.clear();
      before.forEach((outcome, key) => decided.set(key, outcome));
      throw e;
    }
  });
  return { query, transaction, decided, locks };
}
