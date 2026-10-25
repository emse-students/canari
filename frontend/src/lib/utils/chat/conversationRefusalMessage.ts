import { m } from '$lib/paraglide/messages';
import type { ConversationRefusal } from '$lib/utils/chat/groupCreation';
import { FollowerTabCommitError } from '$lib/mls-client/commitSubmission';
import { showToast } from '$lib/stores/toast.svelte';
import { MemberRemovalNotCommittedError } from './memberRemovalError';

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
  'follower-tab': () => m.chat_error_follower_tab(),
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

/**
 * Tells the member, when a group action failed because this tab may not commit
 * (`FollowerTabCommitError`), that it must be done in the main tab. Read from the error's TYPE,
 * never its text. Every other failure is left to the caller's own handling.
 *
 * @param e - what the group action threw.
 * @returns whether the failure was that refusal and was shown.
 */
export function reportFollowerTabRefusal(e: unknown): boolean {
  // A removal the server recorded and then could not commit carries the refusal as its cause: the
  // member still learns WHY, by type (`MemberRemovalNotCommittedError`).
  const refusal = e instanceof MemberRemovalNotCommittedError ? e.cause : e;
  if (!(refusal instanceof FollowerTabCommitError)) return false;
  console.warn(
    `[GROUP] a group action was refused in a follower tab (${refusal.groupId.slice(0, 8)}...)`
  );
  showToast(conversationRefusalMessage('follower-tab'));
  return true;
}

/**
 * Tells the member what a removal they asked for came to when it did not complete - read from the
 * error's TYPE, never its text. Two outcomes the member must not confuse:
 *
 * - {@link MemberRemovalNotCommittedError}: the person IS removed (the server recorded it, no message
 *   reaches them) and only the key change is late - it completes at the next connection, by the
 *   collector that compares the roster with the tree;
 * - anything else: nothing was recorded, the person is still a member, and the gesture can be
 *   retried.
 *
 * A follower-tab refusal is not handled here: {@link reportFollowerTabRefusal} has its own sentence.
 *
 * @param e - what `removeMemberAndBroadcast` threw.
 * @returns `recorded` when the removal stands and only its commit is owed, `not-removed` otherwise.
 */
export function reportMemberRemovalFailure(e: unknown): 'recorded' | 'not-removed' {
  if (e instanceof MemberRemovalNotCommittedError) {
    showToast(m.chat_group_remove_member_keys_pending(), 'warning');
    return 'recorded';
  }
  showToast(m.chat_group_remove_member_failed());
  return 'not-removed';
}
