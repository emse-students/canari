import { IsNull, Repository } from 'typeorm';
import { Group } from '../entities/group.entity';
import { GroupInvite } from '../entities/group-invite.entity';

/**
 * What a shared `/g/join/:token` link reveals before the invitee joins.
 *
 * `imageMediaId` is the group avatar, and it is here for the SAME reason the name is: the card an
 * invitee sees before joining is the only thing they have to recognise the group by. It is a raw
 * public blob (`/api/media/public/:id`, like a community image and an association logo), never a
 * ciphertext - which is what makes it something an unfurler with no session can actually fetch.
 */
export interface GroupInvitePreview {
  valid: boolean;
  groupId: string | null;
  groupName: string | null;
  imageMediaId: string | null;
}

/**
 * The single refusal shape, so a field added to the preview cannot be forgotten on one branch and
 * arrive as `undefined` - which reads as "absent" to a consumer that only checks `valid`.
 */
const REFUSED: GroupInvitePreview = {
  valid: false,
  groupId: null,
  groupName: null,
  imageMediaId: null,
};

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
  if (!invite || !groupInviteIsValid(invite)) return REFUSED;
  const group = await groupRepo.findOne({ where: { id: invite.groupId, deletedAt: IsNull() } });
  if (!group || !group.isGroup) return REFUSED;
  return {
    valid: true,
    groupId: group.id,
    groupName: group.name ?? null,
    imageMediaId: group.imageMediaId ?? null,
  };
}
