const showToast = vi.hoisted(() => vi.fn());
vi.mock('$lib/stores/toast.svelte', () => ({ showToast }));
const leadership = vi.hoisted(() => ({ role: 'leader' as 'leader' | 'follower' | 'undecided' }));
vi.mock('$lib/mls-client/tabLeader', () => ({
  getTabLeadership: () => leadership.role,
  getIsTabLeader: () => leadership.role === 'leader',
}));
const delegateCommitToLeader = vi.hoisted(() => vi.fn());
vi.mock('$lib/utils/chat/tabCommitDelegation', () => ({ delegateCommitToLeader }));

import { FollowerTabCommitError } from '$lib/mls-client/commitSubmission';
import { m } from '$lib/paraglide/messages';
import { enterKeyGroupOnGesture, leaveKeyGroupToMainTab } from './followerTabKeyGroup';

const OP = { kind: 'enter-community-key-group', workspaceId: 'w-1' } as const;

/**
 * A key group entered on a GESTURE: the leader enters it here; a FOLLOWER hands it to the leader
 * (`tabCommitDelegation.ts`) and never enters it in its own copy. Decided by the role, before any
 * commit is attempted.
 */
describe('enterKeyGroupOnGesture', () => {
  beforeEach(() => {
    showToast.mockReset();
    delegateCommitToLeader.mockReset();
    leadership.role = 'leader';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('a leader enters here and hands nothing over', async () => {
    const enterHere = vi.fn(async () => {});
    await enterKeyGroupOnGesture(OP, enterHere);
    expect(enterHere).toHaveBeenCalledOnce();
    expect(delegateCommitToLeader).not.toHaveBeenCalled();
  });

  it('a follower hands the entry to the leader and never enters in its own copy', async () => {
    leadership.role = 'follower';
    delegateCommitToLeader.mockResolvedValue({ status: 'done', value: 'entered' });
    const enterHere = vi.fn(async () => {});
    await enterKeyGroupOnGesture(OP, enterHere);
    expect(delegateCommitToLeader).toHaveBeenCalledExactlyOnceWith(OP);
    expect(enterHere).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('a follower whose leader closed mid-entry is told so, by the reason', async () => {
    leadership.role = 'follower';
    delegateCommitToLeader.mockResolvedValue({ status: 'refused', reason: 'leader-gone' });
    await enterKeyGroupOnGesture(OP, async () => {});
    expect(showToast).toHaveBeenCalledExactlyOnceWith(m.chat_error_main_tab_gone(), 'warning');
  });

  it('a tab demoted between the role read and the commit is told to use the main tab', async () => {
    await enterKeyGroupOnGesture(OP, async () => {
      throw new FollowerTabCommitError('g-1');
    });
    expect(showToast).toHaveBeenCalledExactlyOnceWith(m.chat_error_follower_tab());
  });

  it('rethrows every other failure untouched', async () => {
    const other = new Error('network');
    await expect(
      enterKeyGroupOnGesture(OP, async () => {
        throw other;
      })
    ).rejects.toBe(other);
    expect(showToast).not.toHaveBeenCalled();
  });
});

/** A LOAD in a follower tab logs the refusal and goes on: the main tab's own load enters it. */
describe('leaveKeyGroupToMainTab', () => {
  beforeEach(() => showToast.mockReset());

  it('logs and goes on, saying nothing to the member', () => {
    const log = vi.fn();
    leaveKeyGroupToMainTab(new FollowerTabCommitError('g-1'), 'the key group of w-1', log);
    expect(showToast).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('the key group of w-1'));
  });

  it('rethrows every other failure untouched', () => {
    const other = new Error('network');
    expect(() => leaveKeyGroupToMainTab(other, 'x', vi.fn())).toThrow(other);
  });
});
