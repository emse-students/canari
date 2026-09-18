/**
 * The one message-notification builder on Android, asked for from the WebView.
 *
 * **WHY THIS EXISTS.** Android had TWO builders for the same event, and they shared nothing but
 * the channel they filed on:
 *
 * | | the plain one | the rich one |
 * | --- | --- | --- |
 * | built by | this WebView, `tauri-plugin-notification` | `CanariFirebaseMessagingService` |
 * | triggered by | a WebSocket frame | an FCM data push |
 * | shows | a line of text | the sender's face, the thread, reply and mark-as-read |
 * | suppressed when | the reader can SEE the message land (`canSeeArrival`) | the app is in the foreground |
 * | a tap | opens the app onto nothing | opens the conversation |
 *
 * The two suppression predicates are DISJOINT - a backgrounded app satisfies neither - and the two
 * id namespaces cannot collide, so a message that arrived over the socket AND was pushed (the
 * server pushes a frame the client has not ACKed after 10 s) produced TWO notifications side by
 * side for one message. The user reported it on 2026-09-18 with a capture of the pair, and settled
 * the design in the same breath: *"pourquoi a-t-on encore des plain-notifications alors que les
 * rich notifications sont super"*.
 *
 * So the WebSocket frame stopped being a second BUILDER and became a second TRIGGER for the same
 * one. Both paths post under `getStableNotifId(groupId)`, which is what makes the second arrival an
 * UPDATE of the first rather than a second notification - Android replaces by id, whoever posted.
 *
 * **THE PLAIN PATH IS NOT DELETED, IT IS NOW WEB-ONLY** (and desktop, a different implementation
 * this session has not measured). It is the only builder those engines have.
 */

import { isAndroidTauriRuntime } from '$lib/utils/appVersion';

/**
 * What the native builder needs in order to render the same notification for both triggers.
 *
 * Deliberately the shape of the PUSH PAYLOAD rather than of a banner: `groupName` is EMPTY for a
 * direct message, exactly as `push-payload.ts` defines it, so neither trigger has to be told which
 * of the two it is.
 */
export type NativeMessageNotification = {
  /** The conversation - the notification id, and the deep link a tap follows, both come from it. */
  conversationId: string;
  /** Whose avatar to draw. Empty falls back to the initials disc. */
  senderId: string;
  /** The name on the message line inside the conversation. */
  senderName: string;
  /** The conversation title, EMPTY for a direct message. */
  groupName: string;
  /** The preview text, already rendered (mentions resolved, media described). */
  body: string;
  /** Whether this message names the reader - it picks the channel, hence the reader's own switches. */
  mentionsMe: boolean;
  /**
   * The SENDER's instant in ms, 0 when unknown.
   *
   * Load-bearing, and not for display: it is what lets the native builder recognise that the push
   * and the WebSocket frame are the SAME message and refresh the shade without adding a second
   * line or alerting twice. Without it the notification is still single (the id is shared) but its
   * thread can show one message twice.
   */
  sentAt: number;
};

/**
 * Asks the native builder to post (or update) this conversation's notification.
 *
 * @returns whether the native side ACCEPTED the work. It cannot promise more: building the
 *   notification fetches the sender's avatar over HTTP, so Kotlin queues it on its own lane and
 *   answers at once. `false` means the request reached no builder at all, which on Android leaves
 *   the reader with nothing - so the caller says so rather than quietly raising something else.
 *   Always `false` off Android, where there is no native builder to ask.
 */
export async function postNativeMessageNotification(
  notification: NativeMessageNotification
): Promise<boolean> {
  if (!isAndroidTauriRuntime()) return false;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<boolean>('notifier_message_natif', {
      groupId: notification.conversationId,
      senderId: notification.senderId,
      senderName: notification.senderName,
      groupName: notification.groupName,
      body: notification.body,
      mentionsMe: notification.mentionsMe,
      sentAt: notification.sentAt,
    });
  } catch (e) {
    // NOT a fallback to the plain builder: reaching here means the one path failed, and the fix
    // belongs there. Logged at a level that accuses, because the reader got nothing.
    console.error(
      `[NOTIF] The native builder threw for ${notification.conversationId}: ${String(e)}`
    );
    return false;
  }
}

/**
 * The conversation title a notification should carry, from the row the client already holds.
 *
 * EMPTY for a direct message, which is the server's own contract for `groupName` in a push - see
 * `push-payload.ts`. A CHANNEL is titled like a group here, where the push titles it in the banner
 * instead: its payload names no human sender, and this path does. The two converge on one
 * notification whichever arrives second, so the difference is a wording, not a duplicate.
 */
export function notificationGroupName(
  conversationType: 'direct' | 'group' | 'channel' | undefined,
  contactName: string,
  name: string
): string {
  if (conversationType === 'direct') return '';
  return contactName || name;
}
