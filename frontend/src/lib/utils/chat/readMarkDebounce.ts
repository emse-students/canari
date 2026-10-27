/**
 * The pending read mark of the conversation being read, held between the moment reading moves it
 * and the moment it is handed on (the MLS outbox for a DM or a group, the owed-mark queue for a
 * salon).
 *
 * WHY IT IS A MODULE. It used to be two variables and a timer inside `MainChatPage`'s receipt
 * effect, whose cleanup ZEROED the pending value when the reader left the conversation inside the
 * window. The local mark had already moved by then, so the next visit found nothing to announce:
 * a DM peer kept seeing the conversation unread for good. Leaving, and the app leaving the screen,
 * now DELIVER instead (`flush`), and a component cannot be unit-tested where a module can.
 *
 * THE WINDOW IS THE ONE CLOCK OF THE MECHANISM AND IT DECIDES ONLY WHEN, NEVER WHETHER. Every mark
 * noted is delivered by expiry or by `flush`, or covered by a higher one noted in the same window;
 * a mark is never lowered (`max`). See history-reconciliation, "The sender says only what is new".
 */
import { appendLog } from '$lib/utils/sessionLog';

/** Hands a mark on. */
export type DeliverReadMark = (at: number) => void;

/** The pending mark of one reading, and the three ways it ends. */
export interface ReadMarkDebounce {
  /**
   * Raises the pending mark to at least `at`. The first note of a window arms it with `deliver`,
   * which later notes in the same window do not replace: the window belongs to the reading that
   * opened it.
   */
  note: (at: number, deliver: DeliverReadMark) => void;
  /** Delivers the pending mark NOW - the reader left, or the app left the screen. */
  flush: () => void;
  /** Forgets the pending mark without delivering it, for a mark already owed elsewhere. */
  cancel: () => void;
  /** The pending mark, 0 when none. */
  readonly pending: number;
}

/** Creates the holder, with `windowMs` between the first note of a window and its delivery. */
export function createReadMarkDebounce(windowMs: number): ReadMarkDebounce {
  let pendingAt = 0;
  let deliverPending: DeliverReadMark | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function take(): { at: number; deliver: DeliverReadMark | null } {
    const taken = { at: pendingAt, deliver: deliverPending };
    if (timer) clearTimeout(timer);
    timer = null;
    pendingAt = 0;
    deliverPending = null;
    return taken;
  }

  function fire(early: boolean): void {
    const { at, deliver } = take();
    if (at <= 0 || !deliver) return;
    if (early) appendLog(`[READ] mark ${at} delivered before its window ended: the reading ended`);
    deliver(at);
  }

  return {
    note(at, deliver) {
      pendingAt = Math.max(pendingAt, at);
      if (timer) return;
      deliverPending = deliver;
      timer = setTimeout(() => fire(false), windowMs);
    },
    flush() {
      fire(true);
    },
    cancel() {
      const { at } = take();
      if (at > 0) appendLog(`[READ] mark ${at} left to the owed-mark queue, not delivered here`);
    },
    get pending() {
      return pendingAt;
    },
  };
}

/** The conversation whose read-mark window the receipt effect armed, and how its mark travels. */
export interface ReadingOf {
  contact: string;
  /** A salon's mark is owed durably to the server queue; a DM's or a group's goes to the outbox. */
  salon: boolean;
}

/** Remembers which conversation is being read, so the selection leaving it can end its window. */
export interface ReadingTracker {
  /** Records the conversation whose window was just armed. */
  arm: (reading: ReadingOf) => void;
  /**
   * The reading the selection has LEFT, returned once, or null. Asked at the START of the receipt
   * effect with the CURRENT selection - never from its teardown, where Svelte hands a `$state` read
   * its pre-change value, so `selectedContact !== currentContact` was never true there and leaving
   * inside the window delivered nothing: the next conversation's note joined the old window
   * (frontend/architecture, "A teardown sees the values its effect saw").
   */
  left: (selected: string | null) => ReadingOf | null;
}

/** Creates the tracker the receipt effect consults on every run. */
export function createReadingTracker(): ReadingTracker {
  let reading: ReadingOf | null = null;
  return {
    arm(next) {
      reading = next;
    },
    left(selected) {
      if (!reading || reading.contact === selected) return null;
      const ended = reading;
      reading = null;
      appendLog(`[READ] reading of ${ended.contact} ended: the selection moved on`);
      return ended;
    },
  };
}
