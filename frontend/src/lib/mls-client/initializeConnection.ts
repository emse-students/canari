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
   * Doit envoyer un `welcome_request` ET armer un timer de reboot (30s).
   * Si absent, fallback sur `sendWelcomeRequest` seul (pas de timer — moins fiable).
   */
  onGroupMissing?: (groupId: string) => Promise<void>;
}

export type SyncAfterConnectDeps = Pick<
  ConnectionDeps,
  'mlsService' | 'userId' | 'pin' | 'processDeviceInvitationsLocally' | 'log' | 'onGroupMissing'
>;

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
    return false;
  }
}

/**
 * Après ouverture WS : publier les KeyPackages et réconcilier les groupes.
 *
 * Passe unique sur getUserGroups (plus de Bloc1/Bloc2 distincts).
 * Pour chaque groupe actif sur le serveur sans état WASM local :
 *   - si `onGroupMissing` est fourni : l'appelle (envoie welcome_request + arme timer reboot 30s).
 *   - sinon : sendWelcomeRequest seul (le watchdog useChatSession prend le relai si disponible).
 *
 * Successeurs : si un groupe a un successeur, l'état WASM de l'ancien est purgé.
 * Groupes supprimés sans successeur : état WASM purgé.
 */
export async function syncConnectionAfterWsOpen(deps: SyncAfterConnectDeps): Promise<void> {
  const { mlsService, userId, pin, processDeviceInvitationsLocally, log } = deps;

  if (!getIsTabLeader()) return;

  // 1. Publier les KeyPackages
  try {
    await mlsService.generateKeyPackage(pin);
    log('KeyPackage publié.');
  } catch {
    /* non-bloquant — réessayé à la prochaine connexion */
  }

  // 2. Groupes du serveur
  let groups: UserGroupRow[] = [];
  try {
    groups = await mlsService.getUserGroups(userId);
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

    // Groupe supprimé sans successeur → purger l'état WASM
    if (g.deletedAt && !g.successorId) {
      if (localGroups.has(g.groupId)) {
        mlsService.forgetGroup(g.groupId);
        stateMutated = true;
        log(`[SYNC] WASM retiré (groupe supprimé) : ${g.groupId.slice(0, 8)}…`);
      }
      continue;
    }

    // Si le groupe a un successeur, l'état WASM de l'ancien est périmé
    if (g.successorId && localGroups.has(g.groupId) && !localGroups.has(targetId)) {
      mlsService.forgetGroup(g.groupId);
      stateMutated = true;
      log(`[SYNC] WASM retiré (successeur existe) : ${g.groupId.slice(0, 8)}…`);
    }

    // Groupe cible absent du WASM.
    if (!localGroups.has(targetId)) {
      const targetEntry = groups.find((x) => x.groupId === targetId);
      if (targetEntry?.deletedAt && !targetEntry?.successorId) {
        // Successeur terminal soft-deleted sans successeur.
        // deleteGroup a effacé dm_group_members → le serveur ne peut forwarder personne.
        // On déclenche quand même onGroupMissing(targetId) : requestReAdd arme un timer 30s
        // qui lance reboot(targetId) → findAncestorWithMembers remonte la chaîne jusqu'à
        // g.groupId dont dm_group_members est intact (claimSuccessor ne le purge pas).
        // Le simple watchdog était insuffisant : il aurait lancé reboot(g.groupId)
        // → joinSuccessor(g.groupId, targetId) → welcome_request pour 0 membres → bloqué.
        log(`[SYNC] Groupe terminal ${targetId.slice(0, 8)}… supprimé — recovery via ancêtre`);
        if (deps.onGroupMissing) {
          await deps.onGroupMissing(targetId).catch(() => {});
        }
      } else {
        if (deps.onGroupMissing) {
          await deps.onGroupMissing(targetId).catch(() => {});
        } else {
          await mlsService.sendWelcomeRequest(targetId).catch(() => {});
        }
        log(
          g.successorId
            ? `[SYNC] welcome_request → successeur ${targetId.slice(0, 8)}… (remplace ${g.groupId.slice(0, 8)}…)`
            : `[SYNC] welcome_request → ${targetId.slice(0, 8)}…`
        );
      }
    }
  }

  // 3. Purger les états WASM pour des groupes plus connus du serveur
  for (const localId of mlsService.getLocalGroups()) {
    if (!serverIds.has(localId)) {
      mlsService.forgetGroup(localId);
      stateMutated = true;
      log(`[SYNC] WASM retiré (absent du serveur) : ${localId.slice(0, 8)}…`);
    }
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
