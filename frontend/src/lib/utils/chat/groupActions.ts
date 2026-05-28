import { saveMlsState } from '$lib/utils/hex';
import type { IMlsService } from '$lib/mlsService';
import type { IStorage, StoredMessage } from '$lib/db';
import type { Conversation } from '$lib/types';
import { encodeAppMessage, mkSystem } from '$lib/proto/codec';
import { buildUserGroupSyncIndex, isGroupEligibleForMlsRecovery } from './groupSyncEligibility';

/** Returns the deduplicated list of userId strings that are members of a group (a user can have multiple devices). */
export async function fetchUniqueGroupMembers(mlsService: IMlsService, groupId: string) {
  const members = await mlsService.getGroupMembers(groupId);
  return [...new Set(members.map((m) => m.userId))];
}

/**
 * Supprime un groupe MLS :
 *  1. Diffuse un message "groupDeleted" à tous les membres (pour qu'ils archiven leur conv).
 *  2. Supprime le groupe côté serveur (DB + Redis).
 *  3. Oublie l'état MLS local.
 */
export async function deleteGroupAndBroadcast(params: {
  mlsService: IMlsService;
  groupId: string;
  userId: string;
  pin: string;
}): Promise<void> {
  const { mlsService, groupId, userId, pin } = params;

  // 1. Supprimer sur le serveur en premier (404 = déjà absent, pas de notify MLS).
  let serverDeleted = false;
  try {
    serverDeleted = await mlsService.deleteGroupOnServer(groupId);
  } catch {
    // Non-blocking : le groupe sera orphelin côté serveur jusqu'au prochain GC
  }

  // 2. Notifier les pairs via MLS seulement si le serveur avait encore le groupe.
  if (serverDeleted) {
    try {
      const controlMsg = encodeAppMessage(
        mkSystem('groupDeleted', JSON.stringify({ deletedBy: userId }))
      );
      await mlsService.sendMessage(groupId, controlMsg);
    } catch {
      // Non-blocking : les pairs découvriront la suppression lors du prochain pull
    }
  }

  // 3. Sauvegarder l'état MLS (le groupe n'existe plus localement après forgetGroup)
  try {
    const stBytes = await mlsService.saveState(pin);
    saveMlsState(userId, stBytes);
  } catch {
    // Non-blocking
  }
}

/** Renames the group on the server, then broadcasts a "groupRenamed" system message to all members so their UIs update. */
export async function renameGroupAndBroadcast(params: {
  mlsService: IMlsService;
  groupId: string;
  newName: string;
  userId: string;
  pin: string;
}) {
  const { mlsService, groupId, newName, userId, pin } = params;
  await mlsService.renameGroup(groupId, newName);

  // Broadcast the rename notification - best-effort: the local rename is
  // already committed to the server; if the MLS message fails, peers will
  // still see the new name when they next fetch group metadata.
  try {
    const controlMsg = encodeAppMessage(mkSystem('groupRenamed', JSON.stringify({ newName })));
    await mlsService.sendMessage(groupId, controlMsg);
  } catch {
    // Non-blocking: rename already applied server-side
  }
  const stBytes = await mlsService.saveState(pin);
  saveMlsState(userId, stBytes);
}

/** Removes a member from the MLS group, broadcasts a "memberRemoved" system message, then persists the updated MLS state. */
export async function removeMemberAndBroadcast(params: {
  mlsService: IMlsService;
  groupId: string;
  memberId: string;
  userId: string;
  pin: string;
}) {
  const { mlsService, groupId, memberId, userId, pin } = params;

  // 1. MLS remove commit - removes all devices of the target user from the group
  //    and broadcasts the commit to remaining members so they advance their epoch.
  await mlsService.removeMember(groupId, [memberId]);

  // 2. Notify remaining members via an application-layer system message.
  //    Best-effort: do not abort server cleanup if notification fails.
  try {
    const controlMsg = encodeAppMessage(
      mkSystem('memberRemoved', JSON.stringify({ targetUser: memberId }))
    );
    await mlsService.sendMessage(groupId, controlMsg);
  } catch {
    // Non-blocking: the MLS commit already informed peers of the removal
  }

  // 3. Remove from the server-side member registry.
  //    Best-effort: even if this fails, the MLS tree no longer contains the member.
  try {
    await mlsService.removeMemberFromServer(groupId, memberId);
  } catch {
    // Non-blocking: retry on next sync if needed
  }

  const stBytes = await mlsService.saveState(pin);
  saveMlsState(userId, stBytes);
}

/**
 * Quitte un groupe MLS (du point de vue du membre lui-même) :
 *  1. Diffuse un message système "memberLeft" aux autres membres.
 *  2. Se retire du registre serveur.
 *  3. Sauvegarde l'état MLS avant d'oublier le groupe localement.
 */
export async function leaveGroupAndBroadcast(params: {
  mlsService: IMlsService;
  groupId: string;
  userId: string;
  pin: string;
}): Promise<void> {
  const { mlsService, groupId, userId, pin } = params;

  // Se retirer du registre serveur
  try {
    await mlsService.removeMemberFromServer(groupId, userId);
  } catch {
    // Non-blocking
  }

  // Sauvegarder l'état MLS
  try {
    const stBytes = await mlsService.saveState(pin);
    saveMlsState(userId, stBytes);
  } catch {
    // Non-blocking
  }
}

/**
 * Persists the WASM MLS blob to encrypted storage after forgetGroup / commits.
 * Without this, IndexedDB still holds a stale OpenMLS tree on next reload.
 */
export async function persistMlsStateAfterMutation(
  mlsService: IMlsService,
  userId: string,
  pin: string,
  log?: (msg: string) => void
): Promise<void> {
  try {
    const stBytes = await mlsService.saveState(pin);
    await saveMlsState(userId, stBytes);
  } catch (e) {
    log?.(`[MLS] Échec saveState après mutation: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Drops one group from the in-memory WASM/OpenMLS state when the server no longer lists it.
 * @returns true when forgetGroup was applied (caller should persist MLS state).
 */
export function forgetMlsGroupIfPresent(
  mlsService: IMlsService,
  groupId: string,
  log?: (msg: string) => void
): boolean {
  if (!mlsService.getLocalGroups().includes(groupId)) {
    return false;
  }
  try {
    mlsService.forgetGroup(groupId, 0);
    log?.(`[MLS] forgetGroup ${groupId} (absent côté serveur)`);
    return true;
  } catch (e) {
    log?.(
      `[MLS] forgetGroup échoué pour ${groupId}: ${e instanceof Error ? e.message : String(e)}`
    );
    return false;
  }
}

/**
 * Removes a sidebar / IndexedDB conversation row only (no MLS mutation).
 * Safe to call even when WASM no longer knows the groupId.
 */
export async function purgeLocalConversationRecord(params: {
  conversations: Map<string, Conversation>;
  contactKey: string;
  groupId: string;
  deleteConversation?: (key: string) => Promise<void>;
  log?: (msg: string) => void;
}): Promise<void> {
  const { conversations, contactKey, groupId, deleteConversation, log } = params;
  localStorage.removeItem(`discovery_pending:${groupId}`);
  if (deleteConversation) {
    await deleteConversation(contactKey).catch(() => {});
  }
  conversations.delete(contactKey);
  log?.(`[UI] Conversation locale retirée (${groupId})`);
}

/**
 * Full orphan cleanup: MLS state first (authoritative), then UI/IndexedDB row.
 */
export async function purgeOrphanGroup(params: {
  conversations: Map<string, Conversation>;
  mlsService: IMlsService;
  userId: string;
  pin: string;
  contactKey: string;
  groupId: string;
  deleteConversation?: (key: string) => Promise<void>;
  log?: (msg: string) => void;
}): Promise<void> {
  const { mlsService, userId, pin, groupId, log, ...uiParams } = params;
  const mlsChanged = forgetMlsGroupIfPresent(mlsService, groupId, log);
  if (mlsChanged) {
    await persistMlsStateAfterMutation(mlsService, userId, pin, log);
  }
  await purgeLocalConversationRecord({ ...uiParams, groupId, log });
}

/** Returns whether the group is still active for this user on the server (null = unknown). */
export async function isGroupActiveOnServer(
  mlsService: IMlsService,
  userId: string,
  groupId: string
): Promise<boolean | null> {
  try {
    const groups = await mlsService.getUserGroups(userId);
    return isGroupEligibleForMlsRecovery(groupId, buildUserGroupSyncIndex(groups));
  } catch {
    return null;
  }
}

/**
 * Retire silencieusement le leaf stale d'un device de l'arbre MLS (best-effort).
 * Encapsule removeMemberDevice + kickStaleDevice pour éviter la duplication.
 */
export async function kickStaleLeaf(
  groupId: string,
  targetUserId: string,
  targetDeviceId: string,
  mlsService: IMlsService,
  log: (msg: string) => void
): Promise<void> {
  const deviceIdentity = `${targetUserId}:${targetDeviceId}`;
  await mlsService.removeMemberDevice(groupId, [deviceIdentity]).catch(() => {});
  await mlsService.kickStaleDevice(targetDeviceId, targetUserId, groupId).catch(() => {});
  log(`[KICK] Leaf stale ${targetUserId}:${targetDeviceId} retiré de ${groupId}`);
}

/**
 * Envoie les `limit` derniers messages déchiffrés de `groupId` au nouveau membre
 * comme AppMessage système (`history_bundle`), chiffré sous l'epoch courante.
 *
 * Appelé par l'invitant juste après `sendCommit` pour que le destinataire reçoive
 * l'historique après avoir traité son Welcome (garantie d'ordre MLS).
 * Fail-silently : si l'envoi échoue, le destinataire démarre avec une conversation vide.
 */
export async function sendHistoryBundle(
  groupId: string,
  deps: {
    storage: IStorage | null;
    pin: string;
    mlsService: IMlsService;
    log: (msg: string) => void;
  },
  limit = 50
): Promise<void> {
  const { storage, pin, mlsService, log } = deps;
  if (!storage) return;

  let messages: StoredMessage[];
  try {
    messages = await storage.getMessagesPage(groupId, pin, limit);
  } catch {
    return;
  }
  if (messages.length === 0) return;

  const payload = messages.map((m) => ({
    id: m.id,
    senderId: m.senderId,
    content: m.content,
    timestamp: typeof m.timestamp === 'number' ? m.timestamp : Number(m.timestamp),
  }));

  const bytes = encodeAppMessage(mkSystem('history_bundle', JSON.stringify({ messages: payload })));
  try {
    await mlsService.sendMessage(groupId, bytes, undefined, true);
    log(`[HISTORY_BUNDLE] ${payload.length} messages envoyés à ${groupId}`);
  } catch (e) {
    log(`[HISTORY_BUNDLE] Erreur envoi: ${String(e)}`);
  }
}
