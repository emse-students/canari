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
  log?: (msg: string) => void;
}): Promise<void> {
  const { mlsService, groupId, userId, pin, log } = params;

  // 1. Supprimer sur le serveur en premier (404 = déjà absent, pas de notify MLS).
  let serverDeleted = false;
  try {
    serverDeleted = await mlsService.deleteGroupOnServer(groupId);
    if (!serverDeleted) {
      log?.(`[DELETE] Groupe ${groupId.slice(0, 8)}… introuvable sur le serveur (déjà supprimé ?)`);
    }
  } catch (e) {
    // Si le groupe a un successeur (reboot en cours), la suppression peut échouer.
    // On envoie quand même le message MLS pour prévenir les pairs si on a le groupe localement.
    log?.(`[DELETE] Erreur suppression serveur pour ${groupId.slice(0, 8)}…: ${String(e)}`);
    console.error('[DELETE] deleteGroupOnServer failed:', e);
    // Si on a le groupe localement, tenter quand même d'en informer les membres
    if (mlsService.getLocalGroups().includes(groupId)) {
      serverDeleted = true;
    }
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

  // 3. Oublier le groupe localement — après l'envoi du message (le chiffrement requiert l'état MLS).
  // Sans ça, le groupe reste dans l'état WASM du supprimeur et continue à apparaître
  // dans getLocalGroups(), ce qui provoque des tentatives de recovery fantômes.
  try {
    mlsService.forgetGroup(groupId);
  } catch {
    /* non-bloquant */
  }

  // 4. Sauvegarder l'état MLS (forgetGroup a modifié l'arbre WASM)
  await persistMlsStateAfterMutation(mlsService, userId, pin, log);
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
  await persistMlsStateAfterMutation(mlsService, userId, pin);
}

/**
 * Envoie un message système MLS pour notifier un changement de membership.
 *
 * Toujours best-effort : si l'envoi échoue les pairs découvriront le changement
 * lors de leur prochain `getUserGroups`. Ne jamais appeler après `forgetGroup`.
 */
async function notifyMembershipChange(
  mlsService: IMlsService,
  groupId: string,
  event: 'memberLeft' | 'memberRemoved',
  payload: Record<string, string>
): Promise<void> {
  try {
    await mlsService.sendMessage(
      groupId,
      encodeAppMessage(mkSystem(event, JSON.stringify(payload)))
    );
  } catch {
    /* non-bloquant */
  }
}

/**
 * Retire un membre du groupe MLS (action d'un administrateur) :
 *  1. Commit MLS remove — retire le leaf de l'arbre et avance l'epoch pour tous.
 *  2. Diffuse `memberRemoved` aux membres restants.
 *  3. Nettoie le registre serveur (dm_group_members + dm_device_group_memberships).
 */
export async function removeMemberAndBroadcast(params: {
  mlsService: IMlsService;
  groupId: string;
  memberId: string;
  userId: string;
  pin: string;
}) {
  const { mlsService, groupId, memberId, userId, pin } = params;

  // 1. MLS remove commit : retire le leaf du membre pour tous les membres restants.
  await mlsService.removeMember(groupId, [memberId]);

  // 2. Notifier les membres restants.
  await notifyMembershipChange(mlsService, groupId, 'memberRemoved', { targetUser: memberId });

  // 3. Nettoyer le registre serveur. Best-effort : le commit MLS fait foi.
  try {
    await mlsService.removeMemberFromServer(groupId, memberId);
  } catch {
    /* non-bloquant */
  }

  await persistMlsStateAfterMutation(mlsService, userId, pin);
}

/**
 * Quitte un groupe MLS (auto-retrait du membre lui-même) :
 *  1. Diffuse `memberLeft` aux autres membres (avant toute suppression —
 *     l'état WASM doit être valide pour chiffrer le message).
 *  2. Se retire du registre serveur (dm_group_members + dm_device_group_memberships).
 *  3. Oublie le groupe localement pour ne pas laisser un leaf orphelin dans
 *     getLocalGroups() et déclencher des tentatives de recovery fantômes.
 *
 * Contrairement à `removeMemberAndBroadcast`, cette fonction ne génère pas
 * de commit MLS remove : le leaf du membre reste dans l'arbre des autres
 * jusqu'au prochain commit, mais il ne reçoit plus de messages (server-side).
 */
export async function leaveGroupAndBroadcast(params: {
  mlsService: IMlsService;
  groupId: string;
  userId: string;
  pin: string;
}): Promise<void> {
  const { mlsService, groupId, userId, pin } = params;

  // 1. Notifier AVANT la suppression serveur (le WASM doit être intact pour chiffrer).
  await notifyMembershipChange(mlsService, groupId, 'memberLeft', { userId });

  // 2. Nettoyer le registre serveur.
  try {
    await mlsService.removeMemberFromServer(groupId, userId);
  } catch {
    /* non-bloquant */
  }

  // 3. Oublier l'état WASM local.
  try {
    mlsService.forgetGroup(groupId);
  } catch {
    /* non-bloquant */
  }

  await persistMlsStateAfterMutation(mlsService, userId, pin);
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
 * Traitement unifié d'une erreur `DuplicateSignature` levée par `addMember` :
 *  - Si le device est déjà `active` côté serveur → Welcome déjà livré, on skip.
 *  - Sinon (leaf stale — état local perdu) → `kickStaleLeaf` pour que le device
 *    puisse renvoyer un `welcome_request` avec un KeyPackage frais.
 *
 * Factorisé ici car le même traitement est requis dans `handleWelcomeRequest`
 * et `processPendingInvitations`. En cas d'erreur réseau sur `getDeviceMemberships`,
 * on skip plutôt que de kicker un device potentiellement actif.
 */
export async function handleDuplicateLeafError(params: {
  mlsService: IMlsService;
  groupId: string;
  targetUserId: string;
  targetDeviceId: string;
  userId: string;
  pin: string;
  log: (msg: string) => void;
}): Promise<void> {
  const { mlsService, groupId, targetUserId, targetDeviceId, userId, pin, log } = params;

  let memberStatus: string | undefined;
  try {
    const memberships = await mlsService.getDeviceMemberships(targetUserId, targetDeviceId);
    memberStatus = memberships.find((x) => x.groupId === groupId)?.status;
  } catch {
    // Erreur réseau : impossible de vérifier le statut en toute sécurité → skip.
    log(`[MLS] DuplicateSignature: statut inconnu pour ${targetDeviceId.slice(0, 12)}… — skip`);
    return;
  }

  if (memberStatus === 'active') {
    log(`[MLS] ${targetDeviceId.slice(0, 12)}… déjà actif (Welcome reçu) — skip`);
    return;
  }

  // Leaf stale : état local perdu, ancien KP encore dans l'arbre.
  await kickStaleLeaf(groupId, targetUserId, targetDeviceId, mlsService, log);
  await persistMlsStateAfterMutation(mlsService, userId, pin, log);
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
/**
 * Sérialise un StoredMessage pour le transport dans un history_bundle.
 * Inclut toutes les métadonnées (réactions, accusés de lecture, isDeleted, isEdited)
 * pour que le destinataire obtienne l'état complet, pas seulement le texte brut.
 */
function serializeForBundle(m: StoredMessage) {
  return {
    id: m.id,
    senderId: m.senderId,
    content: m.content,
    timestamp: typeof m.timestamp === 'number' ? m.timestamp : Number(m.timestamp),
    ...(m.reactions?.length ? { reactions: m.reactions } : {}),
    ...(m.readBy?.length ? { readBy: m.readBy } : {}),
    ...(m.isDeleted ? { isDeleted: true } : {}),
    ...(m.isEdited ? { isEdited: true } : {}),
  };
}

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

  const payload = messages.map(serializeForBundle);

  const bytes = encodeAppMessage(mkSystem('history_bundle', JSON.stringify({ messages: payload })));
  try {
    await mlsService.sendMessage(groupId, bytes, undefined, true);
    log(`[HISTORY_BUNDLE] ${payload.length} messages envoyés à ${groupId}`);
  } catch (e) {
    log(`[HISTORY_BUNDLE] Erreur envoi: ${String(e)}`);
  }
}

/**
 * Envoie l'intégralité de l'historique de `groupId` en chunks de `chunkSize` messages
 * (défaut 200) pour les devices fresh (population 3 d'un reboot).
 *
 * Contrairement à `sendHistoryBundle` (limité aux 50 derniers), cette fonction envoie
 * tous les messages via plusieurs `history_bundle` séquentiels. Le destinataire
 * déduplique à la réception — appels multiples idempotents.
 * S'arrête au premier chunk en erreur pour ne pas spammer en cas de panne réseau.
 */
export async function sendFullHistoryBundle(
  groupId: string,
  deps: {
    storage: IStorage | null;
    pin: string;
    mlsService: IMlsService;
    log: (msg: string) => void;
  },
  chunkSize = 200
): Promise<void> {
  const { storage, pin, mlsService, log } = deps;
  if (!storage) return;

  let messages: StoredMessage[];
  try {
    messages = await storage.getMessages(groupId, pin);
  } catch {
    return;
  }
  if (messages.length === 0) return;

  const totalChunks = Math.ceil(messages.length / chunkSize);
  for (let i = 0; i < messages.length; i += chunkSize) {
    const chunk = messages.slice(i, i + chunkSize);
    const payload = chunk.map(serializeForBundle);
    const bytes = encodeAppMessage(
      mkSystem('history_bundle', JSON.stringify({ messages: payload }))
    );
    try {
      await mlsService.sendMessage(groupId, bytes, undefined, true);
      log(
        `[HISTORY_BUNDLE] Chunk ${Math.floor(i / chunkSize) + 1}/${totalChunks} — ${payload.length} msg → ${groupId.slice(0, 8)}…`
      );
    } catch (e) {
      log(`[HISTORY_BUNDLE] Erreur envoi chunk ${Math.floor(i / chunkSize) + 1}: ${String(e)}`);
      return;
    }
  }
  log(`[HISTORY_BUNDLE] Historique complet envoyé : ${messages.length} message(s)`);
}
