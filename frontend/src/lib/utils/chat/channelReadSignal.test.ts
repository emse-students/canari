import { describe, it, expect, beforeEach } from 'vitest';
import {
  claimChannelReadSignal,
  newestForeignMessageAt,
  resetChannelReadSignals,
} from './channelReadSignal';

/**
 * The guard that decides whether this device owes its siblings a read receipt.
 *
 * The case that matters is the one the old guard could not see, and it is asserted first: a message
 * read the instant it arrives, in a salon that was already open, so no unread counter ever moved.
 */
describe('channelReadSignal', () => {
  const CHANNEL = 'channel_abc';
  beforeEach(() => resetChannelReadSignals());

  it('owes a receipt for a message read on arrival, with no unread count involved', () => {
    expect(claimChannelReadSignal(CHANNEL, 1000)).toBe(true);
  });

  it('owes nothing twice for the same message', () => {
    expect(claimChannelReadSignal(CHANNEL, 1000)).toBe(true);
    expect(claimChannelReadSignal(CHANNEL, 1000)).toBe(false);
    // An idle re-open reads nothing newer, and must not push to this account's own devices again.
    expect(claimChannelReadSignal(CHANNEL, 900)).toBe(false);
  });

  it('owes a receipt again as soon as something newer has been read', () => {
    expect(claimChannelReadSignal(CHANNEL, 1000)).toBe(true);
    expect(claimChannelReadSignal(CHANNEL, 1001)).toBe(true);
  });

  it('keeps one marker per salon', () => {
    expect(claimChannelReadSignal(CHANNEL, 1000)).toBe(true);
    expect(claimChannelReadSignal('channel_other', 500)).toBe(true);
  });

  /** A salon with nothing in it yet, or one holding only our own messages, owes nothing. */
  it('owes nothing when there is no foreign message to acknowledge', () => {
    expect(claimChannelReadSignal(CHANNEL, 0)).toBe(false);
    expect(claimChannelReadSignal(CHANNEL, Number.NaN)).toBe(false);
  });

  it('forgets everything when the session ends', () => {
    expect(claimChannelReadSignal(CHANNEL, 1000)).toBe(true);
    resetChannelReadSignals();
    expect(claimChannelReadSignal(CHANNEL, 1000)).toBe(true);
  });

  describe('newestForeignMessageAt', () => {
    const msg = (senderId: string, t: number) => ({ senderId, timestamp: new Date(t) });

    /** My own last message must not advance the marker: nobody was ever notified of it. */
    it('skips the messages this user wrote', () => {
      const messages = [msg('them', 1000), msg('me', 2000), msg('me', 3000)];
      expect(newestForeignMessageAt(messages, 'me')).toBe(1000);
    });

    it('is the newest foreign message, not the first found', () => {
      const messages = [msg('them', 1000), msg('me', 2000), msg('other', 2500)];
      expect(newestForeignMessageAt(messages, 'me')).toBe(2500);
    });

    /** Ids travel in both cases across the fleet; a mismatch here would signal on our own sends. */
    it('compares user ids case-insensitively', () => {
      expect(newestForeignMessageAt([msg('ME', 1000)], 'me')).toBe(0);
    });

    it('is zero for an empty salon and for one holding only our own messages', () => {
      expect(newestForeignMessageAt([], 'me')).toBe(0);
      expect(newestForeignMessageAt([msg('me', 1000)], 'me')).toBe(0);
    });
  });
});
