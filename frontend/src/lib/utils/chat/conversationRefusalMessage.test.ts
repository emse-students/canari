const showToast = vi.hoisted(() => vi.fn());
vi.mock('$lib/stores/toast.svelte', () => ({ showToast }));

import { FollowerTabCommitError } from '$lib/mls-client/commitSubmission';
import { m } from '$lib/paraglide/messages';
import { conversationRefusalMessage, reportFollowerTabRefusal } from './conversationRefusalMessage';

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

  it('leaves every other failure to its caller, whatever its text says', () => {
    const lookalike = new Error(new FollowerTabCommitError('g-1').message);
    expect(reportFollowerTabRefusal(lookalike)).toBe(false);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('gives the creation modal the same sentence for the follower-tab refusal', () => {
    expect(conversationRefusalMessage('follower-tab')).toBe(m.chat_error_follower_tab());
  });
});
