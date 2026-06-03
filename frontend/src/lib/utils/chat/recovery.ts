import type { IMlsService, UserGroupRow } from '$lib/mls-client/IMlsService';
import type { IStorage } from '$lib/db';
import type { Conversation } from '$lib/types';
import { saveMlsState } from '$lib/utils/hex';
import type { SvelteMap } from 'svelte/reactivity';

/**
 * Dépendances minimales requises par les fonctions de recovery.
 * Sous-ensemble de MessageHandlerDeps — les deux sont compatibles.
 */
export interface RecoveryDeps {
  mlsService: IMlsService;
  storage: IStorage | null;
  userId: string;
  pin: string;
  conversations: SvelteMap<string, Conversation>;
  getSelectedContact: () => string | null;
  setSelectedContact: (id: string | null) => void;
  saveConversation: (key: string) => Promise<void>;
  deleteConversation?: (key: string) => Promise<void>;
  log: (msg: string) => void;
}

/**
 * Demande à être ré-invité dans un groupe (Welcome manquant ou epoch décalée).
 *
 * Envoie un `welcome_request` puis arme un timer de 30s. Si le groupe
 * n'est toujours pas dans le WASM local à l'expiration, déclenche `reboot`.
 * Idempotent : si un timer est déjà actif pour ce groupe, l'appel est ignoré.
 */
export async function requestReAdd(
  groupId: string,
  deps: RecoveryDeps,
  timers: Map<string, ReturnType<typeof setTimeout>>
): Promise<void> {
  if (timers.has(groupId)) return;

  await deps.mlsService
    .sendWelcomeRequest(groupId)
    .catch((e) =>
      deps.log(`[READD] welcome_request échoué pour ${groupId.slice(0, 8)}…: ${String(e)}`)
    );
  deps.log(`[READD] welcome_request envoyé pour ${groupId.slice(0, 8)}… (timeout 30s)`);

  const t = setTimeout(async () => {
    timers.delete(groupId);
    if (!deps.mlsService.getLocalGroups().includes(groupId)) {
      deps.log(`[READD] 30s écoulées sans Welcome pour ${groupId.slice(0, 8)}… — reboot`);
      await reboot(groupId, deps).catch((e) =>
        deps.log(`[READD] reboot échoué pour ${groupId.slice(0, 8)}…: ${String(e)}`)
      );
    }
  }, 30_000);
  timers.set(groupId, t);
}

/**
 * Annule le timer de re-add pour un groupe (appelé quand le Welcome arrive).
 */
export function cancelReAdd(
  groupId: string,
  timers: Map<string, ReturnType<typeof setTimeout>>
): void {
  const t = timers.get(groupId);
  if (t !== undefined) {
    clearTimeout(t);
    timers.delete(groupId);
  }
}

/**
 * Reboot fork resolution (OpenMLS book §fork-resolution).
 *
 * Crée un groupe successeur, le revendique via CAS (premier arrivé premier servi),
 * invite tous les membres de l'ancien groupe, puis migre la conversation locale.
 * Si le CAS est perdu, rejoint le groupe du gagnant.
 */
export async function reboot(groupId: string, deps: RecoveryDeps): Promise<void> {
  const { mlsService, userId, pin, log } = deps;
  log(`[REBOOT] Lancement pour groupe ${groupId.slice(0, 8)}…`);

  // Étape 1 : successeur déjà revendiqué par un autre device ?
  const meta = await mlsService.getGroupMeta(groupId);
  if (meta?.successorId) {
    return joinSuccessor(groupId, meta.successorId, deps);
  }

  // Étape 2 : lire les infos du groupe depuis le serveur (name, isGroup)
  let groups: UserGroupRow[];
  try {
    groups = await mlsService.getUserGroups(userId);
  } catch {
    groups = [];
  }
  const row = groups.find((g) => g.groupId === groupId);
  const name = row?.name ?? meta?.name ?? '';
  const isGroup = row?.isGroup ?? meta?.isGroup ?? false;

  // Étape 3 : créer un candidat successeur
  let candidateId: string | null = null;
  try {
    candidateId = await mlsService.createRemoteGroup(name, isGroup);
    log(`[REBOOT] Candidat créé : ${candidateId.slice(0, 8)}…`);
    await mlsService.createGroup(candidateId);
    await mlsService.registerMember(candidateId, userId);
    await saveMlsState(userId, await mlsService.saveState(pin));
  } catch (e) {
    log(`[REBOOT] Échec création candidat : ${String(e)}`);
    if (candidateId) {
      await mlsService.deleteGroupOnServer(candidateId).catch(() => {});
      mlsService.forgetGroup(candidateId);
    }
    throw e;
  }

  // Étape 4 : CAS — premier arrivé premier servi
  const claim = await mlsService.claimGroupSuccessor(groupId, candidateId);

  if (!claim.claimed) {
    // CAS perdu — nettoyer le candidat orphelin et rejoindre le gagnant
    log(
      `[REBOOT] CAS perdu — suppression ${candidateId.slice(0, 8)}…, migration vers ${claim.successorId?.slice(0, 8)}…`
    );
    await mlsService.deleteGroupOnServer(candidateId).catch(() => {});
    mlsService.forgetGroup(candidateId);
    if (claim.successorId) return joinSuccessor(groupId, claim.successorId, deps);
    return;
  }

  // Étape 5 : CAS gagné — inviter tous les membres de l'ancien groupe
  log(`[REBOOT] CAS gagné — invitation membres dans ${candidateId.slice(0, 8)}…`);
  await inviteMembers(groupId, candidateId, deps).catch((e) =>
    log(`[REBOOT] Erreur invitation membres : ${String(e)}`)
  );

  // Étape 6 : migrer la conversation locale
  await migrateConversation(groupId, candidateId, deps);

  // Marquer le successeur comme prêt (ce device est le créateur)
  const newConvo = deps.conversations.get(candidateId);
  if (newConvo && !newConvo.isReady) {
    deps.conversations.set(candidateId, { ...newConvo, isReady: true });
    await deps.saveConversation(candidateId).catch(() => {});
  }

  log(`[REBOOT] Terminé : ${groupId.slice(0, 8)}… → ${candidateId.slice(0, 8)}…`);
}

/**
 * Rejoint un groupe successeur déjà revendiqué par un autre device.
 * Enregistre ce device comme membre et envoie un welcome_request.
 */
async function joinSuccessor(
  deadGroupId: string,
  successorId: string,
  deps: RecoveryDeps
): Promise<void> {
  const { mlsService, userId, log } = deps;
  log(`[REBOOT] Rejoindre successeur ${successorId.slice(0, 8)}…`);

  await mlsService.registerMember(successorId, userId).catch(() => {});

  const hasLocal = mlsService.getLocalGroups().includes(successorId);
  if (!hasLocal) {
    await mlsService.sendWelcomeRequest(successorId).catch(() => {});
    log(`[REBOOT] welcome_request envoyé pour successeur ${successorId.slice(0, 8)}…`);
  }

  await migrateConversation(deadGroupId, successorId, deps);
}

/**
 * Invite tous les membres de l'ancien groupe dans le nouveau groupe successeur.
 *
 * Corrections appliquées :
 * - R4 : le commit est envoyé via sendCommit (validation epoch)
 * - R5 : retry du add-lock après 2s si l'acquisition échoue
 * - Les Welcomes sont envoyés APRÈS le commit (ordre correct)
 */
async function inviteMembers(
  deadGroupId: string,
  successorId: string,
  deps: RecoveryDeps
): Promise<void> {
  const { mlsService, userId, pin, log } = deps;

  const members = await mlsService.getGroupMembers(deadGroupId);
  const otherIds = [...new Set(members.map((m) => m.userId).filter((id) => id !== userId))];
  if (otherIds.length === 0) {
    log('[REBOOT] Aucun autre membre à inviter.');
    return;
  }

  // Récupérer les devices de tous les membres en parallèle
  const devicesByUser = await Promise.all(otherIds.map((id) => mlsService.fetchUserDevices(id)));
  const allDevices: Array<{ keyPackage: Uint8Array; deviceId: string }> = [];
  const deviceToUser = new Map<string, string>();
  for (const [i, devices] of devicesByUser.entries()) {
    for (const d of devices) {
      allDevices.push(d);
      deviceToUser.set(d.deviceId, otherIds[i]);
    }
  }
  if (allDevices.length === 0) {
    log('[REBOOT] Aucun device disponible pour les membres.');
    return;
  }

  // Acquérir le add-lock — retry une fois après 2s (fix R5)
  let locked = await mlsService.acquireAddLock(successorId).catch(() => false);
  if (!locked) {
    await new Promise((r) => setTimeout(r, 2_000));
    locked = await mlsService.acquireAddLock(successorId).catch(() => false);
    if (!locked) {
      log('[REBOOT] Add-lock non disponible — abandon (un autre device le traite).');
      return;
    }
  }

  try {
    const bulk = await mlsService.addMembersBulk(successorId, allDevices);
    log(`[REBOOT] ${bulk.addedDeviceIds.length} device(s) ajouté(s)`);

    // Persister AVANT d'envoyer (si crash, les membres peuvent rejoindre via welcome_request)
    await saveMlsState(userId, await mlsService.saveState(pin));

    // Envoyer le commit d'abord (fix R4 : via sendCommit qui valide l'epoch)
    if (bulk.commit) {
      await mlsService.sendCommit(bulk.commit, successorId);
    }

    // Puis les Welcomes
    if (bulk.welcome) {
      for (const deviceId of bulk.addedDeviceIds) {
        const memberId = deviceToUser.get(deviceId);
        if (!memberId) continue;
        await mlsService
          .sendWelcome(bulk.welcome, memberId, successorId, deviceId, bulk.ratchetTree)
          .catch((e) => log(`[REBOOT] Erreur Welcome ${deviceId}: ${String(e)}`));
        log(`[REBOOT] Welcome envoyé à ${memberId}:${deviceId}`);
      }
    }
  } finally {
    await mlsService.releaseAddLock(successorId).catch(() => {});
  }
}

/**
 * Migre une conversation de l'ancien groupe vers le successeur :
 * - Copie les messages locaux (avec déduplication — fix C8)
 * - Remet la conversation à jour dans le map réactif
 * - Redirige l'UI si la conversation active était l'ancienne
 * - Supprime l'ancienne entrée
 */
export async function migrateConversation(
  fromGroupId: string,
  toGroupId: string,
  deps: RecoveryDeps
): Promise<void> {
  const {
    storage,
    conversations,
    pin,
    getSelectedContact,
    setSelectedContact,
    saveConversation,
    deleteConversation,
    log,
  } = deps;

  const oldConvo = conversations.get(fromGroupId);
  if (!oldConvo) {
    log(`[MIGRATE] Conversation source ${fromGroupId.slice(0, 8)}… introuvable — skip`);
    return;
  }
  log(`[MIGRATE] ${fromGroupId.slice(0, 8)}… → ${toGroupId.slice(0, 8)}… ("${oldConvo.name}")`);

  const existingTarget = conversations.get(toGroupId);
  const localGroups = deps.mlsService.getLocalGroups();
  const targetAlreadyReady = existingTarget?.isReady === true || localGroups.includes(toGroupId);

  // Copier les messages uniquement si la cible n'a pas encore de conversation (fix C8 : dédup)
  if (storage && !existingTarget) {
    try {
      const msgs = await storage.getMessages(fromGroupId, pin);
      if (msgs.length > 0) {
        const rekeyed = msgs.map((m) => ({ ...m, conversationId: toGroupId }));
        await storage.saveMessages(rekeyed, pin);
        log(`[MIGRATE] ${msgs.length} message(s) copié(s)`);
      }
    } catch (e) {
      log(`[MIGRATE] Erreur copie messages : ${String(e)}`);
    }
  }

  // Persister la nouvelle conversation avant de supprimer l'ancienne
  if (storage) {
    await storage
      .saveConversation({
        id: toGroupId,
        name: oldConvo.name,
        isReady: targetAlreadyReady,
        updatedAt: Date.now(),
      })
      .catch((e) => log(`[MIGRATE] Erreur sauvegarde : ${String(e)}`));
  }

  const merged: Conversation = existingTarget
    ? { ...existingTarget, name: oldConvo.name, isReady: targetAlreadyReady }
    : { ...oldConvo, id: toGroupId, isReady: targetAlreadyReady };
  conversations.set(toGroupId, merged);

  if (getSelectedContact() === fromGroupId) setSelectedContact(toGroupId);

  conversations.delete(fromGroupId);
  if (deleteConversation) await deleteConversation(fromGroupId).catch(() => {});

  try {
    deps.mlsService.forgetGroup(fromGroupId);
  } catch {
    /* non-bloquant */
  }

  await saveConversation(toGroupId);
  log(`[MIGRATE] Terminé — "${oldConvo.name}" vit maintenant dans ${toGroupId.slice(0, 8)}…`);
}

/**
 * Health check périodique : pour tout groupe serveur ayant un successeur,
 * déclenche la migration locale si elle n'a pas encore eu lieu.
 *
 * Également : si ce device a créé un successeur (epoch=0) mais a crashé avant
 * d'avoir invité les membres, retente l'invitation.
 *
 * Appelé à la connexion et toutes les 5 minutes (onglet leader uniquement).
 */
export async function checkGroupSuccessors(deps: RecoveryDeps): Promise<void> {
  const { mlsService, userId, pin, conversations, log } = deps;

  let serverGroups: UserGroupRow[];
  try {
    serverGroups = await mlsService.getUserGroups(userId);
  } catch {
    return;
  }

  for (const g of serverGroups) {
    if (!g.successorId) continue;
    const successorId = g.successorId;

    // Migration si pas encore faite
    if (conversations.has(g.groupId) && !conversations.has(successorId)) {
      log(
        `[HEALTH] Successeur détecté ${g.groupId.slice(0, 8)}… → ${successorId.slice(0, 8)}… — migration`
      );
      await migrateConversation(g.groupId, successorId, deps).catch((e) =>
        log(`[HEALTH] Erreur migration : ${String(e)}`)
      );
    } else if (conversations.has(g.groupId)) {
      conversations.delete(g.groupId);
      if (deps.deleteConversation) await deps.deleteConversation(g.groupId).catch(() => {});
      try {
        mlsService.forgetGroup(g.groupId);
        await saveMlsState(userId, await mlsService.saveState(pin));
      } catch {
        /* non-bloquant */
      }
    }

    // Crash recovery : ce device a gagné le CAS mais n'a pas invité les membres
    const localGroups = mlsService.getLocalGroups();
    if (localGroups.includes(successorId) && mlsService.getEpoch(successorId) === 0) {
      log(`[HEALTH] Successeur ${successorId.slice(0, 8)}… epoch=0 — ré-invitation post-crash`);
      await inviteMembers(g.groupId, successorId, deps).catch((e) =>
        log(`[HEALTH] Erreur ré-invitation : ${String(e)}`)
      );
      const convo = conversations.get(successorId);
      if (convo && !convo.isReady) {
        conversations.set(successorId, { ...convo, isReady: true });
        await deps.saveConversation(successorId).catch(() => {});
      }
    }
  }
}
