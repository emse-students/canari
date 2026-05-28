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
 * Whether recovery signals (welcome_request / reinvite_request) may be sent for `groupId`.
 * When `index` is null (server list unavailable), returns true to preserve prior behaviour.
 */
export function isGroupEligibleForMlsRecovery(
  groupId: string,
  index: UserGroupSyncIndex | null,
  log?: (msg: string) => void
): boolean {
  if (!index) return true;

  if (index.deletedGroupIds.has(groupId)) {
    log?.(`[MLS] Skip recovery: groupe supprimé ${groupId}`);
    return false;
  }

  const row = index.byGroupId.get(groupId);
  if (row?.deletedAt) {
    log?.(`[MLS] Skip recovery: groupe supprimé ${groupId}`);
    return false;
  }

  if (!row) {
    log?.(`[MLS] Skip recovery: groupe absent de la liste serveur ${groupId}`);
    return false;
  }

  return true;
}

/**
 * Follows successor links from a tombstone to an active group id (if any).
 * Returns null when the chain ends on a deleted group without a usable successor.
 */
export function resolveActiveGroupTarget(
  groupId: string,
  index: UserGroupSyncIndex,
  maxHops = 5
): string | null {
  let current = groupId;

  for (let hop = 0; hop < maxHops; hop++) {
    const row = index.byGroupId.get(current);
    if (!row) return null;

    if (!row.deletedAt) {
      return current;
    }

    if (!row.successorId) return null;
    current = row.successorId;
  }

  return null;
}
