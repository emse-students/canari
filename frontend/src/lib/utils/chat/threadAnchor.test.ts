import {
  anchorShift,
  isPinnedToBottom,
  respondToNewMessage,
  shouldFollowThreadBottom,
  THREAD_BOTTOM_SLACK_PX,
  type NewMessageState,
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

/**
 * WHO MAY MOVE THE READER WHEN A MESSAGE LANDS.
 *
 * Until 2026-09-23 four places answered this and three of them asked nothing: `useMessaging` ended
 * every persist, every batch and every finished catch-up drain with a bare
 * `scrollTop = scrollHeight`, on whichever conversation happened to be open. The cases below are
 * the ones a bad connection actually produces - frames trickling in for minutes while somebody is
 * scrolled up reading.
 */
const settledReader: NewMessageState = {
  entering: false,
  catchupActive: false,
  isNearBottom: true,
  ownMessageAdded: false,
};

describe('respondToNewMessage', () => {
  it('follows the bottom for a live message under a reader who is at the bottom', () => {
    expect(respondToNewMessage(settledReader)).toBe('follow-bottom');
  });

  it('follows the bottom for the reader own message, wherever they were', () => {
    expect(
      respondToNewMessage({ ...settledReader, isNearBottom: false, ownMessageAdded: true })
    ).toBe('follow-bottom');
  });

  it('leaves a reader who has gone up to read exactly where they are', () => {
    expect(respondToNewMessage({ ...settledReader, isNearBottom: false })).toBe('stay');
  });

  it('re-runs the entry pin while the conversation is still being entered', () => {
    // The initial page arriving late, on a cold start from a notification: the window is pinned
    // near zero and only this re-runs it forward.
    expect(respondToNewMessage({ ...settledReader, entering: true, isNearBottom: false })).toBe(
      'repin-entry'
    );
  });

  it('re-pins during a catch-up only while the reader has not left the bottom', () => {
    expect(respondToNewMessage({ ...settledReader, catchupActive: true })).toBe('repin-entry');
  });

  it('does not let a recovering connection take history away from a reader', () => {
    // The worst moment of the old blind jump: a drain finishing is exactly when a bad link has
    // just recovered, and the reader spent the outage scrolled up.
    expect(
      respondToNewMessage({ ...settledReader, catchupActive: true, isNearBottom: false })
    ).toBe('stay');
  });
});

describe('anchorShift', () => {
  const base = { previousTop: 400, currentTop: 400, isEntering: false };

  it('reports nothing when the anchored row has not moved', () => {
    expect(anchorShift(base)).toBe(0);
  });

  it('reports how far a prepend pushed the reader down', () => {
    // A peer scrollback answer, or the render window stepping up by 140 groups: the row the
    // reader is looking at slides down by the height of what appeared above it.
    expect(anchorShift({ ...base, currentTop: 2600 })).toBe(2200);
  });

  it('reports nothing when content above SHRANK, which pulls the reader up on its own', () => {
    expect(anchorShift({ ...base, currentTop: 120 })).toBe(0);
  });

  it('reports nothing when the anchor is gone or was never taken', () => {
    expect(anchorShift({ ...base, currentTop: null })).toBe(0);
    expect(anchorShift({ ...base, previousTop: null })).toBe(0);
  });

  it('defers to the entry pin, which owns the position until it lands', () => {
    expect(anchorShift({ ...base, currentTop: 2600, isEntering: true })).toBe(0);
  });
});
