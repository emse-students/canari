/**
 * A private conversation's notification level - the salon's three levels (`ChannelNotificationLevel`)
 * applied to an MLS group or DM - and the ONE decision this client takes with it.
 *
 * The server owns the level (`dm_group_members.notifLevel`, chat-delivery) and applies `none` to
 * every push itself. `mentions` it cannot apply: it never sees who a ciphertext mentions. So a
 * device decides, after decrypting, in exactly one place per platform - here for every notification
 * this client raises from a socket frame, `NotificationLevelGate` on Android for a push, and
 * `levelDecision` in the iOS extension. The rule they share is in docs/wiki/services/chat-delivery.md.
 */
import type { ChannelNotificationLevel } from '$lib/services/ChannelService';
import {
  extractMentionUserIds,
  mentionsEveryone,
  normalizeMentionUserId,
} from '$lib/utils/mentions';

/** The same three levels as a salon, so one type and one control serve both. */
export type ConversationNotificationLevel = ChannelNotificationLevel;

/** Whether `value` is a level the server can answer. */
export function isConversationNotificationLevel(
  value: unknown
): value is ConversationNotificationLevel {
  return value === 'all' || value === 'mentions' || value === 'none';
}

/**
 * Whether a `@tous` in a message may count as a mention of its reader.
 *
 * `honoured` in a private conversation, where every member may call everyone (owner, 2026-11-25),
 * and in a salon message the SERVER vouched for (`mentionsEveryone` on its row: the sender holds the
 * moderation grant there). `ignored` for any other salon message - a member's `@tous` stays text.
 */
export type EveryoneMention = 'honoured' | 'ignored';

/**
 * The {@link EveryoneMention} of one message: a private conversation honours every `@tous`, a salon
 * only one its row says the server vouched for.
 *
 * @param isSalon - the message belongs to a community salon (`channel_<id>`).
 * @param vouched - the salon row's `mentionsEveryone`, set by the server after its role check.
 */
export function everyoneMentionOf(isSalon: boolean, vouched: boolean): EveryoneMention {
  return !isSalon || vouched ? 'honoured' : 'ignored';
}

/**
 * Whether a message's raw text names `userId`: the inline `@[<id>]` token, case-insensitive, or a
 * `@tous` / `@everyone` the conversation honours - the same reading as the native paths
 * (`NotificationLevelGate`, `levelDecision`), pinned for all three by
 * `libs/contracts/mention-decision.cases.json`.
 */
export function mentionsUser(content: string, userId: string, everyone: EveryoneMention): boolean {
  if (everyone === 'honoured' && mentionsEveryone(content)) return true;
  return extractMentionUserIds(content).includes(normalizeMentionUserId(userId));
}

/**
 * Why a message is NOT raised under its conversation's level, or null when it may be.
 *
 * Here the plaintext is always in hand - this client decrypted the frame before asking - so the
 * undecidable case of the native paths (a push nobody could read) does not arise.
 *
 * @param level - the conversation's level for this account.
 * @param mentionsMe - whether the decrypted message names this account.
 */
export function conversationLevelRefusal(
  level: ConversationNotificationLevel,
  mentionsMe: boolean
): string | null {
  if (level === 'none') return 'the conversation is set to none';
  if (level === 'mentions' && !mentionsMe) {
    return 'the conversation is set to mentions and this message does not mention this account';
  }
  return null;
}
