/**
 * The read mark of the conversation being read, handed on at the LEADING EDGE of a throttle window
 * (owner, 2026-11-07: "2 secondes, l'autre a le temps de voir et fermer la conversation ? Pourquoi
 * attendre ?"). The first mark a reading decides is delivered AT ONCE (the MLS outbox for a DM or a
 * group, the owed-mark queue for a salon); marks decided inside the window that follows (a scroll
 * through a burst, messages arriving while the conversation is open) coalesce into ONE trailing
 * delivery carrying the highest one.
 *
 * WHY IT IS A MODULE. It used to be two variables and a timer inside `MainChatPage`'s receipt
 * effect, whose cleanup ZEROED the pending value when the reader left the conversation inside the
 * window. The local mark had already moved by then, so the next visit found nothing to announce:
 * a DM peer kept seeing the conversation unread for good. Leaving, and the app leaving the screen,
 * now DELIVER the trailing mark instead (`flush`), and a component cannot be unit-tested where a
 * module can.
 *
 * THE WINDOW IS THE ONE CLOCK OF THE MECHANISM AND IT DECIDES ONLY HOW OFTEN, NEVER WHETHER. Every
 * mark noted is delivered at once, by the trailing delivery or by `flush`, or covered by a higher
 * one noted in the same window; a mark is never lowered (`max`). Privacy is unchanged and lives in
 * the caller: it notes only a mark the reading already decided. See history-reconciliation, "The
 * sender says only what is new".
 */
import { appendLog } from '$lib/utils/sessionLog';

/** Hands a mark on. */
export type DeliverReadMark = (at: number) => void;

/** The pending (trailing) mark of one reading, and the ways it ends. */
export interface ReadMarkDebounce {
  /**
   * Notes a mark of at least `at`. With no window open it is delivered NOW through `deliver` and
   * opens a window owned by `conversation`; inside a window it raises the pending trailing mark,
   * which the window's expiry delivers through the callback that opened it (the window belongs to
   * the reading that opened it).
   */
  note: (at: number, deliver: DeliverReadMark, conversation: string) => void;
  /**
   * Ends the window when it belongs to a conversation other than `selected`, delivering its trailing
   * mark NOW if one is pending. The receipt effect calls it FIRST on every run, with the CURRENT
   * selection. It used to ask from its teardown, where Svelte hands a `$state` read its pre-change
   * value, so the leave was never seen (frontend/architecture, "A teardown sees the values its
   * effect saw"). A salon's delivery is what sends the banner signal to the account's other devices,
   * so it is delivered, not dropped.
   */
  follow: (selected: string | null) => void;
  /** Delivers the trailing mark NOW and ends the window - the app left the screen, or the page clears the selection. */
  flush: () => void;
  /** The trailing mark not yet delivered, 0 when none. */
  readonly pending: number;
}

/** Creates the holder, with `windowMs` between a delivery and the next one it may make. */
export function createReadMarkDebounce(windowMs: number): ReadMarkDebounce {
  let pendingAt = 0;
  let deliverFn: DeliverReadMark | null = null;
  let owner: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  /** Ends the window and returns what it still owed. */
  function take(): { at: number; deliver: DeliverReadMark | null } {
    const taken = { at: pendingAt, deliver: deliverFn };
    if (timer) clearTimeout(timer);
    timer = null;
    pendingAt = 0;
    deliverFn = null;
    owner = null;
    return taken;
  }

  /** Opens a window whose expiry delivers the trailing mark, if any, and restarts while it did. */
  function arm(): void {
    timer = setTimeout(() => {
      timer = null;
      const at = pendingAt;
      const deliver = deliverFn;
      if (at <= 0 || !deliver) {
        take();
        return;
      }
      pendingAt = 0;
      appendLog(`[READ] trailing mark ${at} delivered at the end of its window`);
      deliver(at);
      // A delivery opens the next window: the rate stays one per window however long the burst.
      arm();
    }, windowMs);
  }

  function end(early: boolean): void {
    const { at, deliver } = take();
    if (at <= 0 || !deliver) return;
    if (early) appendLog(`[READ] mark ${at} delivered before its window ended: the reading ended`);
    deliver(at);
  }

  return {
    note(at, deliver, conversation) {
      if (timer) {
        pendingAt = Math.max(pendingAt, at);
        return;
      }
      deliverFn = deliver;
      owner = conversation;
      appendLog(`[READ] mark ${at} delivered at once: the leading edge of its window`);
      arm();
      deliver(at);
    },
    follow(selected) {
      if (owner === null || owner === selected) return;
      end(true);
    },
    flush() {
      end(true);
    },
    get pending() {
      return pendingAt;
    },
  };
}
