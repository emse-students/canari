/**
 * `pendingAddFactsOf` - the tree one sweep's automatic Adds of a group rest on. A CONFIRMED tree is
 * read once per pass (an epoch); an UNCONFIRMED one is the absence of an answer and is never kept,
 * so one failed confirmation does not abort every later row of the group (review of #2416).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IMlsService } from '$lib/mls-client/IMlsService';
import type { TreeReading } from './confirmedTree';

const readConfirmedTree = vi.fn<() => Promise<TreeReading>>();
vi.mock('./confirmedTree', () => ({
  readConfirmedTree: (..._args: unknown[]) => readConfirmedTree(),
}));

const { pendingAddFactsOf } = await import('./actions');

const service = (epoch = 4) =>
  ({
    getEpoch: () => epoch,
    getPendingInvitations: async () => [],
  }) as unknown as IMlsService;

const log = vi.fn();
const factsOf = (mlsService: IMlsService) =>
  pendingAddFactsOf({ mlsService, groupId: 'g1', userId: 'u1', myDeviceId: 'd1', log });

describe('pendingAddFactsOf', () => {
  beforeEach(() => {
    readConfirmedTree.mockReset();
    log.mockReset();
  });

  it('reads a confirmed tree once for every row of the pass', async () => {
    readConfirmedTree.mockResolvedValue({ status: 'read', identities: ['u1:d1'] });
    const facts = factsOf(service());
    await facts(false);
    await facts(false);
    expect(readConfirmedTree).toHaveBeenCalledTimes(1);
  });

  it('never keeps an unconfirmed tree: the next row reads afresh and may confirm it', async () => {
    readConfirmedTree
      .mockResolvedValueOnce({ status: 'unconfirmed' })
      .mockResolvedValueOnce({ status: 'read', identities: ['u1:d1'] });
    const facts = factsOf(service());
    expect((await facts(false)).tree).toEqual({ status: 'unconfirmed' });
    expect((await facts(false)).tree).toEqual({ status: 'read', identities: ['u1:d1'] });
    expect(readConfirmedTree).toHaveBeenCalledTimes(2);
    // The re-read is said once, on the sweep's own log, naming the group by 8 characters.
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('[PENDING] Group g1...: the pass tree was unconfirmed');
    // Once confirmed, the pass keeps it again.
    await facts(false);
    expect(readConfirmedTree).toHaveBeenCalledTimes(2);
  });
});
