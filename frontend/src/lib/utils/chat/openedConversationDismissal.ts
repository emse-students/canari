/**
 * THE LOCAL READER IS THE LAST TRIGGER OF A NOTIFICATION'S CANCEL, AND IT IS HANDED OVER ONCE PER
 * READING.
 *
 * On Android the WebView posts a message's or a reaction's notification while the app is open on
 * ANOTHER screen (the frame trigger, `reactionNotification.ts`). Its cancel had two triggers - a
 * push (a silent self frame) and an own read learned over the socket from ANOTHER device - and
 * neither fires when THIS device's reader opens the conversation: the activity never resumed
 * (`onResume` sweeps), and the server pushes a read to the account's other devices only. So the
 * banner, and above all the reaction's alert, stood for a conversation the reader was looking at.
 * A reaction cannot even be covered by the read mark (it carries no server instant), which is why
 * the native side removes it whenever its conversation is read and no newer message line is unread
 * (social-service, "THE REACTION'S ALERT GOES WITH THE CONVERSATION").
 *
 * The receipt effect runs again for every message, so this holds WHICH conversation, at WHICH mark,
 * it already told the native side about: one hand-over per reading AND per advance of its mark. The
 * mark matters because the first run can see a stale one (the server-time ceiling not learned yet,
 * rows not loaded): the native side then keeps the banner as UNREAD, and only a later hand-over with
 * the advanced mark can remove it - it is idempotent. A reading that ends (another conversation, the
 * app away, nobody at the window) re-arms it, so coming back dismisses what was raised meanwhile.
 * A hand-over the native side REFUSED is not spent (`unspend`): the next effect run retries it.
 */

/** Remembers which conversation the native side was last told is being read. */
export interface OpenedConversationDismissal {
  /**
   * Whether `conversationKey`'s reading still has to be handed over at mark `at`: true once per
   * reading and again whenever `at` rises above what was handed over; records it as handed over.
   */
  take: (conversationKey: string, at: number) => boolean;
  /** Forgets the last hand-over, which did not reach the native side: the next `take` is true. */
  unspend: () => void;
  /** Ends the current reading: the next `take` of any conversation is true again. */
  reset: () => void;
}

/** A fresh, empty memory. */
export function createOpenedConversationDismissal(): OpenedConversationDismissal {
  let handedOver: string | null = null;
  let handedAt = 0;
  return {
    take(conversationKey, at) {
      if (handedOver === conversationKey && at <= handedAt) return false;
      handedOver = conversationKey;
      handedAt = at;
      return true;
    },
    unspend() {
      handedOver = null;
    },
    reset() {
      handedOver = null;
    },
  };
}
