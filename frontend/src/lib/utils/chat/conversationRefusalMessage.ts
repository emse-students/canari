import { m } from '$lib/paraglide/messages';
import type { ConversationRefusal } from '$lib/utils/chat/groupCreation';

/**
 * THE ONE PLACE A REFUSAL BECOMES A SENTENCE, AND THE REASON IT IS A TABLE.
 *
 * `Record<ConversationRefusal, ...>` is total by construction: adding a member to the refusal type
 * fails to compile until this file has a sentence for it. That is the whole point of the file -
 * a `switch` with a default, or a lookup with a fallback, would let a new refusal ship silently as
 * whatever the fallback says, which is the shape of the defect this replaced (every refusal
 * rendered as nothing at all).
 *
 * The values are thunks because Paraglide's compiled messages read the ambient locale when CALLED.
 * Evaluating them into a plain string at module scope would freeze whichever locale happened to be
 * active at import time.
 */
const SENTENCES: Record<ConversationRefusal, () => string> = {
  'duplicate-group-name': () => m.chat_modal_error_duplicate_group(),
  blocked: () => m.chat_modal_error_blocked(),
  'block-check-unavailable': () => m.chat_modal_error_block_check_unavailable(),
  'peer-has-no-device': () => m.chat_modal_error_peer_has_no_device(),
  'creation-failed': () => m.chat_modal_error_creation_failed(),
};

/**
 * The localized line a creation modal shows when a conversation was refused.
 *
 * @param reason - the discriminator the creation path returned, never its log text.
 * @returns a sentence in the active locale.
 */
export function conversationRefusalMessage(reason: ConversationRefusal): string {
  return SENTENCES[reason]();
}
