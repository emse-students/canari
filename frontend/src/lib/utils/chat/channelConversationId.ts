/**
 * The shape of a salon conversation id (`channel_<uuid>`), in a module of its own: the predicate is
 * read by light modules (the notification categories) that must not pull in the salon crypto
 * `channelCrypto.ts` carries. `channelCrypto.ts` re-exports both, so its importers are unchanged.
 */

/** The prefix of every salon conversation id (`channel_<uuid>`). */
export const CHANNEL_CONVERSATION_PREFIX = 'channel_';

/** True for community channel conversations (`channel_<uuid>`). */
export function isChannelConversationId(conversationId: string): boolean {
  return String(conversationId).startsWith(CHANNEL_CONVERSATION_PREFIX);
}
