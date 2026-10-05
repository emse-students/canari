/**
 * THE NOTIFICATION CATEGORIES A USER MAY SWITCH OFF - the client's mirror of the server's closed set.
 *
 * The server (`apps/chat-delivery-service/src/services/push-category.ts`) is the authority: it
 * decides before it sends, so a muted category costs no push at all. This list exists so the
 * settings screen can draw the switches and so this client's OWN local notifications (raised from a
 * WebSocket frame, where no push is involved) obey the same set. `categories.contract.test.ts` reads
 * the server file and fails when the two lists drift, because no compiler spans a service boundary.
 */
export const NOTIFICATION_CATEGORIES = [
  'messages',
  'channels',
  'posts',
  'comments',
  'mentions',
  'reactions',
  'events',
  'forms',
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/** True when `value` is one of the closed set. */
export function isNotificationCategory(value: unknown): value is NotificationCategory {
  return (
    typeof value === 'string' && (NOTIFICATION_CATEGORIES as readonly string[]).includes(value)
  );
}

/**
 * Which switch governs a message notification raised locally for `conversationKey`: a community
 * salon (`channel_<uuid>`) is `channels`, every MLS conversation is `messages`. The same split the
 * server makes between a `type: 'channel'` push and a `type: 'message'` one.
 */
export function categoryOfConversation(conversationKey: string): NotificationCategory {
  return conversationKey.startsWith('channel_') ? 'channels' : 'messages';
}
