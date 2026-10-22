import { Channel } from './entities/channel.entity';
import { ChannelMember } from './entities/channel-member.entity';

/** How a departure ended, keyed `groupId:userId:departure`, as `distribution_departures` holds it. */
export type DecidedDepartures = Map<string, 'departed' | 'cancelled'>;

/**
 * A fake of the manager `ChannelService.departDistributionGroups` and `decideDistributionDeparture`
 * run on - `memberRepo.manager` in the specs.
 *
 * `distribution_departures` is the map `decided`, with its primary key's one rule: the first writer
 * of a `groupId:userId:departure` wins and every later insert does nothing. That rule is the whole
 * mechanism (a cancelled departure's roster write is refused), so the fake keeps it and nothing else.
 * The transaction hands its callback a manager whose `getRepository` returns the spec's own channel
 * and member fakes, so the roster write lands where the spec's assertions read.
 */
export function fakeDepartureManager(repos: () => { channelRepo: unknown; memberRepo: unknown }): {
  query: jest.Mock;
  transaction: jest.Mock;
  decided: DecidedDepartures;
} {
  const decided: DecidedDepartures = new Map();
  const keyOf = (params: unknown[]) => params.slice(0, 3).map(String).join(':');
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    const key = keyOf(params);
    if (sql.includes('INSERT INTO distribution_departures')) {
      if (decided.has(key)) return [];
      decided.set(key, sql.includes("'departed'") ? 'departed' : 'cancelled');
      return [{ departure: params[2] }];
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
  const transaction = jest.fn(async (cb: (m: unknown) => Promise<unknown>) =>
    cb({ query, getRepository })
  );
  return { query, transaction, decided };
}
