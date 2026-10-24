/**
 * Sends made during a notification landing's LOCAL PREVIEW (F1), held until the session is up.
 *
 * WHY HELD, AND WHY IN MEMORY. The send path keeps its rule: the optimistic echo and the outbox
 * entry are written in ONE transaction (`saveMessageWithOutboxEntry`), encrypted before it opens,
 * and only then is anything flushed. That write needs the session's store and the outbox
 * controller, which `loginImpl` registers in the same synchronous run that sets `isLoggedIn` - so a
 * send pressed before that instant cannot be made durable yet, and handing it to the outbox early
 * would be a send with no queue. It is held here, in order, and replayed through the ordinary path
 * when the session comes up (an event, not a timer).
 *
 * EACH SEND REMEMBERS ITS CONVERSATION. The ordinary path sends to whatever is selected when it
 * runs, so a send replayed after the selection moved would go to the WRONG conversation. `release`
 * runs only the sends whose target is still selected and hands the others back, unsent, for the
 * caller to report.
 */

/** One send waiting for the session. */
export interface HeldSend {
  /** What it is, for the log - never its content. */
  what: string;
  /** The conversation selected when it was pressed. */
  target: string | null;
  /** The ordinary send, run when the session is up and `target` is still selected. */
  run: () => void;
  /**
   * Called instead of `run` when the send is NOT run - dropped, or misdirected - for a send that
   * owns something to release (a share's copies on disk, which nothing else would delete).
   */
  discard?: () => void;
}

/** What {@link HeldSendQueue.release} did. */
export interface HeldSendRelease {
  sent: HeldSend[];
  /** Held for a conversation that is no longer selected: NOT sent. */
  misdirected: HeldSend[];
}

/** The queue behind the chat page's held sends; pure, so its rules are tested without a page. */
export interface HeldSendQueue {
  readonly size: number;
  hold(send: HeldSend): void;
  /** Runs, in order, every send whose target is `selected`; empties the queue. */
  release(selected: string | null): HeldSendRelease;
  /** Empties the queue without running anything, and returns what it held. */
  drop(): HeldSend[];
}

/** Creates an empty {@link HeldSendQueue}. */
export function createHeldSendQueue(): HeldSendQueue {
  let queue: HeldSend[] = [];
  return {
    get size() {
      return queue.length;
    },
    hold(send) {
      queue.push(send);
    },
    release(selected) {
      const taken = queue;
      queue = [];
      const sent: HeldSend[] = [];
      const misdirected: HeldSend[] = [];
      for (const h of taken) (h.target === selected ? sent : misdirected).push(h);
      for (const h of sent) h.run();
      for (const h of misdirected) h.discard?.();
      return { sent, misdirected };
    },
    drop() {
      const taken = queue;
      queue = [];
      for (const h of taken) h.discard?.();
      return taken;
    },
  };
}
