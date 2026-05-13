import type { IMlsService } from './IMlsService';
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
  const {
    mlsService,
    userId: _userId,
    pin,
    scheduleReconnect,
    setIsWsConnected,
    setReconnectAttempts,
    processDeviceInvitationsLocally,
    log,
  } = deps;

  if (!getIsTabLeader()) {
    log('[TAB] Onglet follower — skip initializeConnection.');
    return;
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
  } catch (_wsErr: unknown) {
    const msg = _wsErr instanceof Error ? _wsErr.message : String(_wsErr);
    log(`Gateway inaccessible: ${msg}`);
    console.error('[WS] Gateway connection failed:', msg);
  }

  try {
    await mlsService.generateKeyPackage(pin);
    log('KeyPackage publié.');
  } catch {
    /* silent */
  }

  try {
    const memberships = await mlsService.getDeviceMemberships(_userId, mlsService.getDeviceId());
    const localGroups = new Set(mlsService.getLocalGroups());
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
          .updateInvitationStatus(mlsService.getDeviceId(), _userId, m.groupId, 'stale')
          .catch(() => {});
        await mlsService.sendReinviteRequest(m.groupId);
        log(`[SYNC] welcome_request envoyé (état local manquant pour ${m.groupId})`);
      }
    }

    const membershipGroupIds = new Set(memberships.map((m) => m.groupId));
    const userGroups = await mlsService
      .getUserGroups(_userId)
      .catch(() => [] as { groupId: string; name: string; isGroup: boolean }[]);
    for (const group of userGroups) {
      if (!membershipGroupIds.has(group.groupId) && !localGroups.has(group.groupId)) {
        mlsService.sendWelcomeRequest(group.groupId).catch(() => {});
        log(`[SYNC] welcome_request envoyé (device inconnu du groupe ${group.groupId})`);
      }
    }
  } catch (e) {
    log(`[SYNC] Échec récupération memberships: ${e}`);
    console.error('[SYNC] Failed to fetch device memberships:', e);
  }

  await new Promise((r) => setTimeout(r, 500));

  processDeviceInvitationsLocally().catch(() => {});
}
