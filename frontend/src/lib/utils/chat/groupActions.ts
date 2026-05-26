import { saveMlsState } from '$lib/utils/hex';
import type { IMlsService } from '$lib/mlsService';
import { encodeAppMessage, mkSystem } from '$lib/proto/codec';

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

  // Broadcast the rename notification — best-effort: the local rename is
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

  // 1. MLS remove commit — removes all devices of the target user from the group
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

  // 1. Notifier les autres membres (best-effort)
  try {
    const controlMsg = encodeAppMessage(mkSystem('memberLeft', JSON.stringify({ userId })));
    await mlsService.sendMessage(groupId, controlMsg);
  } catch {
    // Non-blocking
  }

  // 2. Se retirer du registre serveur
  try {
    await mlsService.removeMemberFromServer(groupId, userId);
  } catch {
    // Non-blocking
  }

  // 3. Sauvegarder l'état MLS puis oublier le groupe
  try {
    const stBytes = await mlsService.saveState(pin);
    saveMlsState(userId, stBytes);
  } catch {
    // Non-blocking
  }
}
