import type { IMlsService, UserGroupRow } from './IMlsService';
import { getIsTabLeader } from './tabLeader';
import { persistMlsStateAfterMutation } from '$lib/utils/chat/groupActions';

/** Dependencies injected into initializeConnection; only the tab-leader tab calls this function. */
export interface ConnectionDeps {
  mlsService: IMlsService;
  userId: string;
  pin: string;
  scheduleReconnect: () => void;
  setIsWsConnected: (value: boolean) => void;
  setReconnectAttempts: (value: number) => void;
  processDeviceInvitationsLocally: () => Promise<void>;
  log: (msg: string) => void;
  /**
   * Appelé pour chaque groupe absent du WASM au moment de la connexion.
   * Doit envoyer un `welcome_request` ET armer un timer de reboot (60s).
   * Si absent, fallback sur `sendWelcomeRequest` seul (pas de timer - moins fiable).
   */
  onGroupMissing?: (groupId: string) => Promise<void>;
  /**
   * Appelé quand le sync détecte qu'un groupe a été supprimé côté serveur
   * (deletedAt posé, pas de successeur). Permet à l'UI de marquer la
   * conversation `deletedRemotely` plutôt que de la retirer silencieusement.
   */
  onGroupDeletedRemotely?: (groupId: string) => void;
}

export type SyncAfterConnectDeps = Pick<
  ConnectionDeps,
  'mlsService' | 'userId' | 'pin' | 'processDeviceInvitationsLocally' | 'log' | 'onGroupMissing'
> & {
  /**
   * Appelé quand le sync détecte qu'un groupe a été supprimé côté serveur
   * (deletedAt posé, pas de successeur) et que la conversation existe encore
   * localement. Le callback doit marquer la conversation deletedRemotely=true
   * pour que l'UI affiche la bannière de suppression distante.
   */
  onGroupDeletedRemotely?: (groupId: string) => void;
};

/**
 * Opens the WebSocket to the chat gateway (leader tab only).
 * Returns true when the socket is up; false when skipped or connect failed.
 */
export async function openGatewayConnection(deps: ConnectionDeps): Promise<boolean> {
  const { mlsService, scheduleReconnect, setIsWsConnected, setReconnectAttempts, log } = deps;

  if (!getIsTabLeader()) {
    log('[TAB] Onglet follower - skip openGatewayConnection.');
    return false;
  }

  log('Connexion Gateway...');
  try {
    const { getToken } = await import('$lib/stores/auth');
    const token = await getToken();
    await mlsService.connect(token);
    setIsWsConnected(true);
    setReconnectAttempts(0);
    log('Connecté au réseau !');
    console.log('[WS] Connected to Chat Gateway');
    // Enregistrer le handler de déconnexion AVANT le fetch des messages en attente
    // pour ne pas rater une fermeture WebSocket pendant la récupération.
    mlsService.onDisconnect(scheduleReconnect);
    try {
      await mlsService.fetchPendingMessages();
    } catch (e) {
      log(
        `[WARN] Echec récupération messages initiaux: ${e instanceof Error ? e.message : String(e)}`
      );
    }

    if (typeof window !== 'undefined') {
      const sendDisconnectOnUnload = () => mlsService.sendDisconnect();
      window.addEventListener('beforeunload', sendDisconnectOnUnload, { once: true });
    }
    return true;
  } catch (wsErr: unknown) {
    const msg = wsErr instanceof Error ? wsErr.message : String(wsErr);
    setIsWsConnected(false);
    log(`Gateway inaccessible: ${msg}`);
    console.error('[WS] Gateway connection failed:', msg);
    // Session expired is a permanent auth failure - re-throw so callers can
    // stop retrying instead of scheduling backoff reconnects.
    if (wsErr instanceof Error && wsErr.name === 'SessionExpiredError') throw wsErr;
    return false;
  }
}

/**
 * Après ouverture WS : publier les KeyPackages et réconcilier les groupes.
 *
 * Passe unique sur getUserGroups (plus de Bloc1/Bloc2 distincts).
 * Pour chaque groupe actif sur le serveur sans état WASM local :
 *   - si `onGroupMissing` est fourni : l'appelle (envoie welcome_request + arme timer reboot 60s).
 *   - sinon : sendWelcomeRequest seul (le watchdog useChatSession prend le relai si disponible).
 *
 * Successeurs : si un groupe a un successeur, l'état WASM de l'ancien est purgé.
 * Groupes supprimés sans successeur : état WASM purgé.
 */
export async function syncConnectionAfterWsOpen(deps: SyncAfterConnectDeps): Promise<void> {
  const { mlsService, userId, pin, processDeviceInvitationsLocally, log } = deps;

  if (!getIsTabLeader()) return;

  // 1. Publier les KeyPackages
  // Les welcome_requests ne doivent être envoyées que si cette étape réussit :
  // un device qui envoie une welcome_request doit avoir ses KP disponibles sur
  // le serveur pour que l'hôte puisse l'inviter dans la foulée.
  let keyPackagePublished = false;
  try {
    await mlsService.generateKeyPackage(pin);
    log('KeyPackage publié.');
    keyPackagePublished = true;
    // Réconciliation proactive (best-effort, arrière-plan) : purge du serveur les
    // one-time prekeys orphelins (clé privée locale perdue), pour qu'aucun pair ne
    // consomme un KeyPackage qu'on ne peut pas honorer (boucle NoMatchingKeyPackage).
    void mlsService
      .reconcilePublishedKeyPackages()
      .catch((e) => log(`[KP] Réconciliation prekeys échouée (non bloquant) : ${e}`));
  } catch (e) {
    log(`[KP] Publication échouée (${e}) - welcome_request reportée à la prochaine connexion`);
  }

  // 2. Groupes du serveur
  let groups: UserGroupRow[] = [];
  // `getUserGroups` jette sur erreur HTTP (502/503/timeout pendant un redeploy CD).
  // On distingue "fetch en échec" de "0 groupe réel" pour ne JAMAIS purger l'état WASM
  // sur la foi d'une liste vide transitoire - sinon tous les groupes seraient oubliés,
  // chaque conversation deviendrait non-prête et le SYNC_WATCHDOG les rebooterait toutes.
  let serverFetchOk = false;
  try {
    groups = await mlsService.getUserGroups(userId);
    serverFetchOk = true;
  } catch (e) {
    log(`[SYNC] Échec récupération user groups: ${e}`);
    console.error('[SYNC] Failed to fetch user groups:', e);
    // Continuer quand même pour traiter les invitations
  }

  const localGroups = new Set(mlsService.getLocalGroups());
  let stateMutated = false;

  // Set de déduplication : un groupe et son successeur ne doivent déclencher
  // qu'un seul welcome_request (fix R3 : plus de Bloc1+Bloc2 en double).
  const seen = new Set<string>();
  // Tous les IDs de groupes connus du serveur (pour nettoyer les orphelins WASM)
  const serverIds = new Set<string>();

  for (const g of groups) {
    // Enregistrer tous les IDs connus (groupe + successeur)
    serverIds.add(g.groupId);
    if (g.successorId) serverIds.add(g.successorId);

    // Le groupe cible est le successeur si existant, sinon le groupe lui-même
    const targetId = g.successorId ?? g.groupId;
    if (seen.has(targetId)) continue;
    seen.add(targetId);

    // Groupe supprimé sans successeur → purger l'état WASM et notifier l'UI
    if (g.deletedAt && !g.successorId) {
      if (localGroups.has(g.groupId)) {
        mlsService.forgetGroup(g.groupId);
        stateMutated = true;
        log(`[SYNC] WASM retiré (groupe supprimé) : ${g.groupId.slice(0, 8)}…`);
      }
      deps.onGroupDeletedRemotely?.(g.groupId);
      continue;
    }

    // Oublier l'ancien groupe seulement si le successeur est DÉJÀ dans le WASM
    // (on a déjà rejoint B lors d'une session précédente).
    // Si B n'est pas encore rejoint, on garde A pour pouvoir déchiffrer ses messages
    // en attente avant de le purger - la purge se fera dans handleWelcome() dès que
    // B sera rejoint dans cette même session.
    if (g.successorId && localGroups.has(g.groupId) && localGroups.has(targetId)) {
      mlsService.forgetGroup(g.groupId);
      stateMutated = true;
      log(`[SYNC] WASM retiré (successeur déjà rejoint) : ${g.groupId.slice(0, 8)}…`);
    }

    // Groupe cible absent du WASM.
    if (!localGroups.has(targetId)) {
      // Ne pas envoyer de welcome_request si les KP ne sont pas publiés :
      // l'hôte ne trouverait pas notre KP et ne pourrait pas nous inviter.
      if (!keyPackagePublished) {
        log(`[SYNC] ${targetId.slice(0, 8)}… absent - welcome_request différée (KP non publié)`);
        continue;
      }
      const targetEntry = groups.find((x) => x.groupId === targetId);
      if (targetEntry?.deletedAt && !targetEntry?.successorId) {
        // Successeur terminal soft-deleted sans successeur.
        // deleteGroup a effacé dm_group_members → le serveur ne peut forwarder personne.
        // On déclenche quand même onGroupMissing(targetId) : requestReAdd arme un timer 60s
        // qui lance reboot(targetId) → findAncestorWithMembers remonte la chaîne jusqu'à
        // g.groupId dont dm_group_members est intact (claimSuccessor ne le purge pas).
        // Le simple watchdog était insuffisant : il aurait lancé reboot(g.groupId)
        // → joinSuccessor(g.groupId, targetId) → welcome_request pour 0 membres → bloqué.
        log(`[SYNC] Groupe terminal ${targetId.slice(0, 8)}… supprimé - recovery via ancêtre`);
        if (deps.onGroupMissing) {
          await deps.onGroupMissing(targetId).catch(() => {});
        }
      } else {
        if (deps.onGroupMissing) {
          await deps.onGroupMissing(targetId).catch(() => {});
          // onGroupMissing (requestReAdd) gère son propre log selon l'issue réelle
        } else {
          await mlsService.sendWelcomeRequest(targetId).catch(() => {});
          log(
            g.successorId
              ? `[SYNC] welcome_request → successeur ${targetId.slice(0, 8)}… (remplace ${g.groupId.slice(0, 8)}…)`
              : `[SYNC] welcome_request → ${targetId.slice(0, 8)}…`
          );
        }
      }
    }
  }

  // 3. Purger les états WASM pour des groupes plus connus du serveur.
  // Utilise le snapshot `localGroups` capturé au début de la fonction (même instant que
  // `serverIds`) : évite de purger des groupes créés par REBOOT pendant les opérations
  // async de l'étape 2, ce qui déclencherait une boucle infinie (migrateConversation
  // pointe vers un groupe absent du WASM).
  //
  // Garde-fou anti-reboot-storm : ne JAMAIS purger si la liste serveur n'est pas fiable.
  //  - `serverFetchOk` faux : getUserGroups a échoué (serveur indisponible pendant un
  //    redeploy) → serverIds est vide, on oublierait tous les groupes.
  //  - liste vide alors qu'on détient des groupes localement : réponse vide quasi
  //    certainement transitoire (un compte avec des arbres MLS actifs a forcément des
  //    lignes dm_group_members côté serveur). Même garde que discoverMissingGroups.
  const serverListReliable = serverFetchOk && (groups.length > 0 || localGroups.size === 0);
  if (serverListReliable) {
    for (const localId of localGroups) {
      if (!serverIds.has(localId)) {
        mlsService.forgetGroup(localId);
        stateMutated = true;
        log(`[SYNC] WASM retiré (absent du serveur) : ${localId.slice(0, 8)}…`);
      }
    }
  } else if (localGroups.size > 0) {
    log(
      `[SYNC] Purge WASM ignorée - liste serveur non fiable (fetchOk=${serverFetchOk}, ${groups.length} groupe(s))`
    );
  }

  if (stateMutated) {
    await persistMlsStateAfterMutation(mlsService, userId, pin, log);
  }

  // Petit délai pour laisser le premier lot de messages arriver
  await new Promise((r) => setTimeout(r, 500));

  // 4. Invitations de nos autres devices (multi-device sync)
  processDeviceInvitationsLocally().catch(() => {});
}

/**
 * Ouvre la connexion WebSocket, publie un KeyPackage frais et réconcilie
 * l'état des groupes avec le serveur.
 *
 * Étapes à chaque (re-)connexion :
 *  1. Guard : uniquement l'onglet leader.
 *  2. Connexion au chat gateway.
 *  3. Publication des KeyPackages.
 *  4. Passe unique sur getUserGroups : welcome_request pour tout groupe
 *     absent du WASM, purge des états périmés.
 *  5. Traitement des invitations de nos propres autres devices.
 */
export async function initializeConnection(deps: ConnectionDeps): Promise<void> {
  if (!getIsTabLeader()) {
    deps.log('[TAB] Onglet follower - skip initializeConnection.');
    return;
  }

  const connected = await openGatewayConnection(deps);
  if (!connected) return;

  await syncConnectionAfterWsOpen(deps);
}
