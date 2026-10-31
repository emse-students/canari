import {
  anchorShift,
  chatViewCountLine,
  firstRowBelow,
  isPinnedToBottom,
  keyboardChangeResponse,
  respondToNewMessage,
  THREAD_BOTTOM_SLACK_PX,
  threadGrowthResponse,
  threadReach,
  type NewMessageState,
  type ThreadGrowth,
} from './threadAnchor';

const settled: ThreadGrowth = {
  previousReach: 1000,
  currentReach: 1000,
  wasNearBottom: true,
  isLoadingOlder: false,
  isEntering: false,
};

/** A reaction chip is about 28 px of row - the growth the message count could never see. */
const grew = (by = 28): ThreadGrowth => ({ ...settled, currentReach: 1000 + by });

describe('threadReach', () => {
  it('is the largest scrollTop', () => {
    expect(threadReach({ scrollHeight: 2000, scrollTop: 0, clientHeight: 600 })).toBe(1400);
  });

  /**
   * THE KEYBOARD CASE (production 1.1.2, Android, 2026-10-09). The soft keyboard takes 330 px of the
   * pane's BOX and leaves the content alone: `scrollHeight` is the same number before and after, so
   * a judgement keyed on it saw no growth, the reader kept their `scrollTop` and the last messages
   * ended under the keyboard. The reach moves by exactly the lost box.
   */
  it('grows when the box shrinks under unchanged content, which a scrollHeight cannot see', () => {
    const before = { scrollHeight: 2000, scrollTop: 1400, clientHeight: 600 };
    const after = { ...before, clientHeight: 270 };
    expect(after.scrollHeight).toBe(before.scrollHeight);
    expect(threadReach(after) - threadReach(before)).toBe(330);
    expect(
      threadGrowthResponse({
        ...settled,
        previousReach: threadReach(before),
        currentReach: threadReach(after),
      })
    ).toBe('follow-bottom');
  });

  it('leaves a reader who had gone up where they are when the keyboard rises', () => {
    expect(
      threadGrowthResponse({
        ...settled,
        previousReach: 1400,
        currentReach: 1730,
        wasNearBottom: false,
      })
    ).toBe('keep-row');
  });
});

describe('threadGrowthResponse', () => {
  it('follows the bottom when a row grows under a reader who was at the bottom', () => {
    expect(threadGrowthResponse(grew())).toBe('follow-bottom');
  });

  it('leaves a reader who is reading history to the row anchor', () => {
    expect(threadGrowthResponse({ ...grew(), wasNearBottom: false })).toBe('keep-row');
  });

  it('does nothing when the reach has not changed', () => {
    expect(threadGrowthResponse(settled)).toBe('hold-bottom');
  });

  /**
   * THE SHRINK UNDER THE KEYBOARD (Pixel 6a, 1.5.1, 2026-10-30; reproduced on the Mi 9T). A photo
   * capped at `60svh` shrank by 214 px when the Android WebView resized for a 357 px keyboard. As a
   * `keep-row` the anchor scrolled the pinned thread UP by those 214 px; a reader at the bottom
   * stays at the bottom whichever way the reach moves.
   */
  it('keeps a reader at the bottom there when a row shrinks', () => {
    expect(threadGrowthResponse({ ...settled, currentReach: 1000 - 214 })).toBe('follow-bottom');
  });

  it('leaves a reader in history to the row anchor when a row shrinks', () => {
    expect(threadGrowthResponse({ ...settled, currentReach: 972, wasNearBottom: false })).toBe(
      'keep-row'
    );
  });

  /**
   * THE ONE CASE WHERE GROWTH MEANS THE OPPOSITE, and the reason this is a predicate rather than a
   * comparison at the call site: `loadOlderGroups` adds height ABOVE the reader and puts `scrollTop`
   * back by exactly that much. On a conversation short enough for the reader to be near the bottom
   * while also being near the top, following the bottom would discard the history it just fetched.
   */
  it('refuses while older messages are being prepended, even from the bottom', () => {
    expect(threadGrowthResponse({ ...grew(4000), isLoadingOlder: true })).toBe('keep-row');
  });

  it('refuses while the conversation is still being entered', () => {
    expect(threadGrowthResponse({ ...grew(4000), isEntering: true })).toBe('keep-row');
  });

  it('is decided by the reach moving, never by how much', () => {
    expect(threadGrowthResponse(grew(1))).toBe('follow-bottom');
    expect(threadGrowthResponse(grew(5000))).toBe('follow-bottom');
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

  it('reports content above that SHRANK too, so the row the reader sees stays put', () => {
    // An old message's frame taking its measured ratio - a 16:9 clip in a 4:3 fallback box - is a
    // shrink above the reader, and it moved what they were reading up by the difference.
    expect(anchorShift({ ...base, currentTop: 120 })).toBe(-280);
  });

  it('reports nothing when the anchor is gone or was never taken', () => {
    expect(anchorShift({ ...base, currentTop: null })).toBe(0);
    expect(anchorShift({ ...base, previousTop: null })).toBe(0);
  });

  it('defers to the entry pin, which owns the position until it lands', () => {
    expect(anchorShift({ ...base, currentTop: 2600, isEntering: true })).toBe(0);
  });
});

describe('firstRowBelow', () => {
  // Rows 100 px tall, stacked from 0: row i spans [100i, 100i + 100).
  const bottoms = (count: number) => Array.from({ length: count }, (_, i) => 100 * i + 100);

  it('picks the row the viewport top cuts through, not the topmost rendered one', () => {
    const b = bottoms(50);
    expect(firstRowBelow(b.length, (i) => b[i], 1234)).toBe(12);
  });

  it('skips a row whose bottom sits exactly on the line - it is no longer visible', () => {
    const b = bottoms(50);
    expect(firstRowBelow(b.length, (i) => b[i], 300)).toBe(3);
  });

  it('answers the first row at the top of the pane and -1 past the last', () => {
    const b = bottoms(5);
    expect(firstRowBelow(b.length, (i) => b[i], -10)).toBe(0);
    expect(firstRowBelow(b.length, (i) => b[i], 10_000)).toBe(-1);
    expect(firstRowBelow(0, () => 0, 0)).toBe(-1);
  });

  it('reads log n rows, not all of them', () => {
    const b = bottoms(1024);
    let reads = 0;
    firstRowBelow(b.length, (i) => (reads++, b[i]), 51_234);
    expect(reads).toBeLessThanOrEqual(11);
  });
});

describe('chatViewCountLine', () => {
  it('is silent while the count holds, one line per change otherwise', () => {
    expect(chatViewCountLine('abcdef0123456789', 3, 3, null)).toBeNull();
    expect(chatViewCountLine('abcdef0123456789', 3, 4, 'follow-bottom')).toBe(
      'abcdef01 messages 4 (hasNewMessage=true, response=follow-bottom)'
    );
    expect(chatViewCountLine('abcdef0123456789', 4, 2, null)).toBe(
      'abcdef01 messages 2 (hasNewMessage=false, response=n/a)'
    );
  });
});

describe('keyboardChangeResponse', () => {
  it('a keyboard rising for a focused composer goes to the end, wherever the reader was', () => {
    // The Android case: the field stayed focused after Back, the reader was 138 px up (> the slack),
    // and the next tap raised the keyboard with no focus event - the last messages went under it.
    for (const isNearBottom of [true, false]) {
      expect(
        keyboardChangeResponse({
          wasOpen: false,
          isOpen: true,
          composerFocused: true,
          isNearBottom,
        })
      ).toBe('follow-bottom');
    }
  });

  it('a keyboard rising for another field moves nothing', () => {
    expect(
      keyboardChangeResponse({
        wasOpen: false,
        isOpen: true,
        composerFocused: false,
        isNearBottom: true,
      })
    ).toBe('stay');
  });

  it('a keyboard falling follows only a reader at the bottom', () => {
    expect(
      keyboardChangeResponse({
        wasOpen: true,
        isOpen: false,
        composerFocused: true,
        isNearBottom: true,
      })
    ).toBe('follow-bottom');
    expect(
      keyboardChangeResponse({
        wasOpen: true,
        isOpen: false,
        composerFocused: true,
        isNearBottom: false,
      })
    ).toBe('stay');
  });

  it('no change of the keyboard is no response', () => {
    for (const isOpen of [true, false]) {
      expect(
        keyboardChangeResponse({
          wasOpen: isOpen,
          isOpen,
          composerFocused: true,
          isNearBottom: true,
        })
      ).toBe('stay');
    }
  });
});
