import { In, type Repository } from 'typeorm';
import type { ChannelRole } from './entities/channel-role.entity';
import type { ChannelMember } from './entities/channel-member.entity';
import { roleGrantsModeration } from './permissions';

/**
 * Whether a community member holds the moderation grant (`channel.moderate`, or a permission
 * subsuming it) through any of their roles - read from the role ROWS, at the moment of the request.
 *
 * The one server-side reading of the decision a client is handed as `viewerCanModerate`: every
 * moderation entry point asks it here (pin, delete, close a poll in `ChannelService`; a community
 * nickname in `CommunityNicknamesService`), so a menu offering the action and the endpoint refusing
 * it cannot disagree.
 */
export async function memberCanModerate(
  roles: Repository<ChannelRole>,
  member: Pick<ChannelMember, 'roleIds'>
): Promise<boolean> {
  if (!member.roleIds?.length) return false;
  const held = await roles.find({ where: { id: In(member.roleIds) } });
  return held.some((r) => roleGrantsModeration(r.permissions));
}
