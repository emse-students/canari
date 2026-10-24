// @vitest-environment happy-dom
import { keepInviteFragment, takeInviteFragment } from './inviteFragment';

/**
 * An invite link's fragment survives the sign-in between opening the link and joining, in this tab
 * only, and is taken exactly once (channel-encryption section 25).
 */
describe('the invite link fragment', () => {
  beforeEach(() => {
    sessionStorage.clear();
    history.replaceState(null, '', '/c/join/tok');
  });

  it('is read from the address, ahead of a kept one, and the kept one is consumed', () => {
    keepInviteFragment('tok', 'older-bytes');
    history.replaceState(null, '', '/c/join/tok#grant-bytes');

    expect(takeInviteFragment('tok', window.location.hash)).toBe('grant-bytes');
    expect(takeInviteFragment('tok', '')).toBe('');
  });

  it('survives a sign-in for its own link, once', () => {
    keepInviteFragment('tok', 'grant-bytes');

    expect(takeInviteFragment('tok', '')).toBe('grant-bytes');
    expect(takeInviteFragment('tok', '')).toBe('');
  });

  it('is not handed to another link, and is dropped', () => {
    keepInviteFragment('tok', 'grant-bytes');

    expect(takeInviteFragment('other', '')).toBe('');
    expect(takeInviteFragment('tok', '')).toBe('');
  });

  it('keeps nothing for a link that carried nothing', () => {
    keepInviteFragment('tok', '');

    expect(sessionStorage.length).toBe(0);
    expect(takeInviteFragment('tok', '')).toBe('');
  });
});
