import { isUnreadForUser, countUnreadForUser } from './unread';

const peer = (over: Record<string, unknown> = {}) => ({
  isOwn: false,
  senderId: 'peer',
  readBy: [] as string[],
  ...over,
});

describe('isUnreadForUser', () => {
  it('counts a peer message nobody acknowledged', () => {
    expect(isUnreadForUser(peer(), 'me')).toBe(true);
  });

  it('does not count a message this user already read', () => {
    expect(isUnreadForUser(peer({ readBy: ['me'] }), 'me')).toBe(false);
  });

  it('normalises case on both sides of the readBy comparison', () => {
    expect(isUnreadForUser(peer({ readBy: ['ME'] }), 'me')).toBe(false);
  });

  it('still counts a message only OTHERS have read', () => {
    expect(isUnreadForUser(peer({ readBy: ['other', 'third'] }), 'me')).toBe(true);
  });

  it('never counts our own message, whatever its read state', () => {
    expect(isUnreadForUser(peer({ isOwn: true }), 'me')).toBe(false);
  });

  it('never counts a system message, flagged either way', () => {
    // Two encodings exist in the codebase: the isSystem flag and the 'system' sender.
    expect(isUnreadForUser(peer({ isSystem: true }), 'me')).toBe(false);
    expect(isUnreadForUser(peer({ senderId: 'system' }), 'me')).toBe(false);
  });

  it('tolerates a missing readBy', () => {
    expect(isUnreadForUser({ isOwn: false, senderId: 'peer' }, 'me')).toBe(true);
  });
});

describe('countUnreadForUser', () => {
  it('counts only what this user has not acknowledged', () => {
    // The history-bundle shape: a device rejoining with receipts for part of the history.
    const msgs = [
      peer({ readBy: ['me'] }),
      peer({ readBy: ['ME', 'other'] }),
      peer(),
      peer({ isOwn: true }),
      peer({ senderId: 'system' }),
    ];
    expect(countUnreadForUser(msgs, 'me')).toBe(1);
  });

  it('returns 0 on an empty history', () => {
    expect(countUnreadForUser([], 'me')).toBe(0);
  });
});
