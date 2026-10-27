// @vitest-environment happy-dom
import { flushSync } from 'svelte';
import { createReadMarkDebounce, createReadingTracker } from './readMarkDebounce';

/**
 * LEAVING A CONVERSATION INSIDE ITS READ-MARK WINDOW DELIVERS THAT CONVERSATION'S MARK (2026-10-27).
 *
 * `MainChatPage`'s receipt effect used to detect the leave in its TEARDOWN, with
 * `convs.selectedContact !== currentContact`. Svelte hands a `$state` read in a teardown the value the
 * effect last saw, so that comparison was never true: nothing was flushed, and the next
 * conversation's note raised the OLD window, whose callback (A's) stayed armed. The second case pins
 * that Svelte behaviour, the first drives the tracker the way the effect now does.
 */
vi.mock('$lib/utils/sessionLog', () => ({ appendLog: vi.fn() }));

describe('the receipt effect leaving a conversation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers A's pending mark to A's callback before B's note, at the run the selection moved", () => {
    const readMarks = createReadMarkDebounce(2000);
    const reading = createReadingTracker();
    const delivered: string[] = [];
    let selected = $state('A');
    const stop = $effect.root(() => {
      $effect(() => {
        const ended = reading.left(selected);
        if (ended) readMarks.flush();
        const contact = selected;
        reading.arm({ contact, salon: false });
        readMarks.note(contact === 'A' ? 100 : 200, (at) => delivered.push(`${contact}@${at}`));
      });
    });
    try {
      flushSync();
      expect(delivered).toEqual([]);

      selected = 'B';
      flushSync();
      expect(delivered).toEqual(['A@100']);

      vi.advanceTimersByTime(2000);
      expect(delivered).toEqual(['A@100', 'B@200']);
    } finally {
      stop();
    }
  });

  it('pins why the teardown could not see the leave: a $state read there returns the old value', () => {
    let selected = $state('A');
    const seenInTeardown: string[] = [];
    const stop = $effect.root(() => {
      $effect(() => {
        void selected;
        return () => seenInTeardown.push(selected);
      });
    });
    try {
      flushSync();
      selected = 'B';
      flushSync();
      expect(seenInTeardown).toEqual(['A']);
    } finally {
      stop();
    }
  });
});
