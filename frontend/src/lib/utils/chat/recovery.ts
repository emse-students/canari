import type { IMlsService, UserGroupRow } from '$lib/mls-client/IMlsService';
import type { IStorage } from '$lib/db';
import type { Conversation } from '$lib/types';
import { saveMlsState } from '$lib/utils/hex';
import type { SvelteMap } from 'svelte/reactivity';
import { sendFullHistoryBundle } from './groupActions';

/**
 * Délai avant d'escalader de welcome_request vers reboot.
 * 60s laisse le temps au FCM iOS (background) de réveiller le pair
 * et de recevoir le Welcome avant de recréer un groupe successeur.
 */
export const RECOVERY_TIMEOUT_MS = 60_000;

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

  // Guard : si le groupe est mort (a un successeur), envoyer la welcome_request
  // vers le successeur ou ne rien faire si on est déjà dedans.
  const meta = await deps.mlsService.getGroupMeta(groupId).catch(() => null);
  if (meta?.successorId) {
    const localGroups = deps.mlsService.getLocalGroups();
    if (localGroups.includes(meta.successorId)) {
      deps.log(
        `[READD] ${groupId.slice(0, 8)}… mort — successeur ${meta.successorId.slice(0, 8)}… en WASM — skip`
      );
      return;
    }
    deps.log(
      `[READD] ${groupId.slice(0, 8)}… mort → redirection vers successeur ${meta.successorId.slice(0, 8)}…`
    );
    return requestReAdd(meta.successorId, deps, timers);
  }

  // Groupe supprimé intentionnellement (deletedAt posé par deleteGroup) et sans successeur.
  // Ne pas envoyer de welcome_request ni armer un reboot : personne ne peut répondre
  // (dm_group_members effacé) et le CAS de claimSuccessor refuse désormais les groupes
  // déjà supprimés, donc le reboot créerait un candidat orphelin immédiatement nettoyé.
  if (meta?.deletedAt) {
    deps.log(`[READD] ${groupId.slice(0, 8)}… supprimé sans successeur — abandon`);
    return;
  }

  await deps.mlsService
    .sendWelcomeRequest(groupId)
    .catch((e) =>
      deps.log(`[READD] welcome_request échoué pour ${groupId.slice(0, 8)}…: ${String(e)}`)
    );
  deps.log(`[READD] welcome_request envoyé pour ${groupId.slice(0, 8)}… (timeout 30s)`);

  const t = setTimeout(async () => {
    timers.delete(groupId);
    if (!deps.mlsService.getLocalGroups().includes(groupId)) {
      deps.log(
        `[READD] ${RECOVERY_TIMEOUT_MS / 1000}s écoulées sans Welcome pour ${groupId.slice(0, 8)}… — reboot`
      );
      await reboot(groupId, deps).catch((e) =>
        deps.log(`[READD] reboot échoué pour ${groupId.slice(0, 8)}…: ${String(e)}`)
      );
    }
  }, RECOVERY_TIMEOUT_MS);
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

  // Guard : si le groupe est déjà dans le WASM local, la recovery est inutile.
  // Protège contre les races entre un Welcome tardif et les timers de reboot (requestReAdd,
  // watchdog) : sans ce guard, le reboot créerait un successeur pour un groupe fonctionnel.
  if (mlsService.getLocalGroups().includes(groupId)) {
    log(`[REBOOT] ${groupId.slice(0, 8)}… déjà dans WASM — annulé`);
    return;
  }

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

  // Étape 5 : CAS gagné — marquer ce device comme responsable du bundle historique
  // avant toute opération réseau pour survivre aux crashes.
  const casBundleKey = `cas_winner:${groupId}`;
  localStorage.setItem(casBundleKey, candidateId);

  // Inviter tous les membres de l'ancien groupe.
  // Si le groupe mort n'a plus de membres (deleteGroup a effacé dm_group_members),
  // remonter la chaîne pour trouver l'ancêtre le plus proche qui en a encore.
  log(`[REBOOT] CAS gagné — invitation membres dans ${candidateId.slice(0, 8)}…`);
  const memberSourceId = await findAncestorWithMembers(groupId, groups, deps);
  await inviteMembers(memberSourceId, candidateId, deps).catch((e) =>
    log(`[REBOOT] Erreur invitation membres : ${String(e)}`)
  );

  // Étape 6 : migrer la conversation locale (copie TOUS les messages de G vers S)
  await migrateConversation(groupId, candidateId, deps);

  // Marquer le successeur comme prêt (ce device est le créateur)
  const newConvo = deps.conversations.get(candidateId);
  if (newConvo && !newConvo.isReady) {
    deps.conversations.set(candidateId, { ...newConvo, isReady: true });
    await deps.saveConversation(candidateId).catch(() => {});
  }

  // Étape 7 : envoyer l'historique complet aux membres invités (population 3 — fresh devices)
  // Appelé après migrateConversation : les messages de G sont maintenant dans S.
  await sendFullHistoryBundle(candidateId, {
    storage: deps.storage,
    pin: deps.pin,
    mlsService: deps.mlsService,
    log: deps.log,
  }).catch((e) => log(`[REBOOT] Erreur bundle historique : ${String(e)}`));
  localStorage.removeItem(casBundleKey);

  log(`[REBOOT] Terminé : ${groupId.slice(0, 8)}… → ${candidateId.slice(0, 8)}…`);
}

/**
 * Rejoint un groupe successeur déjà revendiqué par un autre device.
 * Enregistre ce device comme membre puis appelle `requestReAdd` pour :
 *  1. Envoyer un welcome_request immédiatement.
 *  2. Armer un timer 30s → reboot(successorId) si aucun Welcome n'arrive.
 *
 * La map de timers est locale et anonyme : elle ne peut pas être annulée depuis
 * l'extérieur, mais `reboot` retourne immédiatement si le groupe est déjà rejoint
 * (guard `localGroups.includes`), donc le timer tardif est inoffensif.
 */
async function joinSuccessor(
  deadGroupId: string,
  successorId: string,
  deps: RecoveryDeps
): Promise<void> {
  const { mlsService, userId, log } = deps;
  log(`[REBOOT] Rejoindre successeur ${successorId.slice(0, 8)}…`);

  await mlsService.registerMember(successorId, userId).catch(() => {});

  if (!mlsService.getLocalGroups().includes(successorId)) {
    await requestReAdd(successorId, deps, new Map());
  }

  await migrateConversation(deadGroupId, successorId, deps);
}

/**
 * Remonte la chaîne de succession à rebours depuis `groupId` pour trouver
 * l'ancêtre le plus récent qui possède encore des membres dans dm_group_members.
 *
 * Nécessaire quand un groupe mort a été supprimé via `deleteGroupOnServer`
 * (qui efface dm_group_members) mais qu'un parent dans la chaîne conserve
 * ses membres (car `claimGroupSuccessor` ne touche pas dm_group_members).
 * Retourne `groupId` si aucun ancêtre meilleur n'est trouvé.
 */
async function findAncestorWithMembers(
  groupId: string,
  chainGroups: UserGroupRow[],
  deps: RecoveryDeps
): Promise<string> {
  const members = await deps.mlsService.getGroupMembers(groupId).catch(() => []);
  if (members.length > 0) return groupId;

  let current = groupId;
  for (let depth = 0; depth < 10; depth++) {
    const parent = chainGroups.find((g) => g.successorId === current);
    if (!parent) break;
    const parentMembers = await deps.mlsService.getGroupMembers(parent.groupId).catch(() => []);
    if (parentMembers.length > 0) {
      deps.log(
        `[REBOOT] Groupe mort sans membres — fallback ancêtre ${parent.groupId.slice(0, 8)}…`
      );
      return parent.groupId;
    }
    current = parent.groupId;
  }
  return groupId;
}

/**
 * Invite tous les membres de `deadGroupId` dans le nouveau groupe successeur.
 *
 * Corrections appliquées :
 * - R4 : le commit est envoyé via sendCommit (validation epoch)
 * - R5 : retry du add-lock après 2s si l'acquisition échoue
 * - Les Welcomes sont envoyés APRÈS le commit (ordre correct)
 * - R6 : enregistrement des membres non-créateurs dans dm_group_members
 *        (sans ça, getUserGroups ne retourne pas le successeur pour eux)
 */
async function inviteMembers(
  deadGroupId: string,
  successorId: string,
  deps: RecoveryDeps
): Promise<void> {
  const { mlsService, userId, pin, log } = deps;

  const members = await mlsService.getGroupMembers(deadGroupId);
  // Inclure TOUS les userIds (y compris le créateur) pour inviter leurs autres devices.
  // On n'exclut que le device courant lui-même (déjà dans le groupe comme créateur).
  const myDeviceId = mlsService.getDeviceId();
  const allUserIds = [...new Set(members.map((m) => m.userId))];
  if (allUserIds.length === 0) {
    log('[REBOOT] Aucun membre dans le groupe mort.');
    return;
  }

  // Récupérer les devices de tous les membres en parallèle
  const devicesByUser = await Promise.all(allUserIds.map((id) => mlsService.fetchUserDevices(id)));
  const allDevices: Array<{ keyPackage: Uint8Array; deviceId: string }> = [];
  const deviceToUser = new Map<string, string>();
  for (const [i, devices] of devicesByUser.entries()) {
    for (const d of devices) {
      if (d.deviceId === myDeviceId) continue; // Skip le device courant (créateur)
      allDevices.push(d);
      deviceToUser.set(d.deviceId, allUserIds[i]);
    }
  }
  if (allDevices.length === 0) {
    log('[REBOOT] Aucun autre device disponible (device courant est le seul).');
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

    // Enregistrer dans dm_group_members les userIds invités qui ne sont pas le créateur.
    // sendWelcome met à jour dm_device_group_memberships (device-level) mais pas
    // dm_group_members (user-level). Sans ça, getUserGroups ne retourne pas le
    // successeur pour les autres membres, qui ne sauront donc jamais le rejoindre.
    const addedUserIds = new Set<string>();
    for (const deviceId of bulk.addedDeviceIds) {
      const uid = deviceToUser.get(deviceId);
      if (uid && uid !== userId) addedUserIds.add(uid);
    }
    for (const uid of addedUserIds) {
      await mlsService
        .registerMember(successorId, uid)
        .catch((e) => log(`[REBOOT] registerMember ${uid.slice(0, 8)}…: ${String(e)}`));
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

  // Toujours copier les messages — saveMessages est un upsert (idempotent par id).
  // Un second appel retourne 0 résultats car l'ancienne conversationId n'existe plus.
  // Le guard !existingTarget précédent causait la perte des messages sur les devices
  // population 2 (Welcome reçu → S dans conversations, mais messages de G non migrés).
  if (storage) {
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

  // Fusionner les messages en mémoire : anciens (fromGroup) en premier, puis les éventuels
  // nouveaux arrivés dans toGroup depuis le Welcome, dédupliqués par id.
  // Sans cette fusion, si upsertConversation a déjà créé toGroup vide avant que
  // migrateConversation s'exécute (timing handleWelcome → checkGroupSuccessors),
  // le spread de existingTarget garde messages=[] et les anciens ne sont pas visibles
  // jusqu'au prochain rechargement (ils sont bien en IndexedDB, mais pas en mémoire).
  const seen = new Set<string>();
  const mergedMessages = [...(oldConvo.messages ?? []), ...(existingTarget?.messages ?? [])].filter(
    (m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    }
  );

  const merged: Conversation = existingTarget
    ? {
        ...existingTarget,
        name: oldConvo.name,
        isReady: targetAlreadyReady,
        messages: mergedMessages,
      }
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

    // Clé localStorage pour savoir si ce device doit encore envoyer le bundle complet.
    // Posée dans reboot() avant inviteMembers pour survivre aux crashes.
    const casBundleKey = `cas_winner:${g.groupId}`;

    // Migration si pas encore faite (population 1 CAS winner après crash, ou device
    // qui avait G mais n'a pas encore S dans conversations).
    if (conversations.has(g.groupId) && !conversations.has(successorId)) {
      log(
        `[HEALTH] Successeur détecté ${g.groupId.slice(0, 8)}… → ${successorId.slice(0, 8)}… — migration`
      );
      await migrateConversation(g.groupId, successorId, deps).catch((e) =>
        log(`[HEALTH] Erreur migration : ${String(e)}`)
      );
    } else if (conversations.has(g.groupId)) {
      // Population 2 : G et S sont tous les deux dans conversations (Welcome reçu avant
      // checkGroupSuccessors). migrateConversation copie maintenant les messages
      // dans tous les cas (guard !existingTarget supprimé) puis supprime G.
      log(
        `[HEALTH] Migration messages ${g.groupId.slice(0, 8)}… → ${successorId.slice(0, 8)}… (les deux présents)`
      );
      await migrateConversation(g.groupId, successorId, deps).catch((e) =>
        log(`[HEALTH] Erreur migration : ${String(e)}`)
      );
      try {
        await saveMlsState(userId, await mlsService.saveState(pin));
      } catch {
        /* non-bloquant */
      }
    }

    // Résilience : bundle complet non encore envoyé (crash entre migrateConversation
    // et sendFullHistoryBundle dans reboot, ou checkGroupSuccessors relance la migration).
    const localGroups = mlsService.getLocalGroups();
    if (
      localStorage.getItem(casBundleKey) === successorId &&
      localGroups.includes(successorId) &&
      mlsService.getEpoch(successorId) > 0
    ) {
      log(`[HEALTH] Retry bundle historique complet → ${successorId.slice(0, 8)}…`);
      await sendFullHistoryBundle(successorId, {
        storage: deps.storage,
        pin,
        mlsService,
        log,
      }).catch((e) => log(`[HEALTH] Erreur retry bundle : ${String(e)}`));
      localStorage.removeItem(casBundleKey);
    }

    // Crash recovery : ce device a gagné le CAS mais n'a pas invité les membres (epoch=0)
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
      // Envoyer le bundle après l'invitation (epoch est maintenant > 0 après addMembers)
      await sendFullHistoryBundle(successorId, {
        storage: deps.storage,
        pin,
        mlsService,
        log,
      }).catch((e) => log(`[HEALTH] Erreur bundle post-crash-invite : ${String(e)}`));
      localStorage.removeItem(casBundleKey);
    }
  }
}
