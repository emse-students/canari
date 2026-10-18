import {
  announceAccountDeleted,
  listenForAccountDeletedElsewhere,
  onAccountDeletedElsewhere,
} from './deletedAccountGuards';

vi.mock('$lib/utils/accountLocalWipe', () => ({ resumePendingDeletedAccountWipes: vi.fn() }));

describe('onAccountDeletedElsewhere', () => {
  it('ends the session of a tab signed in as the deleted account', async () => {
    const endSession = vi.fn(async () => {});
    const ended = await onAccountDeletedElsewhere(
      { type: 'account_deleted', userId: 'user-a' },
      { currentUserId: () => 'user-a', endSession }
    );
    expect(ended).toBe(true);
    expect(endSession).toHaveBeenCalledWith('user-a');
  });

  it('leaves a tab signed in as another account alone', async () => {
    const endSession = vi.fn(async () => {});
    const ended = await onAccountDeletedElsewhere(
      { type: 'account_deleted', userId: 'user-a' },
      { currentUserId: () => 'user-b', endSession }
    );
    expect(ended).toBe(false);
    expect(endSession).not.toHaveBeenCalled();
  });

  it('ignores a malformed notice', async () => {
    const endSession = vi.fn(async () => {});
    for (const bad of [null, {}, { type: 'account_deleted' }, { type: 'x', userId: 'user-a' }]) {
      expect(
        await onAccountDeletedElsewhere(bad, { currentUserId: () => 'user-a', endSession })
      ).toBe(false);
    }
    expect(endSession).not.toHaveBeenCalled();
  });
});

describe('the cross-tab channel', () => {
  it('carries a deletion from one tab to another', async () => {
    const endSession = vi.fn(async () => {});
    const stop = listenForAccountDeletedElsewhere({ currentUserId: () => 'user-a', endSession });
    announceAccountDeleted('user-a');
    await vi.waitFor(() => expect(endSession).toHaveBeenCalledWith('user-a'));
    stop();
  });
});
