import { m } from '$lib/paraglide/messages';
import type { ChannelAccessState, ChannelWritePolicy } from '$lib/services/ChannelService';
import { canonicalRoleOf, resolveRoleLabel } from './communityRoleLabel';

/**
 * THE LINE A MEMBER WHO MAY NOT WRITE IN A SALON READS, from the salon's write policy - one sentence
 * for the read-only composer and for a refused post, so the two never word the same rule twice.
 *
 * It says WHO may write, never why this member may not: "only admins and moderators" is what the
 * person can act on (ask one of them), and a moderator whose role grants no moderation is exactly
 * the case where "you have no permission" explained nothing (production, 2026-11-10).
 *
 * @param policy The salon's policy, or undefined when the row has not learned it (an older server):
 *   then the generic read-only line, which is true and names nobody.
 */
export function writePolicyLine(policy: ChannelWritePolicy | undefined): string {
  if (policy === 'admins') return m.chat_channel_write_only_admins();
  if (policy === 'admins_moderators') return m.chat_channel_write_only_admins_mods();
  return m.chat_channel_read_only();
}

/** What the access panel draws under its write-policy select. */
export interface WriterRolesSummary {
  /** The qualifying roles' names, as the roles grid draws them. */
  names: string[];
  /**
   * True when "admins and moderators" admits nobody beyond the administrators: no role grants
   * moderation without also granting `workspace.manage`. The panel warns, because the policy then
   * reads as if moderators could write and none can.
   */
  onlyAdmins: boolean;
}

/**
 * The roles `policy` lets write, named, from the SERVER's lists (`writerRoles` of the access read) -
 * nothing here decides which role qualifies. Null under `everyone`, or when the server sent no list.
 */
export function summarizeWriterRoles(
  policy: ChannelWritePolicy,
  writerRoles: ChannelAccessState['writerRoles']
): WriterRolesSummary | null {
  if (policy === 'everyone' || !writerRoles) return null;
  const qualifying = writerRoles[policy];
  const adminIds = new Set(writerRoles.admins.map((r) => r.id));
  return {
    names: qualifying.map((r) => resolveRoleLabel(canonicalRoleOf(r.name), r.displayLabel)),
    onlyAdmins: policy === 'admins_moderators' && qualifying.every((r) => adminIds.has(r.id)),
  };
}
