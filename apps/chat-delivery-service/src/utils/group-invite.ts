import { IsNull, Repository } from 'typeorm';
import { Group } from '../entities/group.entity';
import { GroupInvite } from '../entities/group-invite.entity';

/** What a shared `/g/join/:token` link reveals before the invitee joins. */
export interface GroupInvitePreview {
  valid: boolean;
  groupId: string | null;
  groupName: string | null;
}

/** True while an invite is still usable: not revoked, not expired, uses left. */
export function groupInviteIsValid(invite: GroupInvite): boolean {
  if (invite.revoked) return false;
  if (invite.expiresAt && new Date(invite.expiresAt).getTime() < Date.now()) return false;
  if (invite.maxUses != null && invite.uses >= invite.maxUses) return false;
  return true;
}

/**
 * Resolves the preview of a group invite. Viewer-independent by construction - it answers on the
 * invite and the group alone - which is what lets the session-free head renderer reuse it: one
 * implementation serving both the in-app card (behind `HeaderAuthGuard`) and the Open Graph tags
 * of a shared link, so the two can never drift apart on what an invite discloses.
 */
export async function resolveGroupInvitePreview(
  inviteRepo: Repository<GroupInvite>,
  groupRepo: Repository<Group>,
  token: string
): Promise<GroupInvitePreview> {
  const invite = await inviteRepo.findOne({ where: { token } });
  if (!invite || !groupInviteIsValid(invite)) {
    return { valid: false, groupId: null, groupName: null };
  }
  const group = await groupRepo.findOne({ where: { id: invite.groupId, deletedAt: IsNull() } });
  if (!group || !group.isGroup) return { valid: false, groupId: null, groupName: null };
  return { valid: true, groupId: group.id, groupName: group.name ?? null };
}
