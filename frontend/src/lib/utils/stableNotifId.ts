/**
 * The plugin notification id of a key: a stable positive 32-bit integer (Java's string hash, folded
 * positive), so a second post under the same key REPLACES the first - per conversation for a
 * message, per reaction for a reaction.
 *
 * ON iOS THE PLUGIN'S REQUEST IDENTIFIER IS THIS NUMBER IN DECIMAL (`"\(notification.id)"`,
 * tauri-plugin-notification `NotificationPlugin.swift`), and for a reaction the server sends the
 * very same decimal as the push's `apns-collapse-id` (`reactionCollapseId` in chat-delivery-service
 * `push-payload.ts`, a copy pinned to this one by a shared vector in both test suites) - so the page's
 * notification and the push of ONE reaction are one request the system replaces, never two.
 */
export function stableNotifId(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (Math.imul(31, hash) + key.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) || 1;
}
