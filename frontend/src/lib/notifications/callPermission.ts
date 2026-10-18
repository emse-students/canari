/**
 * Whether a private conversation may RING this account - its own setting, beside the notification
 * level (user, 2026-10-18: calls get their own per-conversation permission).
 *
 * The server owns it (`dm_group_members.callsAllowed`, chat-delivery) and applies it to the ring
 * push (`CallsService.ringGroup`). This client applies the SAME rule to the in-app invite that
 * arrives over the socket, which the server cannot read. Mirrors `callsAllowedFor` on the server;
 * the default and why it is the least surprising one are in docs/wiki/frontend/modules/calls.md.
 */
import type { ConversationNotificationLevel } from './conversationLevel';

/**
 * Whether a call may ring here. An explicit choice wins whatever the level; a conversation where
 * the account never chose (`undefined` - every one an older client ever touched) rings unless its
 * level is `none`.
 */
export function callsAllowedFor(
  level: ConversationNotificationLevel,
  explicit: boolean | undefined
): boolean {
  if (typeof explicit === 'boolean') return explicit;
  return level !== 'none';
}
