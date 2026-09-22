import {
  isPinnedToBottom,
  shouldFollowThreadBottom,
  THREAD_BOTTOM_SLACK_PX,
  type ThreadGrowth,
} from './threadAnchor';

const settled: ThreadGrowth = {
  previousHeight: 1000,
  currentHeight: 1000,
  wasNearBottom: true,
  isLoadingOlder: false,
  isEntering: false,
};

/** A reaction chip is about 28 px of row - the growth the message count could never see. */
const grew = (by = 28): ThreadGrowth => ({ ...settled, currentHeight: 1000 + by });

describe('shouldFollowThreadBottom', () => {
  it('follows the bottom when a row grows under a reader who was at the bottom', () => {
    expect(shouldFollowThreadBottom(grew())).toBe(true);
  });

  it('leaves a reader who is reading history exactly where they are', () => {
    expect(shouldFollowThreadBottom({ ...grew(), wasNearBottom: false })).toBe(false);
  });

  it('does nothing when the height has not changed', () => {
    expect(shouldFollowThreadBottom(settled)).toBe(false);
  });

  /**
   * A row that SHRINKS pulls the bottom up by itself. Pinning would be a second movement for one
   * change, and it would move the reader who had scrolled away.
   */
  it('does nothing when a row shrinks - the bottom already came to meet the reader', () => {
    expect(shouldFollowThreadBottom({ ...settled, currentHeight: 972 })).toBe(false);
  });

  /**
   * THE ONE CASE WHERE GROWTH MEANS THE OPPOSITE, and the reason this is a predicate rather than a
   * comparison at the call site: `loadOlderGroups` adds height ABOVE the reader and puts `scrollTop`
   * back by exactly that much. On a conversation short enough for the reader to be near the bottom
   * while also being near the top, following the bottom would discard the history it just fetched.
   */
  it('refuses while older messages are being prepended, even from the bottom', () => {
    expect(shouldFollowThreadBottom({ ...grew(4000), isLoadingOlder: true })).toBe(false);
  });

  it('refuses while the conversation is still being entered', () => {
    expect(shouldFollowThreadBottom({ ...grew(4000), isEntering: true })).toBe(false);
  });

  it('is decided by the height alone, never by how much it grew', () => {
    expect(shouldFollowThreadBottom(grew(1))).toBe(true);
    expect(shouldFollowThreadBottom(grew(5000))).toBe(true);
  });
});

describe('isPinnedToBottom', () => {
  /** A pane 600 px tall over 2000 px of thread: 1400 is the bottom. */
  const at = (scrollTop: number) => ({ scrollHeight: 2000, scrollTop, clientHeight: 600 });

  it('is true at the bottom', () => {
    expect(isPinnedToBottom(at(1400))).toBe(true);
  });

  it('is true within the slack, false one pixel past it', () => {
    expect(isPinnedToBottom(at(1400 - (THREAD_BOTTOM_SLACK_PX - 1)))).toBe(true);
    expect(isPinnedToBottom(at(1400 - THREAD_BOTTOM_SLACK_PX))).toBe(false);
  });

  it('is false for a reader who has gone up to read history', () => {
    expect(isPinnedToBottom(at(0))).toBe(false);
  });

  it('is true for a thread shorter than its own pane', () => {
    expect(isPinnedToBottom({ scrollHeight: 300, scrollTop: 0, clientHeight: 600 })).toBe(true);
  });

  /**
   * THE COMPOSER AND THE CONTENT ARE THE SAME QUANTITY. `scrollHeight` includes `padding-bottom`,
   * which is `--chat-composer-height`: a composer growing by one line moves the reader off the
   * bottom exactly as a new row would, which is what lets one predicate answer for both.
   */
  it('reads composer growth as thread growth', () => {
    const before = { scrollHeight: 2000, scrollTop: 1400, clientHeight: 600 };
    expect(isPinnedToBottom(before)).toBe(true);
    const composerGrewByTwoLines = { ...before, scrollHeight: 2000 + THREAD_BOTTOM_SLACK_PX };
    expect(isPinnedToBottom(composerGrewByTwoLines)).toBe(false);
  });
});
