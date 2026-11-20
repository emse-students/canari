/**
 * What a conversation id looks like, with no dependency beyond the uuid shape - so a module low in
 * the graph (`visibleNotices.ts`) can tell a raw id from a name without importing `conversations.ts`
 * or `channelCrypto.ts`, both of which import it back. Re-exported by those two, the callers' homes.
 */
import { isUuidLike } from '$lib/utils/uuidShape';

/** The prefix of every salon conversation id (`channel_<uuid>`). */
export const CHANNEL_CONVERSATION_PREFIX = 'channel_';

/** True for community channel conversations (`channel_<uuid>`). */
export function isChannelConversationId(conversationId: string): boolean {
  return String(conversationId).startsWith(CHANNEL_CONVERSATION_PREFIX);
}

const HEX_ID_RE = /^[0-9a-f]{40,}$/i;

/**
 * True when `value` looks like a raw technical ID that must never be shown in the UI -
 * a UUID, an MLS group ID (64-char lowercase hex hash), or a `channel_<uuid>` conversation ID
 * that has not been replaced yet by the community's synced channel name.
 */
export function isRawId(value: string): boolean {
  const trimmed = value.trim();
  return isUuidLike(trimmed) || HEX_ID_RE.test(trimmed) || isChannelConversationId(trimmed);
}
