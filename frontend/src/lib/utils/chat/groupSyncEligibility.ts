import type { UserGroupRow } from '$lib/mls-client/IMlsService';

/** Index built from `getUserGroups` for cheap deleted/active checks during MLS sync. */
export interface UserGroupSyncIndex {
  byGroupId: Map<string, UserGroupRow>;
  deletedGroupIds: Set<string>;
}

/** Builds a lookup index from the server-side user group list. */
export function buildUserGroupSyncIndex(groups: UserGroupRow[]): UserGroupSyncIndex {
  return {
    byGroupId: new Map(groups.map((g) => [g.groupId, g])),
    deletedGroupIds: new Set(groups.filter((g) => g.deletedAt).map((g) => g.groupId)),
  };
}

/**
 * Whether a `welcome_request` recovery signal may be sent for `groupId`.
 * When `index` is null (server list unavailable), returns true to preserve prior behaviour.
 */
export function isGroupEligibleForMlsRecovery(
  groupId: string,
  index: UserGroupSyncIndex | null,
  log?: (msg: string) => void
): boolean {
  if (!index) return true;

  if (index.deletedGroupIds.has(groupId)) {
    log?.(`[MLS] Skip recovery: deleted group ${groupId}`);
    return false;
  }

  const row = index.byGroupId.get(groupId);
  if (row?.deletedAt) {
    log?.(`[MLS] Skip recovery: deleted group ${groupId}`);
    return false;
  }

  if (!row) {
    log?.(`[MLS] Skip recovery: group absent from the server list ${groupId}`);
    return false;
  }

  return true;
}

/**
 * Finds the live DM group id for a peer. Returns null when no matching, non-deleted direct
 * group exists on the server.
 */
export function findActiveDirectGroupForPeer(
  groups: UserGroupRow[],
  userId: string,
  peerId: string
): string | null {
  const expectedNames = [
    `${userId.toLowerCase()}::${peerId.toLowerCase()}`,
    `${peerId.toLowerCase()}::${userId.toLowerCase()}`,
  ];

  for (const g of groups) {
    if (g.isGroup) continue;
    if (g.deletedAt) continue;
    if (!expectedNames.includes((g.name ?? '').toLowerCase())) continue;
    return g.groupId;
  }

  return null;
}
