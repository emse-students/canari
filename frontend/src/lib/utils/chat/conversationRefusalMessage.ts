import { m } from '$lib/paraglide/messages';
import type {
  BulkAdditionRefusal,
  ConversationRefusal,
  LostInvitationOutcome,
} from '$lib/utils/chat/groupCreation';
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

/** Every way an invitation can add nobody, as a sentence - total for the reason the file gives. */
const INVITE_SENTENCES: Record<BulkAdditionRefusal, () => string> = {
  'nobody-named': () => m.chat_invite_error_nobody_named(),
  'nobody-reachable': () => m.chat_invite_error_nobody_reachable(),
  'no-devices': () => m.chat_invite_error_no_devices(),
  'add-lock-busy': () => m.chat_invite_error_add_lock_busy(),
  'no-device-added': () => m.chat_invite_error_no_device_added(),
  'commit-race-lost': () => m.chat_invite_error_commit_race_lost(),
  'removed-meanwhile': () => m.chat_invite_error_removed_meanwhile(),
  'tree-unconfirmed': () => m.chat_invite_error_tree_unconfirmed(),
  'outcome-unknown': () => m.chat_invite_pending_connection(),
  'previous-commit-unresolved': () => m.chat_invite_error_previous_commit_unresolved(),
  failed: () => m.chat_invite_error_failed(),
};

/**
 * Tells the member that an invitation they made added nobody, and why - read from the outcome's
 * `reason`, never a log. AN INVITATION IS A GESTURE WITH NO DURABLE ROW: a new person enters only by
 * a member's own Add (2026-10-23), so a refused one - a lost race, a busy add lock - is not retried by
 * any sweep, and the member is the one who retries. Saying nothing is how CC-4 lost an Add for good.
 *
 * `outcome-unknown` is the one reason that is not a refusal: the commit is kept and finishes by
 * itself (`owedInvitations.ts`), so it is said as a warning, and {@link reportLostInvitation} speaks
 * if it does not finish.
 *
 * @param reason - the refusal `inviteMembersToGroup` returned.
 */
export function reportBulkAdditionRefusal(reason: BulkAdditionRefusal): void {
  console.warn(`[GROUP] an invitation added nobody (${reason})`);
  if (reason === 'outcome-unknown') showToast(INVITE_SENTENCES[reason](), 'warning');
  else showToast(INVITE_SENTENCES[reason]());
}

/**
 * Tells the member how an invitation they made BEFORE A LOST CONNECTION ended, once its kept commit
 * was found not to have landed and it was re-planned (`replanLostInvitation`). Named after the
 * conversation, since the member is no longer looking at it. Silent when it completed - the member
 * list shows it - and when its commit is kept again, which ends here later.
 *
 * @param outcome - what the re-plan came to.
 * @param conversationName - the conversation's display name.
 */
export function reportLostInvitation(
  outcome: LostInvitationOutcome,
  conversationName: string
): void {
  if (outcome.kind !== 'not-completed') return;
  console.warn(
    `[INVITE_OWED] the member is told: an invitation lost a connection ago was not completed (${outcome.reason})`
  );
  showToast(
    outcome.reason === 'removed-meanwhile'
      ? m.chat_invite_resumed_removed_meanwhile({ conversation: conversationName })
      : m.chat_invite_resumed_failed({ conversation: conversationName })
  );
}
