const showToast = vi.hoisted(() => vi.fn());
vi.mock('$lib/stores/toast.svelte', () => ({ showToast }));

import { FollowerTabCommitError } from '$lib/mls-client/commitSubmission';
import { m } from '$lib/paraglide/messages';
import {
  conversationRefusalMessage,
  reportBulkAdditionRefusal,
  reportFollowerTabRefusal,
  reportLostInvitation,
  reportMemberRemovalFailure,
} from './conversationRefusalMessage';
import { MemberRemovalNotCommittedError } from './memberRemovalError';
import { CommitRefusedError } from '$lib/mls-client/CommitRefusedError';

/**
 * A COMMIT REFUSED IN A FOLLOWER TAB IS SOMETHING THE MEMBER CAN ACT ON, so it reaches them as a
 * sentence - read from the error's TYPE, never its text, and every other failure is left alone.
 */
describe('reportFollowerTabRefusal', () => {
  beforeEach(() => {
    showToast.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('tells the member to use the main tab when a follower tab refused the commit', () => {
    expect(reportFollowerTabRefusal(new FollowerTabCommitError('g-1'))).toBe(true);
    expect(showToast).toHaveBeenCalledExactlyOnceWith(m.chat_error_follower_tab());
  });

  it('reaches the follower-tab refusal a recorded removal carries as its cause, by type', () => {
    const wrapped = new MemberRemovalNotCommittedError(
      'g-1',
      'user-b',
      'commit-not-landed',
      new FollowerTabCommitError('g-1')
    );
    expect(reportFollowerTabRefusal(wrapped)).toBe(true);
    expect(showToast).toHaveBeenCalledExactlyOnceWith(m.chat_error_follower_tab());
  });

  it('leaves every other failure to its caller, whatever its text says', () => {
    const lookalike = new Error(new FollowerTabCommitError('g-1').message);
    expect(reportFollowerTabRefusal(lookalike)).toBe(false);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('gives the creation modal the same sentence for the follower-tab refusal', () => {
    expect(conversationRefusalMessage('follower-tab')).toBe(m.chat_error_follower_tab());
  });
});

/**
 * A REMOVAL THAT DID NOT COMPLETE REACHES THE MEMBER AS ONE OF TWO SENTENCES, read from the TYPE:
 * the person IS out and only the key change is late, or nothing was recorded and they are still in.
 */
describe('reportMemberRemovalFailure', () => {
  beforeEach(() => showToast.mockReset());

  it('says the person is removed and the key change follows, when only the commit is owed', () => {
    const e = new MemberRemovalNotCommittedError(
      'g-1',
      'user-b',
      'commit-not-landed',
      new Error('refused')
    );
    expect(reportMemberRemovalFailure(e)).toBe('recorded');
    expect(showToast).toHaveBeenCalledExactlyOnceWith(
      m.chat_group_remove_member_keys_pending(),
      'warning'
    );
  });

  it('says the removal failed for anything else - a bare commit refusal included', () => {
    expect(reportMemberRemovalFailure(new Error('503'))).toBe('not-removed');
    expect(reportMemberRemovalFailure(new CommitRefusedError('epoch_mismatch', 1, 2))).toBe(
      'not-removed'
    );
    expect(showToast).toHaveBeenCalledWith(m.chat_group_remove_member_failed());
  });
});

/**
 * AN INVITATION THAT ADDED NOBODY IS TOLD, NEVER ONLY LOGGED: a gesture has no durable row, so the
 * member is the one who retries it - a busy add lock and a lost race included (CC-4).
 */
describe('reportBulkAdditionRefusal', () => {
  beforeEach(() => {
    showToast.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('tells the member a busy add lock refused the invitation, so they retry it', () => {
    reportBulkAdditionRefusal('add-lock-busy');
    expect(showToast).toHaveBeenCalledExactlyOnceWith(m.chat_invite_error_add_lock_busy());
  });

  it('tells the member a lost commit race added nobody', () => {
    reportBulkAdditionRefusal('commit-race-lost');
    expect(showToast).toHaveBeenCalledExactlyOnceWith(m.chat_invite_error_commit_race_lost());
  });
});

/**
 * AN INVITATION KEPT ACROSS A LOST CONNECTION IS NEVER LOST SILENTLY (OFF-3): the gesture says it
 * will finish, and a re-plan that does not finish says so, naming the conversation the member is no
 * longer looking at.
 */
describe('reportLostInvitation and the kept invitation', () => {
  beforeEach(() => {
    showToast.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('the gesture whose Add got no answer is told it will finish, as a warning', () => {
    reportBulkAdditionRefusal('outcome-unknown');
    expect(showToast).toHaveBeenCalledExactlyOnceWith(
      m.chat_invite_pending_connection(),
      'warning'
    );
  });

  it('a person removed meanwhile is named as the reason', () => {
    reportLostInvitation({ kind: 'not-completed', reason: 'removed-meanwhile' }, 'Team');
    expect(showToast).toHaveBeenCalledExactlyOnceWith(
      m.chat_invite_resumed_removed_meanwhile({ conversation: 'Team' })
    );
  });

  it('every other ending asks the member to invite again', () => {
    reportLostInvitation({ kind: 'not-completed', reason: 'tree-unconfirmed' }, 'Team');
    expect(showToast).toHaveBeenCalledExactlyOnceWith(
      m.chat_invite_resumed_failed({ conversation: 'Team' })
    );
  });

  it('a GATE refusal (committer_not_member) never asks to invite again - re-inviting cannot work', () => {
    reportLostInvitation({ kind: 'refused', reason: 'committer_not_member' }, 'Team');
    expect(showToast).toHaveBeenCalledExactlyOnceWith(
      m.chat_invite_resumed_refused({ conversation: 'Team' })
    );
    expect(m.chat_invite_resumed_refused({ conversation: 'Team' })).not.toBe(
      m.chat_invite_resumed_failed({ conversation: 'Team' })
    );
  });

  it('a retired conversation is said as gone', () => {
    reportLostInvitation({ kind: 'conversation-gone' }, 'Team');
    expect(showToast).toHaveBeenCalledExactlyOnceWith(
      m.chat_invite_resumed_conversation_gone({ conversation: 'Team' })
    );
  });

  it('says nothing when it completed, when its commit is kept again, or while it waits', () => {
    reportLostInvitation({ kind: 'completed' }, 'Team');
    reportLostInvitation({ kind: 'kept' }, 'Team');
    reportLostInvitation({ kind: 'waiting' }, 'Team');
    expect(showToast).not.toHaveBeenCalled();
  });
});
