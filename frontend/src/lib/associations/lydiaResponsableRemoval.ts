import { m } from '$lib/paraglide/messages';
import { showConfirm } from '$lib/stores/confirm.svelte';
import { LEAVE_REFUSAL, SocialApiError, removeMember } from './api';

/**
 * REMOVES A MEMBER FROM THE ROSTER EDITOR, and the one case where the server's refusal is not the
 * end: the member is the association's Lydia Responsable (`RESPONSABLE_MUST_HAND_OVER`) and the
 * reader is a PLATFORM ADMIN (owner, 2026-11-20). The admin then TYPES the association's name under
 * a sentence saying the number keeps every Lydia right until it is removed, and the removal is sent
 * again with that acknowledgement. Anyone else's refusal - and the admin's own, declined - is
 * thrown or answered as it was: members and managers hand the role over first.
 *
 * Answers `removed`, or `declined` when the admin did not confirm. Every other error is thrown.
 */
export async function removeRosterMember(
  asso: { id: string; name: string },
  targetId: string,
  globalAdmin: boolean
): Promise<'removed' | 'declined'> {
  try {
    await removeMember(asso.id, targetId);
    return 'removed';
  } catch (err) {
    const responsable =
      err instanceof SocialApiError && err.code === LEAVE_REFUSAL.RESPONSABLE_MUST_HAND_OVER;
    if (!responsable || !globalAdmin) throw err;
  }
  console.debug('[ASSO] the member removed is the Lydia Responsable: the admin confirms by typing');
  const confirmed = await showConfirm(m.asso_member_lydia_responsable_admin_confirm(), {
    confirmLabel: m.asso_member_lydia_responsable_admin_confirm_button(),
    danger: true,
    requireText: asso.name,
  });
  if (!confirmed) return 'declined';
  await removeMember(asso.id, targetId, { lydiaResponsableAcknowledged: true });
  return 'removed';
}
