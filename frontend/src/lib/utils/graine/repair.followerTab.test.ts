// @vitest-environment happy-dom
const state = vi.hoisted(() => ({ follower: true, promoted: false }));
vi.mock('$lib/mls-client/stateAuthority', () => ({
  refusesCommitsHere: () => state.follower,
  promotedSinceLoad: () => state.promoted,
}));
const delegateCommitToLeader = vi.hoisted(() => vi.fn());
vi.mock('$lib/utils/chat/tabCommitDelegation', () => ({ delegateCommitToLeader }));
const requireGraineRuntime = vi.hoisted(() => vi.fn());
vi.mock('./runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./runtime')>()),
  requireGraineRuntime,
}));

import {
  forgetSeedsHandedToLeader,
  noteMissingSeed,
  requestCommunityHistory,
  resetGraineRepairState,
} from './repair';

/**
 * A FOLLOWER TAB ASKS NOBODY FOR A SEED ITSELF (2026-11-11): the ask is an MLS frame on the key
 * group, which only the leader's copy sends, and the answer reaches the leader's socket. The want is
 * handed to the leader once, and a refused handover lets the next row hand it again.
 */
describe('Graine repair in a follower tab', () => {
  beforeEach(() => {
    state.follower = true;
    state.promoted = false;
    resetGraineRepairState();
    vi.clearAllMocks();
  });

  it('hands a missing seed to the leader once, and runs no repair of its own', async () => {
    delegateCommitToLeader.mockResolvedValue({ status: 'done', value: 'noted' });

    noteMissingSeed('chan-1', 'sess-1', 'Author', 1000);
    noteMissingSeed('chan-1', 'sess-1', 'Author', 2000);
    await new Promise((r) => setTimeout(r, 0));

    expect(delegateCommitToLeader).toHaveBeenCalledTimes(1);
    expect(delegateCommitToLeader).toHaveBeenCalledWith({
      kind: 'note-missing-seeds',
      channelId: 'chan-1',
      seeds: [{ sessionId: 'sess-1', senderId: 'Author', sentAt: 1000, reason: 'unreadable-row' }],
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
    await new Promise((r) => setTimeout(r, 0));

    expect(delegateCommitToLeader).toHaveBeenCalledTimes(2);
  });

  it('N seeds of one channel named while a handover is in flight leave as ONE record', async () => {
    let answerFirst: (v: unknown) => void = () => {};
    delegateCommitToLeader
      .mockImplementationOnce(() => new Promise((r) => (answerFirst = r)))
      .mockResolvedValue({ status: 'done', value: 'noted' });

    noteMissingSeed('chan-1', 'sess-a', 'author', undefined);
    await new Promise((r) => setTimeout(r, 0));
    for (const id of ['sess-b', 'sess-c', 'sess-d']) noteMissingSeed('chan-1', id, 'author', 5);
    noteMissingSeed('chan-2', 'sess-z', 'author', 5);
    await new Promise((r) => setTimeout(r, 0));
    answerFirst({ status: 'done', value: 'noted' });
    await new Promise((r) => setTimeout(r, 0));

    const calls = delegateCommitToLeader.mock.calls.map(([op]) => [
      op.channelId,
      op.seeds.map((seed: { sessionId: string }) => seed.sessionId),
    ]);
    expect(calls).toEqual([
      ['chan-1', ['sess-a']],
      ['chan-2', ['sess-z']],
      ['chan-1', ['sess-b', 'sess-c', 'sess-d']],
    ]);
  });

  it('a seed handed to a leader that has since changed is handed again by its next row', async () => {
    delegateCommitToLeader.mockResolvedValue({ status: 'done', value: 'noted' });
    vi.spyOn(console, 'info').mockImplementation(() => {});

    noteMissingSeed('chan-1', 'sess-3', 'author', 1);
    await new Promise((r) => setTimeout(r, 0));
    noteMissingSeed('chan-1', 'sess-3', 'author', 1);
    await new Promise((r) => setTimeout(r, 0));
    expect(delegateCommitToLeader).toHaveBeenCalledTimes(1);

    // The election says the leader tab changed: the previous one's memory of the ask is gone.
    forgetSeedsHandedToLeader();
    noteMissingSeed('chan-1', 'sess-3', 'author', 1);
    await new Promise((r) => setTimeout(r, 0));
    expect(delegateCommitToLeader).toHaveBeenCalledTimes(2);
  });

  it('a tab promoted in place, its reload owed, hands nothing over', async () => {
    state.promoted = true;
    noteMissingSeed('chan-1', 'sess-4', 'author', 1);
    await new Promise((r) => setTimeout(r, 0));
    expect(delegateCommitToLeader).not.toHaveBeenCalled();
  });

  it('asks no community history', async () => {
    await requestCommunityHistory('ws-1');
    expect(requireGraineRuntime).not.toHaveBeenCalled();
    expect(delegateCommitToLeader).not.toHaveBeenCalled();
  });
});
