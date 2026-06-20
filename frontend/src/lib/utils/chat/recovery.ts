import type { IMlsService, UserGroupRow } from '$lib/mls-client/IMlsService';
import type { IStorage } from '$lib/db';
import type { Conversation, ConversationLifecycle } from '$lib/types';
import { persistMlsStateAfterMutation } from '$lib/utils/chat/groupActions';
import type { SvelteMap } from 'svelte/reactivity';
import {
  sendFullHistoryBundle,
  warnSkippedKeyPackages,
  purgeLocalConversationRecord,
} from './groupActions';
import { classifyServerStatus } from './groupLifecycle';
import { resolveTerminalGroup } from './groupSyncEligibility';
import { reassignOutboxConversation } from './outbox';
import { markGroupNotReady, clearGroupNotReady, groupNotReadyForMs } from './rebootDeadline';

/**
 * Cadence de (ré)émission des welcome_request pour un groupe non-prêt. À chaque expiration, si
 * le groupe n'est toujours pas dans le WASM ET que l'échéance persistante de reboot n'est pas
 * atteinte, on renvoie simplement une welcome_request (le SYNC_WATCHDOG ré-arme aussi ce cycle).
 * 60s laisse le temps au FCM iOS (background) de réveiller le pair et de recevoir le Welcome.
 */
export const RECOVERY_TIMEOUT_MS = 60_000;

/**
 * Échéance wall-clock PERSISTANTE avant de recréer un groupe (reboot), dernier recours. Mesurée
 * depuis le 1er instant où le groupe a été vu non-prêt (localStorage, survit reload/kill) : le
 * compteur ne repart pas à chaque reconnexion. Tant qu'elle n'est pas atteinte, on se contente
 * de (ré)émettre des welcome_request - la coopération cross-device récupère le groupe bien avant
 * dans le cas courant. Voir {@link groupNotReadyForMs}.
 */
export const REBOOT_DEADLINE_MS = 60 * 60_000;

/**
 * Groupes dont un reboot est en cours. Source de vérité unique partagée par tous les
 * déclencheurs (timer requestReAdd, SYNC_WATCHDOG, checkGroupSuccessors) pour garantir
 * qu'un seul pipeline de reboot tourne par groupe à un instant donné.
 */
const rebootsInFlight = new Set<string>();

/**
 * Dépendances minimales requises par les fonctions de recovery.
 * Sous-ensemble de MessageHandlerDeps - les deux sont compatibles.
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
 * Retire le résidu local d'un groupe CONFIRMÉ ABSENT du serveur : oublie l'état MLS WASM résiduel
 * (s'il existe) et supprime la conversation locale. EXCEPTION (règles 2 & 4) : une conversation
 * marquée `deletedRemotely` (supprimée par un pair / exclusion) reste jusqu'à SUPPRESSION MANUELLE
 * locale, même si le serveur a hard-purgé sa ligne depuis - on n'y touche pas.
 *
 * @returns `true` si l'état MLS WASM a été muté (l'appelant doit alors persister).
 */
async function purgePhantomConversation(groupId: string, deps: RecoveryDeps): Promise<boolean> {
  const entry = [...deps.conversations.entries()].find(([, c]) => c.id === groupId);
  if (entry?.[1].lifecycle === 'removed') return false; // conservé jusqu'à suppression manuelle
  const mutated = deps.mlsService.getLocalGroups().includes(groupId);
  if (mutated) deps.mlsService.forgetGroup(groupId);
  if (entry) {
    await purgeLocalConversationRecord({
      conversations: deps.conversations,
      contactKey: entry[0],
      groupId,
      deleteConversation: deps.deleteConversation,
      log: deps.log,
    });
  }
  return mutated;
}

/**
 * Demande à être ré-invité dans `groupId` quand l'état MLS local est absent ou désynchronisé.
 *
 * Flux :
 *  1. Conversation déjà marquée morte → retour immédiat (idempotent, sans appel réseau).
 *  2. Si un timer est déjà actif pour ce groupe → retour immédiat (idempotent).
 *  3. Si le groupe a un successeur : appelle `requestReAdd(successorId)` puis appelle
 *     `migrateConversation(groupId → successorId)` pour supprimer le groupe mort d'IndexedDB.
 *     Si le successeur est déjà dans le WASM → migration directe sans recursion.
 *  4. Terminal d'une chaîne de successeurs sans métadonnée serveur (groupe successeur
 *     inexistant/injoignable) → abort sans welcome_request ni reboot.
 *  5. Si le groupe est supprimé sans successeur → marquer `deletedRemotely`, abort.
 *  6. Envoyer `welcome_request` vers les membres actifs du groupe et poser l'échéance
 *     persistante de reboot (`markGroupNotReady`).
 *  7. Armer un timer `RECOVERY_TIMEOUT_MS` (60 s). À expiration, si le groupe n'est toujours pas
 *     dans le WASM : `reboot(groupId)` seulement si l'échéance wall-clock persistante
 *     `REBOOT_DEADLINE_MS` (1 h) est atteinte ; sinon, simple ré-émission de `welcome_request`.
 */
export async function requestReAdd(
  groupId: string,
  deps: RecoveryDeps,
  timers: Map<string, ReturnType<typeof setTimeout>>
): Promise<void> {
  // Idempotence : une conversation déjà marquée morte ne relance pas de recovery réseau
  // (évite de re-spammer welcome_request/getGroupMeta sur chaque message bufferisé d'un
  // groupe mort lors d'un même drain).
  const known = deps.conversations.get(groupId);
  if (known?.lifecycle === 'removed') return;

  const {
    terminalId,
    groupMeta: terminalMeta,
    hasChain,
  } = await resolveTerminalGroup(deps.mlsService, groupId);

  // Groupe sans métadonnée serveur. `terminalMeta=null` est ambigu (getGroupMeta renvoie `null`
  // aussi bien pour un groupe absent que pour un échec réseau), donc on lève l'ambiguïté :
  // `getGroupServerStatus` distingue un ABSENT CONFIRMÉ (aucune ligne dm_groups) d'une vraie
  // erreur réseau.
  if (terminalMeta === null) {
    const status = classifyServerStatus(
      await deps.mlsService.getGroupServerStatus(terminalId).catch(() => 'error' as const)
    );

    if (status.kind === 'absent') {
      // Le groupe n'existe plus DU TOUT côté serveur (ni actif, ni tombstone : un tombstone
      // aurait un `deletedAt`, donc une métadonnée non-nulle). C'est un fantôme purement local
      // sans aucune existence serveur. La source de vérité est le serveur -> on coupe la boucle
      // readd/reboot et on purge le résidu local au lieu de ré-émettre des welcome_request à
      // l'infini pour un groupe inexistant et invisible dans l'UI.
      deps.log(
        `[READD] ${terminalId.slice(0, 8)}… absent du serveur (confirmé) - fantôme purgé, recovery stoppée`
      );
      cancelReAdd(terminalId, timers);
      cancelReAdd(groupId, timers);
      clearGroupNotReady(deps.userId, terminalId);
      clearGroupNotReady(deps.userId, groupId);
      let purged = await purgePhantomConversation(terminalId, deps);
      if (terminalId !== groupId)
        purged = (await purgePhantomConversation(groupId, deps)) || purged;
      if (purged)
        await persistMlsStateAfterMutation(deps.mlsService, deps.userId, deps.pin, deps.log);
      return;
    }

    // Statut non confirmé absent ('unknown' réseau, ou le groupe existe encore) : ambiguïté non
    // levée. Un terminal de chaîne de successeurs sans métadonnée serait re-fabriqué par un reboot
    // pour un groupe injoignable -> on abandonne sans rien marquer (une prochaine synchro réseau
    // fonctionnelle re-résoudra la chaîne).
    if (hasChain) {
      deps.log(
        `[READD] terminal ${terminalId.slice(0, 8)}… sans métadonnée serveur (réseau) - chaîne morte, recovery ignorée`
      );
      return;
    }
  }

  // Un seul timer armé par groupe terminal, mais on renvoie toujours la welcome_request
  // si le timer tourne déjà : le peer peut être revenu en ligne depuis la dernière fois,
  // et la requête stockée côté serveur peut avoir expiré (TTL 24 h Redis).
  if (timers.has(terminalId)) {
    await deps.mlsService.sendWelcomeRequest(terminalId).catch(() => {});
    return;
  }

  const localGroups = deps.mlsService.getLocalGroups();

  if (localGroups.includes(terminalId)) {
    clearGroupNotReady(deps.userId, terminalId);
    if (hasChain && groupId !== terminalId && deps.conversations.has(groupId)) {
      deps.log(
        `[READD] ${groupId.slice(0, 8)}… → terminal ${terminalId.slice(0, 8)}… déjà en WASM - migration`
      );
      await migrateConversation(groupId, terminalId, deps).catch(() => {});
    } else {
      deps.log(
        `[READD] ${terminalId.slice(0, 8)}… déjà en WASM - skip (appeler forgetGroup avant recovery si hors-sync)`
      );
    }
    return;
  }

  if (hasChain && groupId !== terminalId) {
    deps.log(`[READD] ${groupId.slice(0, 8)}… → terminal ${terminalId.slice(0, 8)}…`);
    if (deps.conversations.has(groupId)) {
      await migrateConversation(groupId, terminalId, deps).catch(() => {});
    }
  }

  // Lignée supprimée sans successeur utilisable : abandon (pas de reboot possible).
  if (terminalMeta?.deletedAt) {
    clearGroupNotReady(deps.userId, terminalId);
    const convo = deps.conversations.get(terminalId) ?? deps.conversations.get(groupId);
    if (!convo || convo.lifecycle === 'removed') return;
    deps.log(`[READD] ${terminalId.slice(0, 8)}… supprimé sans successeur - abandon`);
    deps.conversations.set(terminalId, {
      ...convo,
      id: terminalId,
      lifecycle: 'removed',
    });
    await deps.saveConversation(terminalId).catch(() => {});
    return;
  }

  // Démarre (ou conserve) l'échéance wall-clock persistante de reboot pour ce groupe.
  markGroupNotReady(deps.userId, terminalId);

  await deps.mlsService
    .sendWelcomeRequest(terminalId)
    .catch((e) =>
      deps.log(`[READD] welcome_request échoué pour ${terminalId.slice(0, 8)}…: ${String(e)}`)
    );
  deps.log(
    `[READD] welcome_request envoyé pour ${terminalId.slice(0, 8)}… (cadence ${RECOVERY_TIMEOUT_MS / 1000}s, reboot après ${REBOOT_DEADLINE_MS / 60_000}min)`
  );

  const t = setTimeout(async () => {
    timers.delete(terminalId);
    if (deps.mlsService.getLocalGroups().includes(terminalId)) {
      clearGroupNotReady(deps.userId, terminalId);
      return;
    }
    // Reboot = dernier recours : uniquement après REBOOT_DEADLINE_MS en temps réel PERSISTANT
    // (survit reload/reconnexion). Avant l'échéance, on renvoie juste une welcome_request ; le
    // SYNC_WATCHDOG ré-arme ce cycle toutes les RECOVERY_TIMEOUT_MS sans jamais relancer le compteur.
    const notReadyMs = groupNotReadyForMs(deps.userId, terminalId);
    if (notReadyMs !== null && notReadyMs >= REBOOT_DEADLINE_MS) {
      deps.log(
        `[READD] ${terminalId.slice(0, 8)}… non-prêt depuis ${Math.round(notReadyMs / 60_000)}min (≥${REBOOT_DEADLINE_MS / 60_000}min) - reboot`
      );
      await reboot(terminalId, deps, timers).catch((e) =>
        deps.log(`[READD] reboot échoué pour ${terminalId.slice(0, 8)}…: ${String(e)}`)
      );
    } else {
      deps.log(
        `[READD] ${terminalId.slice(0, 8)}… toujours non-prêt - welcome_request renvoyée, reboot différé`
      );
      await deps.mlsService.sendWelcomeRequest(terminalId).catch(() => {});
    }
  }, RECOVERY_TIMEOUT_MS);
  timers.set(terminalId, t);
}

/**
 * Recovery d'un groupe dont l'état MLS local est forké EN RETARD sur le serveur
 * (epoch local < `activeEpoch` serveur), détecté via le rejet `epoch_mismatch` d'un commit.
 *
 * Contrairement à `requestReAdd` seul - qui skippe les groupes encore présents dans le WASM
 * (cf. garde `localGroups.includes`) -, on `forgetGroup` D'ABORD : le groupe forké quitte le
 * WASM local, puis la welcome_request émise est honorée par un pair à jour qui nous ré-ajoute
 * à l'epoch courante (le re-Welcome n'est alors plus ignoré comme idempotent). L'historique
 * est rebackfillé par le bundle. Sans ce forget, l'appareil resterait bloqué à committer des
 * epochs périmés que le serveur rejette en boucle (storm kick/re-add observé en prod).
 *
 * Pendant analogue, côté ÉCRITURE (commit rejeté), de l'escalade epoch-gap côté LECTURE
 * (message indéchiffrable) dans `setupMessageHandler`.
 */
export async function recoverForkedGroup(
  groupId: string,
  deps: RecoveryDeps,
  timers: Map<string, ReturnType<typeof setTimeout>>,
  minEpoch = 0
): Promise<void> {
  deps.log(`[FORK] ${groupId.slice(0, 8)}… état local forké en retard - forget + welcome_request`);
  // minEpoch = epoch serveur connue : rejette un re-Welcome stale d'une branche divergée
  // (un commit resté en file à l'ancienne epoch ne doit pas nous re-forker).
  deps.mlsService.forgetGroup(groupId, minEpoch);
  await requestReAdd(groupId, deps, timers);
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
 *  5. CAS `claimGroupSuccessor(G, S)` - premier arrivé premier servi :
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
  const { mlsService, log } = deps;

  // Guard : si le groupe est déjà dans le WASM local, la recovery est inutile.
  // Protège contre les races entre un Welcome tardif et les timers de reboot (requestReAdd,
  // watchdog) : sans ce guard, le reboot créerait un successeur pour un groupe fonctionnel.
  if (mlsService.getLocalGroups().includes(groupId)) {
    log(`[REBOOT] ${groupId.slice(0, 8)}… déjà dans WASM - annulé`);
    return;
  }

  // Exclusion mutuelle INTRA-device par groupe : deux déclencheurs concurrents (timer
  // requestReAdd qui expire pendant que le SYNC_WATCHDOG décompte) créaient chacun un candidat
  // successeur. Le CAS en élimine un, mais le perdant a déjà pollué le serveur et lancé un
  // joinSuccessor pour rien. Le verrou garantit un seul pipeline par groupe sur cet appareil.
  if (rebootsInFlight.has(groupId)) {
    log(`[REBOOT] ${groupId.slice(0, 8)}… déjà en cours - ignoré`);
    return;
  }
  rebootsInFlight.add(groupId);
  try {
    // Exclusion mutuelle CROSS-device : sans ce verrou Redis, deux appareils détectant le même
    // groupe desynchronise creent chacun un candidat avant que le CAS ne tranche (pollution
    // serveur de groupes orphelins). Le perdant s'abstient : le successeur du gagnant sera
    // rejoint via les retries (SYNC_WATCHDOG → requestReAdd, checkGroupSuccessors, ou le Welcome
    // recu lors de l'inviteMembers du gagnant). Le CAS reste le garde-fou de correction si le
    // verrou expire en cours de reboot.
    const locked = await mlsService.acquireRebootLock(groupId).catch(() => false);
    if (!locked) {
      log(`[REBOOT] ${groupId.slice(0, 8)}… verrou cross-device détenu ailleurs - abstention`);
      return;
    }
    try {
      await performReboot(groupId, deps, timers);
    } finally {
      await mlsService.releaseRebootLock(groupId).catch(() => {});
    }
  } finally {
    rebootsInFlight.delete(groupId);
  }
}

/**
 * Corps de la résolution de fork. Toujours invoqué via {@link reboot}, qui garantit
 * l'exclusion mutuelle par groupe et le guard "déjà présent dans le WASM".
 */
async function performReboot(
  groupId: string,
  deps: RecoveryDeps,
  timers: Map<string, ReturnType<typeof setTimeout>>
): Promise<void> {
  const { mlsService, userId, pin, log } = deps;

  log(`[REBOOT] Lancement pour groupe ${groupId.slice(0, 8)}…`);

  // Étape 1 : statut serveur du groupe (successeur déjà revendiqué ? supprimé ?).
  // On distingue l'absence CONFIRMEE de l'incertitude réseau : un `getGroupMeta` renvoyant
  // `null` sur un simple blip réseau (indiscernable d'un 404) ferait rater le `successorId`
  // existant et pousserait à créer un successeur DUPLIQUE (pollution serveur + fork). Sur un
  // doute réseau (`unknown`), on reporte le reboot - le prochain tick retentera.
  const status = classifyServerStatus(await mlsService.getGroupServerStatus(groupId));
  if (status.kind === 'unknown') {
    log(`[REBOOT] ${groupId.slice(0, 8)}… statut serveur incertain (réseau) - report`);
    return;
  }
  const meta = status.kind === 'absent' ? null : status.meta;
  if (meta?.successorId) {
    return joinSuccessor(groupId, meta.successorId, deps, timers);
  }

  // Groupe supprimé sans successeur : le CAS claimSuccessor échouera systématiquement
  // (condition "deletedAt IS NULL" non satisfaite), créant un candidat orphelin à chaque
  // tentative. Même abandon que requestReAdd - marquer la conversation removed.
  if (meta?.deletedAt && !meta.successorId) {
    log(`[REBOOT] ${groupId.slice(0, 8)}… supprimé sans successeur - abandon`);
    const convo = deps.conversations.get(groupId);
    if (convo && convo.lifecycle !== 'removed') {
      deps.conversations.set(groupId, { ...convo, lifecycle: 'removed' });
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
    await persistMlsStateAfterMutation(mlsService, userId, pin, log);
  } catch (e) {
    log(`[REBOOT] Échec création candidat : ${String(e)}`);
    if (candidateId) {
      await mlsService.deleteGroupOnServer(candidateId).catch(() => {});
      mlsService.forgetGroup(candidateId);
    }
    throw e;
  }

  // Second look anti-faux-positif : la création du candidat (étape 3) a enchaîné plusieurs
  // aller-retours réseau ; un Welcome tardif a pu rejoindre le groupe original entre-temps.
  // Le CAS qui suit soft-delete l'original de façon IRRÉVERSIBLE - on s'abstient et on jette
  // le candidat orphelin si le groupe est redevenu sain dans le WASM local.
  if (mlsService.getLocalGroups().includes(groupId)) {
    log(
      `[REBOOT] ${groupId.slice(0, 8)}… revenu dans WASM avant CAS - candidat ${candidateId.slice(0, 8)}… annulé`
    );
    await mlsService.deleteGroupOnServer(candidateId).catch(() => {});
    mlsService.forgetGroup(candidateId);
    return;
  }

  // Étape 4 : CAS - premier arrivé premier servi.
  // On transmet le device courant pour pouvoir attribuer le reboot (diagnostic serveur).
  const claim = await mlsService.claimGroupSuccessor(
    groupId,
    candidateId,
    mlsService.getDeviceId()
  );

  if (!claim.claimed) {
    // CAS perdu - nettoyer le candidat orphelin et rejoindre le gagnant
    log(
      `[REBOOT] CAS perdu - suppression ${candidateId.slice(0, 8)}…, migration vers ${claim.successorId?.slice(0, 8)}…`
    );
    await mlsService.deleteGroupOnServer(candidateId).catch(() => {});
    mlsService.forgetGroup(candidateId);
    if (claim.successorId) return joinSuccessor(groupId, claim.successorId, deps, timers);
    return;
  }

  // Étape 5 : CAS gagné - marquer ce device comme responsable du bundle historique
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
  log(`[REBOOT] CAS gagné - invitation membres dans ${candidateId.slice(0, 8)}…`);
  const memberSourceId = await findAncestorWithMembers(groupId, groups, deps);
  await inviteMembers(memberSourceId, candidateId, deps).catch((e) =>
    log(`[REBOOT] Erreur invitation membres : ${String(e)}`)
  );

  // Étape 6 : migrer la conversation locale (copie TOUS les messages de G vers S)
  await migrateConversation(groupId, candidateId, deps);

  // Marquer le successeur comme prêt (ce device est le créateur)
  const newConvo = deps.conversations.get(candidateId);
  if (newConvo && newConvo.lifecycle !== 'active') {
    deps.conversations.set(candidateId, { ...newConvo, lifecycle: 'active' });
    await deps.saveConversation(candidateId).catch(() => {});
  }

  // Étape 7 : envoyer l'historique complet aux membres invités (population 3 - fresh devices)
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
 * le groupe le plus récent possédant encore des entrées dans `dm_group_members`
 * (user-level, stable entre changements de device).
 *
 * La version la plus récente (`groupId`) est vérifiée en premier : c'est la source
 * la plus à jour de la composition du groupe. On ne remonte vers un ancêtre que si
 * `groupId` lui-même a été explicitement supprimé via `deleteGroupOnServer` (qui
 * efface dm_group_members), ce qui est rare et distinct du flux de reboot normal.
 * Retourne `groupId` si aucun ancêtre ne possède de membres non plus.
 */
async function findAncestorWithMembers(
  groupId: string,
  chainGroups: UserGroupRow[],
  deps: RecoveryDeps
): Promise<string> {
  // Priorité au groupe courant : dm_group_members (user-level) est stable et reflète
  // la composition la plus récente, indépendamment des changements de device.
  const userMembers = await deps.mlsService.getGroupUserMembers(groupId).catch(() => []);
  if (userMembers.length > 0) return groupId;

  let current = groupId;
  for (let depth = 0; depth < 10; depth++) {
    const parent = chainGroups.find((g) => g.successorId === current);
    if (!parent) break;
    const parentUserMembers = await deps.mlsService
      .getGroupUserMembers(parent.groupId)
      .catch(() => []);
    if (parentUserMembers.length > 0) {
      deps.log(
        `[REBOOT] dm_group_members absent pour ${groupId.slice(0, 8)}… - fallback ancêtre ${parent.groupId.slice(0, 8)}…`
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
 * Sources pour déterminer qui inviter (par priorité) :
 *  1. `getGroupMembers` (dm_device_group_memberships, active) - source primaire.
 *  2. `getGroupUserMembers` (dm_group_members, user-level) - fallback si la source 1
 *     est vide (cas typique : device créateur supprimé via fresh-start, ce qui efface
 *     ses entrées device-level mais laisse dm_group_members intact).
 *
 * Pour chaque userId trouvé, récupère les devices courants via `fetchUserDevices`,
 * les ajoute en bulk à `successorId` (WASM + serveur), puis envoie commit → Welcomes
 * → enregistre les membres non-créateurs dans dm_group_members (sans ça,
 * getUserGroups ne retourne pas le successeur pour eux).
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
  let allUserIds = [...new Set(members.map((m) => m.userId))];
  if (allUserIds.length === 0) {
    // dm_device_group_memberships vide (ex: device créateur supprimé via fresh-start).
    // Fallback sur dm_group_members (user-level, stable) : source de vérité pour l'appartenance.
    const userMembers = await mlsService.getGroupUserMembers(deadGroupId).catch(() => []);
    allUserIds = [...new Set(userMembers.map((m) => m.userId))];
    if (allUserIds.length > 0) {
      log(
        `[REBOOT] Fallback dm_group_members: ${allUserIds.map((u) => u.slice(0, 8)).join(', ')}…`
      );
    }
  }
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

  // Acquérir le add-lock - retry une fois après 2s (fix R5)
  let locked = await mlsService.acquireAddLock(successorId).catch(() => false);
  if (!locked) {
    await new Promise((r) => setTimeout(r, 2_000));
    locked = await mlsService.acquireAddLock(successorId).catch(() => false);
    if (!locked) {
      log('[REBOOT] Add-lock non disponible - abandon (un autre device le traite).');
      return;
    }
  }

  try {
    const bulk = await mlsService.addMembersBulk(successorId, allDevices);
    log(`[REBOOT] ${bulk.addedDeviceIds.length} device(s) ajouté(s)`);
    warnSkippedKeyPackages(bulk.skippedDeviceIds, successorId, '[REBOOT]', log);

    // Persister AVANT d'envoyer (si crash, les membres peuvent rejoindre via welcome_request)
    await persistMlsStateAfterMutation(mlsService, userId, pin, log);

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
 * - Copie les messages locaux (avec déduplication - fix C8)
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
    log(`[MIGRATE] Conversation source ${fromGroupId.slice(0, 8)}… introuvable - skip`);
    return;
  }
  log(`[MIGRATE] ${fromGroupId.slice(0, 8)}… → ${toGroupId.slice(0, 8)}… ("${oldConvo.name}")`);

  const existingTarget = conversations.get(toGroupId);
  const localGroups = deps.mlsService.getLocalGroups();
  const targetAlreadyReady =
    existingTarget?.lifecycle === 'active' || localGroups.includes(toGroupId);
  const targetLifecycle: ConversationLifecycle = targetAlreadyReady ? 'active' : 'pending';

  // Toujours copier les messages - saveMessages est un upsert (idempotent par id).
  // Un second appel retourne 0 résultats car l'ancienne conversationId n'existe plus.
  // Le guard !existingTarget précédent causait la perte des messages sur les devices
  // population 2 (Welcome reçu → S dans conversations, mais messages de G non migrés).
  //
  // messagesCopied = true si la copie a réussi (ou s'il n'y avait rien à copier).
  // Si false, la source est conservée en IndexedDB pour éviter toute perte de messages.
  let messagesCopied = false;
  if (storage) {
    try {
      const msgs = await storage.getMessages(fromGroupId, pin);
      if (msgs.length > 0) {
        const rekeyed = msgs.map((m) => ({ ...m, conversationId: toGroupId }));
        await storage.saveMessages(rekeyed, pin);
        log(`[MIGRATE] ${msgs.length} message(s) copié(s)`);
      }
      messagesCopied = true;
    } catch (e) {
      log(`[MIGRATE] Erreur copie messages : ${String(e)} - source conservée en DB`);
    }
  } else {
    messagesCopied = true; // pas de storage : rien à protéger
  }

  // Outbox : re-clé les messages en attente fromGroup → toGroup pour qu'ils partent dans le
  // successeur (resolve-at-flush le couvre déjà, ce re-key garde l'état persistant cohérent et
  // relance un flush vers le nouveau groupe).
  await reassignOutboxConversation(fromGroupId, toGroupId).catch(() => {});

  // Persister la nouvelle conversation avant de supprimer l'ancienne
  if (storage) {
    await storage
      .saveConversation({
        id: toGroupId,
        name: oldConvo.name,
        lifecycle: targetLifecycle,
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
        lifecycle: targetLifecycle,
        messages: mergedMessages,
      }
    : { ...oldConvo, id: toGroupId, lifecycle: targetLifecycle };
  conversations.set(toGroupId, merged);

  if (getSelectedContact() === fromGroupId) setSelectedContact(toGroupId);

  // Ne supprimer la source de l'IndexedDB que si les messages ont été copiés avec succès.
  // Si la copie a échoué, la source reste en DB et checkGroupSuccessors retente la migration.
  conversations.delete(fromGroupId);
  if (messagesCopied) {
    if (deleteConversation) await deleteConversation(fromGroupId).catch(() => {});
  } else {
    log(`[MIGRATE] Source ${fromGroupId.slice(0, 8)}… conservée en DB (messages non migrés)`);
  }

  try {
    deps.mlsService.forgetGroup(fromGroupId);
  } catch {
    /* non-bloquant */
  }

  await saveConversation(toGroupId);
  log(`[MIGRATE] Terminé - "${oldConvo.name}" vit maintenant dans ${toGroupId.slice(0, 8)}…`);
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
 *  B) Crash-safety - bundle non encore envoyé (Gap 2) :
 *     Si `localStorage["cas_winner:{G}"] === S` et que S est dans le WASM local avec
 *     epoch > 0, c'est que ce device a gagné le CAS, a fini d'inviter les membres, mais
 *     a crashé avant d'envoyer le bundle historique. Le bundle est renvoyé ici, puis la
 *     clé est supprimée.
 *     La clé `cas_winner:{G}` est posée par `reboot()` AVANT les opérations réseau et
 *     supprimée uniquement après succès - elle survit aux crashes et redémarrages.
 *
 *  C) Crash-safety - invitation incomplète (epoch = 0) :
 *     Si S est dans le WASM mais à epoch 0, le device a créé S mais crashé avant
 *     `inviteMembers`. L'invitation et le bundle sont relancés ici.
 *
 * Note : le scénario "device sans historique initie un reboot, envoie un bundle vide"
 * (ex. A2 nouveau device) est couvert par `joinSuccessor` - quand un membre disposant
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
        `[HEALTH] Successeur détecté ${g.groupId.slice(0, 8)}… → ${successorId.slice(0, 8)}… - migration`
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
        await persistMlsStateAfterMutation(mlsService, userId, pin, log);
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
      log(`[HEALTH] Successeur ${successorId.slice(0, 8)}… epoch=0 - ré-invitation post-crash`);
      await inviteMembers(g.groupId, successorId, deps).catch((e) =>
        log(`[HEALTH] Erreur ré-invitation : ${String(e)}`)
      );
      const convo = conversations.get(successorId);
      if (convo && convo.lifecycle !== 'active') {
        conversations.set(successorId, { ...convo, lifecycle: 'active' });
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
