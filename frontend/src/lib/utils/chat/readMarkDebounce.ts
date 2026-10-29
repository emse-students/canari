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

/** The pending mark of one reading, and the ways it ends. */
export interface ReadMarkDebounce {
  /**
   * Raises the pending mark to at least `at`. The first note of a window arms it with `deliver` and
   * the `conversation` being read, which later notes in the same window do not replace: the window
   * belongs to the reading that opened it.
   */
  note: (at: number, deliver: DeliverReadMark, conversation: string) => void;
  /**
   * Delivers the pending mark NOW when the window belongs to a conversation other than `selected`.
   * The receipt effect calls it FIRST on every run, with the CURRENT selection. It used to ask
   * from its teardown, where Svelte hands a `$state` read its pre-change value, so the leave was
   * never seen: the next conversation's note joined the old window and nothing was delivered on
   * leave (frontend/architecture, "A teardown sees the values its effect saw"). A salon's delivery
   * is what sends the banner signal to the account's other devices, so it is delivered, not dropped.
   */
  follow: (selected: string | null) => void;
  /** Delivers the pending mark NOW - the app left the screen, or the page clears the selection. */
  flush: () => void;
  /** The pending mark, 0 when none. */
  readonly pending: number;
}

/** Creates the holder, with `windowMs` between the first note of a window and its delivery. */
export function createReadMarkDebounce(windowMs: number): ReadMarkDebounce {
  let pendingAt = 0;
  let deliverPending: DeliverReadMark | null = null;
  let owner: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function take(): { at: number; deliver: DeliverReadMark | null } {
    const taken = { at: pendingAt, deliver: deliverPending };
    if (timer) clearTimeout(timer);
    timer = null;
    pendingAt = 0;
    deliverPending = null;
    owner = null;
    return taken;
  }

  function fire(early: boolean): void {
    const { at, deliver } = take();
    if (at <= 0 || !deliver) return;
    if (early) appendLog(`[READ] mark ${at} delivered before its window ended: the reading ended`);
    deliver(at);
  }

  return {
    note(at, deliver, conversation) {
      pendingAt = Math.max(pendingAt, at);
      if (timer) return;
      deliverPending = deliver;
      owner = conversation;
      timer = setTimeout(() => fire(false), windowMs);
    },
    follow(selected) {
      if (owner === null || owner === selected) return;
      fire(true);
    },
    flush() {
      fire(true);
    },
    get pending() {
      return pendingAt;
    },
  };
}
