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
 * Demande à être ré-invité dans `groupId` quand l'état MLS local est absent ou désynchronisé.
 *
 * Flux :
 *  1. Si un timer est déjà actif pour ce groupe → retour immédiat (idempotent).
 *  2. Si le groupe a un successeur : appelle `requestReAdd(successorId)` puis appelle
 *     `migrateConversation(groupId → successorId)` pour supprimer le groupe mort d'IndexedDB.
 *     Si le successeur est déjà dans le WASM → migration directe sans recursion.
 *  3. Si le groupe est supprimé sans successeur → marquer `deletedRemotely`, abort.
 *  4. Envoyer `welcome_request` vers les membres actifs du groupe.
 *  5. Armer un timer `RECOVERY_TIMEOUT_MS` (60 s). À expiration : `reboot(groupId)` si le
 *     groupe n'est toujours pas dans le WASM.
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
      if (deps.conversations.has(groupId)) {
        await migrateConversation(groupId, meta.successorId, deps).catch(() => {});
      }
      return;
    }
    deps.log(
      `[READD] ${groupId.slice(0, 8)}… mort → redirection vers successeur ${meta.successorId.slice(0, 8)}…`
    );
    await requestReAdd(meta.successorId, deps, timers);
    // Migrer le groupe mort vers son successeur maintenant que le successeur est traité,
    // pour éviter que b754f1ea… reste en IndexedDB à l'infini (checkGroupSuccessors ne
    // voit que les groupes retournés par getUserGroups, pas les intermédiaires orphelins).
    if (deps.conversations.has(groupId)) {
      await migrateConversation(groupId, meta.successorId, deps).catch(() => {});
    }
    return;
  }

  // Groupe supprimé sans successeur : personne ne peut répondre à un welcome_request
  // et le CAS refusera tout reboot. Marquer la conversation deletedRemotely pour que
  // l'UI affiche la bannière appropriée, et éviter de boucler indéfiniment.
  if (meta?.deletedAt) {
    const convo = deps.conversations.get(groupId);
    // Si l'utilisateur a déjà supprimé la conversation localement (convo absent ou
    // deletedRemotely=true et !isReady), on abandonne silencieusement : rien à sauvegarder
    // et le log récurrent à chaque reload serait trompeur.
    if (!convo || (convo.deletedRemotely && !convo.isReady)) return;
    deps.log(`[READD] ${groupId.slice(0, 8)}… supprimé sans successeur — abandon`);
    deps.conversations.set(groupId, { ...convo, isReady: false, deletedRemotely: true });
    await deps.saveConversation(groupId).catch(() => {});
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
      await reboot(groupId, deps, timers).catch((e) =>
        deps.log(`[READD] reboot échoué pour ${groupId.slice(0, 8)}…: ${String(e)}`)
      );
    }
  }, RECOVERY_TIMEOUT_MS);
  timers.set(groupId, t);
}

/**
 * Annule le timer de recovery armé par `requestReAdd` pour `groupId`.
 *
 * Appelé dès qu'un Welcome est traité avec succès pour ce groupe, afin d'éviter
 * qu'un `reboot` parasite se déclenche alors que le groupe vient d'être rejoint.
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
 * Résout un fork MLS (OpenMLS book §fork-resolution) pour `groupId`.
 *
 * Flux complet :
 *  1. Guard WASM : si le groupe est déjà local, un Welcome tardif l'a devancé → abort.
 *  2. Si un successeur existe déjà (autre device gagnant du CAS) → `joinSuccessor`.
 *  3. Si le groupe est supprimé sans successeur → marquer `deletedRemotely`, abort.
 *  4. Crée un candidat successeur S (serveur + WASM local).
 *  5. CAS `claimGroupSuccessor(G, S)` — premier arrivé premier servi :
 *     - Gagné : pose la clé localStorage `cas_winner:{G} = S` AVANT les opérations réseau
 *       (crash-safety). Si le device crashe entre l'écriture de la clé et la suppression
 *       finale, `resumePendingCasBundles` détecte la clé au prochain démarrage et
 *       renvoie le bundle. La clé est retirée uniquement après envoi réussi.
 *     - Perdu : supprime le candidat orphelin, rejoint le gagnant via `joinSuccessor`.
 *  6. Invite tous les membres de G dans S (`inviteMembers`).
 *     Cas important : si ce device n'a jamais rejoint G (nouveau device, ex. A2 après reboot
 *     sans historique), son IndexedDB pour G est vide → `sendFullHistoryBundle` enverra un
 *     bundle vide. L'historique sera redistribué quand un membre ayant les données (A1, B)
 *     rejoindra S et exécutera `joinSuccessor`, qui appelle `sendFullHistoryBundle` après
 *     `migrateConversation`.
 *  7. Migre la conversation locale (G → S) et envoie le bundle historique complet.
 */
export async function reboot(
  groupId: string,
  deps: RecoveryDeps,
  timers: Map<string, ReturnType<typeof setTimeout>> = new Map()
): Promise<void> {
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
    return joinSuccessor(groupId, meta.successorId, deps, timers);
  }

  // Groupe supprimé sans successeur : le CAS claimSuccessor échouera systématiquement
  // (condition "deletedAt IS NULL" non satisfaite), créant un candidat orphelin à chaque
  // tentative. Même abandon que requestReAdd — marquer la conversation deletedRemotely.
  if (meta?.deletedAt && !meta.successorId) {
    log(`[REBOOT] ${groupId.slice(0, 8)}… supprimé sans successeur — abandon`);
    const convo = deps.conversations.get(groupId);
    if (convo && (!convo.deletedRemotely || convo.isReady)) {
      deps.conversations.set(groupId, { ...convo, isReady: false, deletedRemotely: true });
      await deps.saveConversation(groupId).catch(() => {});
    }
    return;
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
    if (claim.successorId) return joinSuccessor(groupId, claim.successorId, deps, timers);
    return;
  }

  // Étape 5 : CAS gagné — marquer ce device comme responsable du bundle historique
  // avant toute opération réseau pour survivre aux crashes.
  const casBundleKey = `cas_winner:${groupId}`;
  localStorage.setItem(casBundleKey, candidateId);

  // Vider la queue pending_welcome de l'ancien groupe : les welcome_requests stockées
  // pendant l'indisponibilité des pairs ne doivent plus être re-délivrées maintenant
  // que le successeur est prêt.
  await mlsService
    .clearPendingWelcomeRequests(groupId)
    .catch((e) => log(`[REBOOT] Erreur clear pending welcome_requests : ${String(e)}`));

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
 * Rejoint le successeur déjà revendiqué par un autre device et redistribue l'historique.
 *
 * Flux :
 *  1. Enregistre ce device comme membre du successeur côté serveur.
 *  2. Si le successeur n'est pas encore dans le WASM local (Welcome pas encore reçu),
 *     appelle `requestReAdd(successorId)` : envoie une welcome_request et arme un timer
 *     60s → reboot(successorId). Le timer est inoffensif si le groupe est rejoint avant
 *     expiration (guard `localGroups.includes` dans `reboot`).
 *  3. `migrateConversation` : copie les messages de G vers S dans l'IndexedDB local et
 *     fusionne les conversations en mémoire.
 *  4. `sendFullHistoryBundle` : redistribue l'historique fraîchement migré depuis G aux
 *     membres actifs de S.
 *
 * Étape 4 est indispensable pour couvrir le cas où le créateur du successeur (A2) n'avait
 * pas d'historique au moment du reboot (nouveau device) et a donc envoyé un bundle vide.
 * Maintenant que notre IndexedDB pour S contient les messages de G, on les rend disponibles
 * à A2 et aux autres membres qui n'ont pas encore reçu le bundle complet.
 */
async function joinSuccessor(
  deadGroupId: string,
  successorId: string,
  deps: RecoveryDeps,
  timers: Map<string, ReturnType<typeof setTimeout>>
): Promise<void> {
  const { mlsService, userId, log } = deps;
  log(`[REBOOT] Rejoindre successeur ${successorId.slice(0, 8)}…`);

  await mlsService.registerMember(successorId, userId).catch(() => {});

  if (!mlsService.getLocalGroups().includes(successorId)) {
    await requestReAdd(successorId, deps, timers);
  }

  await migrateConversation(deadGroupId, successorId, deps);

  // Redistribuer l'historique migré aux membres actifs du successeur.
  await sendFullHistoryBundle(successorId, {
    storage: deps.storage,
    pin: deps.pin,
    mlsService: deps.mlsService,
    log: deps.log,
  }).catch((e) => log(`[JOIN_SUCCESSOR] Erreur bundle historique : ${String(e)}`));
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
 * Invite tous les membres du groupe source dans le successeur candidat.
 *
 * Récupère les devices de chaque userId membre, les ajoute en bulk à `successorId`
 * (WASM + server), puis envoie commit → Welcomes → enregistre les nouveaux membres.
 *
 * Cas limite : si ce device est le créateur du successeur mais n'avait jamais rejoint
 * le groupe source (ex. A2 nouveau device, G vide dans son IndexedDB), `sendFullHistoryBundle`
 * enverra un bundle vide. L'historique sera redistribué plus tard par `joinSuccessor`
 * quand un membre possédant les données rejoindra le successeur.
 *
 * Corrections appliquées :
 *  - R4 : le commit est envoyé via sendCommit (validation epoch)
 *  - R5 : retry du add-lock après 2s si l'acquisition échoue
 *  - Les Welcomes sont envoyés APRÈS le commit (ordre correct)
 *  - R6 : enregistrement des membres non-créateurs dans dm_group_members
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
 * Synchronise les successions de groupes détectées côté serveur.
 *
 * Appelé une fois à la connexion puis toutes les 5 minutes (onglet leader uniquement).
 *
 * Pour chaque groupe serveur ayant un successeur :
 *
 *  A) Migration locale (si G est en conversations mais pas S) :
 *     Copie les messages de G vers S dans l'IndexedDB et met à jour le Map réactif.
 *
 *  B) Crash-safety — bundle non encore envoyé (Gap 2) :
 *     Si `localStorage["cas_winner:{G}"] === S` et que S est dans le WASM local avec
 *     epoch > 0, c'est que ce device a gagné le CAS, a fini d'inviter les membres, mais
 *     a crashé avant d'envoyer le bundle historique. Le bundle est renvoyé ici, puis la
 *     clé est supprimée.
 *     La clé `cas_winner:{G}` est posée par `reboot()` AVANT les opérations réseau et
 *     supprimée uniquement après succès — elle survit aux crashes et redémarrages.
 *
 *  C) Crash-safety — invitation incomplète (epoch = 0) :
 *     Si S est dans le WASM mais à epoch 0, le device a créé S mais crashé avant
 *     `inviteMembers`. L'invitation et le bundle sont relancés ici.
 *
 * Note : le scénario "device sans historique initie un reboot, envoie un bundle vide"
 * (ex. A2 nouveau device) est couvert par `joinSuccessor` — quand un membre disposant
 * des données (A1) rejoint S plus tard, il redistribue `sendFullHistoryBundle` après
 * `migrateConversation`.
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
