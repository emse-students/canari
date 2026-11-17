import { m } from '$lib/paraglide/messages';
import { showConfirm } from '$lib/stores/confirm.svelte';
import { Log } from '$lib/utils/Log';
import { getUserDisplayNameSync, resolveUserDisplayName } from './displayName';

/**
 * Asks before removing ONE member, and the question NAMES THEM.
 *
 * A removal is bound to the member's id, captured by the row that was tapped - never to a position
 * in a list. But a person confirms what they READ, and every removal dialog used to say only "this
 * member": on the `1.7.0-alpha.9` bench a tap on a row that had just moved under the pointer was
 * confirmed four times out of four against the wrong person, because nothing on the dialog said
 * whose removal it was. The name shown here is the one the row itself draws (the conversation's
 * nickname when `scope` is given, the profile name otherwise), resolved before the dialog opens.
 *
 * Every remove-a-member path calls this one function (a group, a community, a salon's access, an
 * association), so the dialog's danger styling and its button are one decision too.
 *
 * @param userId the member the tapped row was drawn for
 * @param message the localized question, given the member's name as `member`
 * @param scope the conversation whose nickname the row draws (a group), or none
 * @returns whether the person confirmed the removal of THAT member
 */
export async function confirmMemberRemoval(
  userId: string,
  message: (inputs: { member: string }) => string,
  scope?: string
): Promise<boolean> {
  const resolved = await resolveUserDisplayName(userId);
  if (resolved === null) {
    // The id is what the dialog says then: a removal must never be confirmed against no name.
    console.warn(
      `[REMOVE_MEMBER] no display name for ${userId.slice(0, 8)} - the confirmation names its id`
    );
  }
  const member = getUserDisplayNameSync(userId, resolved ?? userId, scope);
  Log.d('memberRemovalConfirm.confirmMemberRemoval asking', { userId, scoped: !!scope });
  const confirmed = await showConfirm(message({ member }), {
    danger: true,
    confirmLabel: m.common_remove_label(),
  });
  Log.d('memberRemovalConfirm.confirmMemberRemoval answered', { userId, confirmed });
  return confirmed;
}
