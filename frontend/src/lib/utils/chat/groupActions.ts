import { persistMlsStructuralCheckpoint } from '$lib/mls-client/mlsStatePersisterRegistry';
import type { IMlsService } from '$lib/mlsService';
import type { IStorage, StoredMessage } from '$lib/db';
import type { Conversation } from '$lib/types';
import { encodeAppMessage, mkSystem } from '$lib/proto/codec';
import { buildUserGroupSyncIndex, isGroupEligibleForMlsRecovery } from './groupSyncEligibility';

/**
 * Remonte (log applicatif + `console.warn`) les devices ignorés par `addMembersBulk` parce que
 * leur KeyPackage était invalide/illisible. Sans cette remontée, un device sauté disparaîtrait
 * silencieusement : jamais invité, jamais retenté. Le remède (republication d'un KeyPackage frais
 * puis nouvel ajout/reboot) est manuel/différé ; ici on garantit au moins la visibilité. [[C5]]
 *
 * @param tag Préfixe de log du caller (ex. `[ADD]`, `[SYNC]`, `[GROUP]`, `[REBOOT]`).
 */
export function warnSkippedKeyPackages(
  skippedDeviceIds: string[],
  groupId: string,
  tag: string,
  log: (msg: string) => void
): void {
  if (skippedDeviceIds.length === 0) return;
  log(
    `${tag} ${skippedDeviceIds.length} device(s) ignoré(s) (KeyPackage invalide): ${skippedDeviceIds.join(', ')} - non invité(s), republication d'un KeyPackage requise.`
  );
  console.warn(
    `${tag}[C5] KeyPackage invalide pour ${skippedDeviceIds.length} device(s) sur ${groupId}:`,
    skippedDeviceIds
  );
}

/** Returns the deduplicated list of userId strings that are members of a group (a user can have multiple devices). */
export async function fetchUniqueGroupMembers(mlsService: IMlsService, groupId: string) {
  const members = await mlsService.getGroupMembers(groupId);
  return [...new Set(members.map((m) => m.userId))];
}

/**
 * Détecte une erreur de commit rejeté indiquant que l'état MLS local est forké EN RETARD
 * sur le serveur (l'epoch envoyé est strictement inférieur à l'`activeEpoch` serveur).
 *
 * Format reconnu (cf. `mlsDeliveryApi.sendValidatedCommit`) :
 *   `Commit rejected: epoch_mismatch (server epoch: 23, sent: 7)`
 *
 * Retourne `{ serverEpoch, sentEpoch }` si l'appareil est en retard, sinon `null`
 * (erreur d'un autre type, ou epoch serveur <= epoch envoyé).
 */
export function parseForkedEpoch(err: unknown): { serverEpoch: number; sentEpoch: number } | null {
  const m = String(err).match(/server epoch:\s*(\d+),\s*sent:\s*(\d+)/);
  if (!m) return null;
  const serverEpoch = Number(m[1]);
  const sentEpoch = Number(m[2]);
  if (!Number.isFinite(serverEpoch) || !Number.isFinite(sentEpoch)) return null;
  if (serverEpoch <= sentEpoch) return null;
  return { serverEpoch, sentEpoch };
}

/**
 * Vrai si l'erreur de commit rejeté indique que CE device a forké en ayant DEJA mergé son
 * propre commit (chemin d'EMISSION : add/remove/kick suivi de `sendCommit`). Un seul écart
 * d'epoch suffit : on a perdu une course de commit concurrente, on a déjà avancé localement à
 * N+1 sur une branche divergente, et le commit gagnant (N -> N+1 sur l'autre branche) sera dropé
 * comme same-epoch bénin (cf. mls-core process_incoming) -> jamais adopté -> fork permanent. Le
 * seul remède est forget + re-Welcome pour adopter la branche gagnante. [[C7]]
 *
 * A ne PAS confondre avec un receveur en retard de 1 epoch (qui, lui, rattrape seul quand le
 * commit manquant arrive via la file) : ici l'epoch local a déjà été mergé par NOTRE commit.
 * Comme `parseForkedEpoch` ne renvoie non-null que pour `serverEpoch > sentEpoch`, tout
 * `epoch_mismatch` reçu APRES un merge local (chemin d'émission) est par définition un fork.
 */
export function isSenderForkError(err: unknown): boolean {
  return parseForkedEpoch(err) !== null;
}

/**
 * Supprime un groupe MLS :
 *  1. Diffuse un message "groupDeleted" à tous les membres AVANT la suppression serveur.
 *  2. Supprime le groupe côté serveur (DB + Redis).
 *  3. Oublie l'état MLS local.
 *
 * L'ordre 1→2 est critique : deleteGroupOnServer hard-delete dm_group_members, ce qui
 * prive le serveur de toute info de routage. Un message envoyé après serait perdu.
 */
export async function deleteGroupAndBroadcast(params: {
  mlsService: IMlsService;
  groupId: string;
  userId: string;
  pin: string;
  log?: (msg: string) => void;
}): Promise<void> {
  const { mlsService, groupId, userId, pin, log } = params;

  // 1. Notifier les pairs via MLS AVANT la suppression serveur.
  // Le chiffrement requiert l'état WASM (donc le groupe doit être local),
  // et le routage requiert dm_group_members (donc le groupe doit être sur le serveur).
  if (mlsService.getLocalGroups().includes(groupId)) {
    try {
      const controlMsg = encodeAppMessage(
        mkSystem('groupDeleted', JSON.stringify({ deletedBy: userId }))
      );
      await mlsService.sendMessage(groupId, controlMsg);
    } catch {
      // Non-blocking : les pairs découvriront la suppression lors du prochain pull
    }
  }

  // 2. Supprimer sur le serveur.
  try {
    const serverDeleted = await mlsService.deleteGroupOnServer(groupId);
    if (!serverDeleted) {
      log?.(`[DELETE] Groupe ${groupId.slice(0, 8)}… introuvable sur le serveur (déjà supprimé ?)`);
    }
  } catch (e) {
    log?.(`[DELETE] Erreur suppression serveur pour ${groupId.slice(0, 8)}…: ${String(e)}`);
    console.error('[DELETE] deleteGroupOnServer failed:', e);
  }

  // 3. Oublier le groupe localement - après l'envoi du message (le chiffrement requiert l'état MLS).
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
 *  1. Commit MLS remove - retire le leaf de l'arbre et avance l'epoch pour tous.
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
 *  1. Diffuse `memberLeft` aux autres membres (avant toute suppression -
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
    await persistMlsStructuralCheckpoint({ mlsService, pin, userId });
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
 * l'ancien KeyPackage du device est encore dans l'arbre MLS (état local perdu).
 * On kick le leaf stale et on reset le statut à pending pour que le device puisse
 * renvoyer une `welcome_request` avec un KeyPackage frais.
 *
 * Ne pas tester status='active' pour décider de skipper : `sendWelcome` marque
 * le device actif de façon optimiste avant que celui-ci traite le Welcome. Un device
 * qui a perdu son état sera toujours 'active' côté serveur.
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

  log(`[MLS] DuplicateSignature: kick leaf stale pour ${targetDeviceId.slice(0, 12)}…`);
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
  // Le remove génère un commit appliqué LOCALEMENT puis validé côté serveur. Si le serveur
  // le rejette pour epoch_mismatch (NOTRE état est forké), il ne faut surtout pas avaler
  // l'erreur : le commit a déjà avancé l'epoch local et réessayer ne ferait que creuser le
  // fork (storm kick/re-add). On remonte l'erreur pour que l'appelant déclenche la recovery
  // (forget + welcome_request). On escalade dès un écart de 1 (`isSenderForkError`) : ici
  // l'epoch local a déjà été mergé, donc même un écart de 1 est un fork concurrent réel, pas
  // un simple retard de receveur. Les autres erreurs (leaf déjà absent, etc.) restent
  // best-effort. [[C7]]
  try {
    await mlsService.removeMemberDevice(groupId, [deviceIdentity]);
  } catch (e) {
    if (isSenderForkError(e)) throw e;
  }
  await mlsService.kickStaleDevice(targetDeviceId, targetUserId, groupId).catch(() => {});
  log(`[KICK] Leaf stale ${targetUserId}:${targetDeviceId} retiré de ${groupId}`);
}

/**
 * Sérialise un `StoredMessage` pour le transport dans un `history_bundle`.
 *
 * Inclut toutes les métadonnées (réactions, accusés de lecture, isDeleted, isEdited,
 * marqueurs temporels secondaires) pour que le destinataire obtienne l'état complet
 * et puisse trier les messages de façon stable même après une migration de groupe.
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
    // Marqueurs temporels secondaires : nécessaires pour un tri stable post-migration
    // et pour afficher correctement la date du premier accusé de lecture.
    ...(m.readAt ? { readAt: m.readAt } : {}),
    ...(m.serverTimestamp ? { serverTimestamp: m.serverTimestamp } : {}),
  };
}

/**
 * Envoie l'intégralité de l'historique local de `groupId` aux membres actifs du groupe,
 * chiffré sous l'epoch MLS courante, en chunks de `chunkSize` messages (défaut 200).
 *
 * Cas d'usage :
 *  - Invitation d'un nouveau membre (handleWelcomeRequest, processPendingInvitations) :
 *    le bundle arrive après le Welcome, garanti en ordre par MLS.
 *  - Reboot CAS gagné : envoyé après inviteMembers pour que les members réinvités
 *    obtiennent l'historique migré depuis le groupe mort.
 *  - joinSuccessor : redistribue l'historique fraîchement migré au créateur du successeur
 *    qui avait un bundle vide (device sans historique local au moment du reboot).
 *  - resumePendingCasBundles : renvoi au redémarrage si le device a crashé entre
 *    l'écriture de la clé `cas_winner:{G}` et la suppression de celle-ci.
 *
 * Le destinataire déduplique les messages par `id` à la réception - appels multiples
 * idempotents. S'arrête au premier chunk en erreur pour éviter de spammer le réseau.
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
        `[HISTORY_BUNDLE] Chunk ${Math.floor(i / chunkSize) + 1}/${totalChunks} - ${payload.length} msg → ${groupId.slice(0, 8)}…`
      );
    } catch (e) {
      log(`[HISTORY_BUNDLE] Erreur envoi chunk ${Math.floor(i / chunkSize) + 1}: ${String(e)}`);
      return;
    }
  }
  log(`[HISTORY_BUNDLE] Historique complet envoyé : ${messages.length} message(s)`);
}
