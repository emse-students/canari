import { addInFlightOf, readPendingMembershipFacts } from './pending-membership-facts';
import type { QueuedMessage } from '../entities/queued-message.entity';

/**
 * An add lock that could not be read is UNKNOWN, never "no Add": since 2026-10-30 `addInFlight` also
 * guards a key group's external-join door, and a `false` it cannot prove opens that door over an Add
 * in flight (channel-encryption section 20).
 */
describe('readPendingMembershipFacts - the add lock', () => {
  const repo = { find: jest.fn(async () => [{ groupId: 'g-2' } as QueuedMessage]) };
  const logger = { warn: jest.fn() };

  beforeEach(() => logger.warn.mockClear());

  it('answers held and free locks per group when Redis answers', async () => {
    const redis = { mget: jest.fn(async () => ['u:d#t', null]) };

    const facts = await readPendingMembershipFacts(repo, redis, 'web-1', ['g-1', 'g-2'], logger);

    expect(facts.lockUnread).toBe(false);
    expect(addInFlightOf(facts, 'g-1')).toBe(true);
    expect(addInFlightOf(facts, 'g-2')).toBe(false);
    expect(facts.welcomed.has('g-2')).toBe(true);
  });

  it('answers unknown for every group when Redis fails, and says so', async () => {
    const redis = { mget: jest.fn(async () => Promise.reject(new Error('ECONNRESET'))) };

    const facts = await readPendingMembershipFacts(repo, redis, 'web-1', ['g-1', 'g-2'], logger);

    expect(facts.lockUnread).toBe(true);
    expect(addInFlightOf(facts, 'g-1')).toBeUndefined();
    expect(addInFlightOf(facts, 'g-2')).toBeUndefined();
    // The Welcome half was read and stays an answer.
    expect(facts.welcomed.has('g-2')).toBe(true);
    expect(logger.warn.mock.calls.flat().join(' ')).toContain('addInFlight=unknown');
  });

  /**
   * THE LOCK IS READ BEFORE THE QUEUE. An Add queues its Welcome, then releases its lock; a queue
   * read before the insert and a lock read after the release would both answer "nothing" for a seat
   * the Add has just written. This replays that interleaving: the Welcome lands and the lock goes
   * between the two reads.
   */
  it('reads the add lock before the queued Welcomes, so an Add finishing between them is seen', async () => {
    // The admitter holds the lock with no Welcome queued yet, and finishes (queues its Welcome, then
    // releases the lock) right after whichever read comes first.
    const order: string[] = [];
    let addFinished = false;
    const afterRead = (what: string) => {
      order.push(what);
      addFinished = true;
    };
    const redis = {
      mget: jest.fn(async () => {
        const held = addFinished ? null : 'u:d#t';
        afterRead('lock');
        return [held];
      }),
    };
    const queue = {
      find: jest.fn(async () => {
        const rows = addFinished ? [{ groupId: 'g-1' } as QueuedMessage] : [];
        afterRead('queue');
        return rows;
      }),
    };

    const facts = await readPendingMembershipFacts(queue, redis, 'web-1', ['g-1'], logger);

    expect(order).toEqual(['lock', 'queue']);
    // Read queue-first, both reads would answer "nothing" here: a seat nothing follows.
    expect(addInFlightOf(facts, 'g-1') === true || facts.welcomed.has('g-1')).toBe(true);
  });
});
