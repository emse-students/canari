import type { IMlsService, UserGroupRow } from '$lib/mls-client/IMlsService';

/**
 * Follows the successor chain from `startId` to the terminal group
 * (the one without a `successorId`), making at most `maxHops + 1` API calls.
 *
 * Returns `hasChain = false` when `startId` is already the terminal.
 * The `deletedAt` field on the returned meta lets callers reject deleted lineages.
 */
export async function resolveTerminalGroup(
  mlsService: IMlsService,
  startId: string,
  maxHops = 10
): Promise<{
  terminalId: string;
  groupMeta: { name?: string; isGroup?: boolean; deletedAt?: string | null } | null;
  hasChain: boolean;
}> {
  const visited = new Set<string>();
  let current = startId;
  let meta: { name?: string; isGroup?: boolean; deletedAt?: string | null } | null = null;

  for (let hop = 0; hop <= maxHops; hop++) {
    if (visited.has(current)) break; // cycle - s'arrêter au dernier connu
    visited.add(current);

    const m = await mlsService.getGroupMeta(current).catch(() => null);
    meta = m ? { name: m.name, isGroup: m.isGroup, deletedAt: m.deletedAt } : null;

    if (!m?.successorId) {
      return { terminalId: current, groupMeta: meta, hasChain: current !== startId };
    }
    current = m.successorId;
  }

  // Chaîne trop longue ou cycle - retourner le dernier observé
  return { terminalId: current, groupMeta: meta, hasChain: true };
}

/**
 * True when `ancestorId` is an earlier version in the same successor lineage as `terminalId`.
 */
export async function isAncestorInLineage(
  mlsService: IMlsService,
  ancestorId: string,
  terminalId: string
): Promise<boolean> {
  if (ancestorId === terminalId) return false;
  const { terminalId: resolved } = await resolveTerminalGroup(mlsService, ancestorId);
  return resolved === terminalId;
}

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
    // Successor may exist on the server before this user appears in getUserGroups().
    if (!index.byGroupId.has(current)) return current;
  }

  return null;
}

/** Successor group ids referenced by tombstones in the user's server group list. */
export function collectKnownSuccessorIds(groups: UserGroupRow[]): Set<string> {
  return new Set(
    groups
      .map((g) => g.successorId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
  );
}

/** Resolved 1:1 group to open: active row or successor id when only a tombstone is listed. */
export interface ResolvedDirectGroup {
  groupId: string;
  /** Tombstone id when membership list still points at a deleted predecessor. */
  tombstoneGroupId?: string;
}

/**
 * Finds the live DM group id for a peer, following successor links on soft-deleted tombstones.
 * Returns null when no matching direct group exists on the server.
 */
export function findActiveDirectGroupForPeer(
  groups: UserGroupRow[],
  userId: string,
  peerId: string
): ResolvedDirectGroup | null {
  const index = buildUserGroupSyncIndex(groups);
  const expectedNames = [
    `${userId.toLowerCase()}::${peerId.toLowerCase()}`,
    `${peerId.toLowerCase()}::${userId.toLowerCase()}`,
  ];

  for (const g of groups) {
    if (g.isGroup) continue;
    if (!expectedNames.includes((g.name ?? '').toLowerCase())) continue;

    const activeId = resolveActiveGroupTarget(g.groupId, index);
    if (activeId) {
      return {
        groupId: activeId,
        tombstoneGroupId: activeId !== g.groupId ? g.groupId : undefined,
      };
    }
  }

  return null;
}
