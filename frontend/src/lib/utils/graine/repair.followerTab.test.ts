// @vitest-environment happy-dom
const state = vi.hoisted(() => ({ follower: true }));
vi.mock('$lib/mls-client/stateAuthority', () => ({ refusesCommitsHere: () => state.follower }));
const delegateCommitToLeader = vi.hoisted(() => vi.fn());
vi.mock('$lib/utils/chat/tabCommitDelegation', () => ({ delegateCommitToLeader }));
const requireGraineRuntime = vi.hoisted(() => vi.fn());
vi.mock('./runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./runtime')>()),
  requireGraineRuntime,
}));

import { noteMissingSeed, requestCommunityHistory, resetGraineRepairState } from './repair';

/**
 * A FOLLOWER TAB ASKS NOBODY FOR A SEED ITSELF (2026-11-11): the ask is an MLS frame on the key
 * group, which only the leader's copy sends, and the answer reaches the leader's socket. The want is
 * handed to the leader once, and a refused handover lets the next row hand it again.
 */
describe('Graine repair in a follower tab', () => {
  beforeEach(() => {
    state.follower = true;
    resetGraineRepairState();
    vi.clearAllMocks();
  });

  it('hands a missing seed to the leader once, and runs no repair of its own', async () => {
    delegateCommitToLeader.mockResolvedValue({ status: 'done', value: 'noted' });

    noteMissingSeed('chan-1', 'sess-1', 'Author', 1000);
    noteMissingSeed('chan-1', 'sess-1', 'Author', 2000);
    await Promise.resolve();

    expect(delegateCommitToLeader).toHaveBeenCalledTimes(1);
    expect(delegateCommitToLeader).toHaveBeenCalledWith({
      kind: 'note-missing-seed',
      channelId: 'chan-1',
      sessionId: 'sess-1',
      senderId: 'Author',
      sentAt: 1000,
      reason: 'unreadable-row',
    });
    // The repair's own flush needs the runtime (roster, key group): never reached here.
    expect(requireGraineRuntime).not.toHaveBeenCalled();
  });

  it('a handover the leader refused is handed again by the next row', async () => {
    delegateCommitToLeader.mockResolvedValue({ status: 'refused', reason: 'leader-unavailable' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    noteMissingSeed('chan-1', 'sess-2', 'author', undefined);
    await new Promise((r) => setTimeout(r, 0));
    noteMissingSeed('chan-1', 'sess-2', 'author', undefined);

    expect(delegateCommitToLeader).toHaveBeenCalledTimes(2);
  });

  it('asks no community history', async () => {
    await requestCommunityHistory('ws-1');
    expect(requireGraineRuntime).not.toHaveBeenCalled();
    expect(delegateCommitToLeader).not.toHaveBeenCalled();
  });
});
