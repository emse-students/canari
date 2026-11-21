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
 * The receipt effect runs again for every message, so this holds WHICH conversation it already told
 * the native side about: one hand-over per reading, and a reading that ends (another conversation,
 * the app away, nobody at the window) re-arms it, so coming back dismisses what was raised meanwhile.
 */

/** Remembers which conversation the native side was last told is being read. */
export interface OpenedConversationDismissal {
  /**
   * Whether `conversationKey`'s reading still has to be handed over: true exactly once per reading,
   * and records it as handed over.
   */
  take: (conversationKey: string) => boolean;
  /** Ends the current reading: the next `take` of any conversation is true again. */
  reset: () => void;
}

/** A fresh, empty memory. */
export function createOpenedConversationDismissal(): OpenedConversationDismissal {
  let handedOver: string | null = null;
  return {
    take(conversationKey) {
      if (handedOver === conversationKey) return false;
      handedOver = conversationKey;
      return true;
    },
    reset() {
      handedOver = null;
    },
  };
}
