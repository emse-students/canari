const showToast = vi.hoisted(() => vi.fn());
vi.mock('$lib/stores/toast.svelte', () => ({ showToast }));

import { FollowerTabCommitError } from '$lib/mls-client/commitSubmission';
import { m } from '$lib/paraglide/messages';
import { leaveKeyGroupToMainTab } from './followerTabKeyGroup';

/**
 * A follower tab may neither create nor join a key group (`FollowerTabCommitError`, from
 * `BaseMlsService.createGroup` and `externalJoin`). The member is told when they asked for it; a load
 * logs it and goes on, since every follower tab meets it on every load.
 */
describe('leaveKeyGroupToMainTab', () => {
  beforeEach(() => {
    showToast.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('tells the member to use the main tab, on a gesture', () => {
    leaveKeyGroupToMainTab(new FollowerTabCommitError('g-1'), 'the salon s-1', { gesture: true });
    expect(showToast).toHaveBeenCalledExactlyOnceWith(m.chat_error_follower_tab());
  });

  it('logs and goes on, on a load', () => {
    const log = vi.fn();
    leaveKeyGroupToMainTab(new FollowerTabCommitError('g-1'), 'the key group of w-1', {
      gesture: false,
      log,
    });
    expect(showToast).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('the key group of w-1'));
  });

  it('rethrows every other failure untouched', () => {
    const other = new Error('network');
    expect(() => leaveKeyGroupToMainTab(other, 'x', { gesture: true })).toThrow(other);
    expect(showToast).not.toHaveBeenCalled();
  });
});
