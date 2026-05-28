import type { IMlsService, UserGroupRow } from './IMlsService';
import { getIsTabLeader } from './tabLeader';

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
}

export type SyncAfterConnectDeps = Pick<
  ConnectionDeps,
  'mlsService' | 'userId' | 'pin' | 'processDeviceInvitationsLocally' | 'log'
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
    mlsService
      .fetchPendingMessages()
      .catch((e) =>
        log(
          `[WARN] Echec récupération messages initiaux: ${e instanceof Error ? e.message : String(e)}`
        )
      );
    mlsService.onDisconnect(scheduleReconnect);

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
 * After WS is open: publish KeyPackage, reconcile memberships (welcome/reinvite),
 * process device invitations.
 */
export async function syncConnectionAfterWsOpen(deps: SyncAfterConnectDeps): Promise<void> {
  const { mlsService, userId, pin, processDeviceInvitationsLocally, log } = deps;

  if (!getIsTabLeader()) return;

  try {
    await mlsService.generateKeyPackage(pin);
    log('KeyPackage publié.');
  } catch {
    /* silent */
  }

  // Bloc 1 : réconciliation des memberships connus (pending/stale/welcome_received).
  // Si getDeviceMemberships échoue, membershipGroupIds reste vide et le bloc 2 prend le relais.
  let membershipGroupIds = new Set<string>();
  try {
    const memberships = await mlsService.getDeviceMemberships(userId, mlsService.getDeviceId());
    const localGroups = new Set(mlsService.getLocalGroups());
    membershipGroupIds = new Set(memberships.map((m) => m.groupId));
    for (const m of memberships) {
      if (m.status === 'pending') {
        mlsService.sendWelcomeRequest(m.groupId);
        log(`[SYNC] welcome_request envoyé pour groupe ${m.groupId}`);
      } else if (m.status === 'stale') {
        mlsService.forgetGroup(m.groupId);
        await mlsService.sendReinviteRequest(m.groupId);
        log(`[SYNC] reinvite_request envoyé (stale sur groupe ${m.groupId}, état local effacé)`);
      } else if (m.status === 'welcome_received' && !localGroups.has(m.groupId)) {
        await mlsService
          .updateInvitationStatus(mlsService.getDeviceId(), userId, m.groupId, 'stale')
          .catch(() => {});
        await mlsService.sendReinviteRequest(m.groupId);
        log(`[SYNC] welcome_request envoyé (état local manquant pour ${m.groupId})`);
      }
    }
  } catch (e) {
    log(`[SYNC] Échec récupération memberships: ${e}`);
    console.error('[SYNC] Failed to fetch device memberships:', e);
  }

  // Bloc 2 : groupes présents côté serveur mais absents du WASM local.
  // Tourne indépendamment du bloc 1 - une erreur sur getDeviceMemberships ne doit pas
  // empêcher d'envoyer les welcome_request pour les groupes sans entrée de membership.
  try {
    const localGroups = new Set(mlsService.getLocalGroups());
    const userGroups = await mlsService.getUserGroups(userId).catch(() => [] as UserGroupRow[]);
    for (const group of userGroups) {
      const targetGroupId = group.successorId ?? group.groupId;
      if (!membershipGroupIds.has(targetGroupId) && !localGroups.has(targetGroupId)) {
        mlsService.sendWelcomeRequest(targetGroupId).catch(() => {});
        log(
          group.successorId
            ? `[SYNC] welcome_request envoyé pour successeur ${targetGroupId} (remplace ${group.groupId})`
            : `[SYNC] welcome_request envoyé (device inconnu du groupe ${targetGroupId})`
        );
      }
    }
  } catch (e) {
    log(`[SYNC] Échec récupération user groups: ${e}`);
    console.error('[SYNC] Failed to fetch user groups:', e);
  }

  await new Promise((r) => setTimeout(r, 500));

  processDeviceInvitationsLocally().catch(() => {});
}

/**
 * Open the WebSocket connection, publish a fresh MLS KeyPackage, and reconcile membership state.
 *
 * Steps performed on every (re-)connect:
 *  1. Guard: only runs on the tab-leader (multi-tab coordination).
 *  2. Connect to the chat gateway and start listening for pending messages.
 *  3. Generate and publish a new KeyPackage so other devices can invite this one.
 *  4. Iterate server-side memberships: send welcome_request for pending groups,
 *     reinvite_request for stale leaves, and detect groups missing from local MLS state.
 *  5. Process pending device invitations (add new devices to existing groups).
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
