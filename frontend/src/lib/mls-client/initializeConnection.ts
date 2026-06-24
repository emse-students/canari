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
   * Called for each group absent from WASM at connection time.
   * Must send a `welcome_request` AND arm a reboot timer (60 s).
   * When omitted, falls back to `sendWelcomeRequest` alone (no timer - less reliable).
   */
  onGroupMissing?: (groupId: string) => Promise<void>;
  /**
   * Called when sync detects that a group was deleted server-side
   * (deletedAt set, no successor). Lets the UI mark the conversation
   * `deletedRemotely` instead of removing it silently.
   */
  onGroupDeletedRemotely?: (groupId: string) => void;
}

export type SyncAfterConnectDeps = Pick<
  ConnectionDeps,
  'mlsService' | 'userId' | 'pin' | 'processDeviceInvitationsLocally' | 'log' | 'onGroupMissing'
> & {
  /**
   * Called when sync detects that a group was deleted server-side
   * (deletedAt set, no successor) and the conversation still exists locally.
   * The callback must set deletedRemotely=true on the conversation so
   * the UI shows the remote-deletion banner.
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
    log('[TAB] Follower tab - skipping openGatewayConnection.');
    return false;
  }

  log('Connecting to Gateway…');
  try {
    const { getToken } = await import('$lib/stores/auth');
    const token = await getToken();
    await mlsService.connect(token);
    setIsWsConnected(true);
    setReconnectAttempts(0);
    log('Connected to network!');
    console.log('[WS] Connected to Chat Gateway');
    // Register the disconnect handler BEFORE fetching pending messages
    // to avoid missing a WebSocket close that happens during the fetch.
    mlsService.onDisconnect(scheduleReconnect);
    try {
      await mlsService.fetchPendingMessages();
    } catch (e) {
      log(
        `[WARN] Failed to fetch initial pending messages: ${e instanceof Error ? e.message : String(e)}`
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
 * Post-WS-open: publish KeyPackages and reconcile group state with the server.
 *
 * Single pass over getUserGroups (no separate Bloc1/Bloc2).
 * For each group active on the server with no local WASM state:
 *   - if `onGroupMissing` is provided: calls it (sends welcome_request + arms 60 s reboot timer).
 *   - otherwise: sendWelcomeRequest alone (useChatSession watchdog takes over when available).
 *
 * Successors: when a group has a successor, the old group's WASM state is purged.
 * Deleted groups without a successor: WASM state purged.
 */
export async function syncConnectionAfterWsOpen(deps: SyncAfterConnectDeps): Promise<void> {
  const { mlsService, userId, pin, processDeviceInvitationsLocally, log } = deps;

  if (!getIsTabLeader()) return;

  // 1. Publier les KeyPackages
  // welcome_requests must only be sent if this step succeeds:
  // a device sending a welcome_request must have its KPs available on
  // the server so the host can invite it immediately after.
  let keyPackagePublished = false;
  try {
    await mlsService.generateKeyPackage(pin);
    log('KeyPackage published.');
    keyPackagePublished = true;
    // Proactive reconciliation (best-effort, background): purge orphaned one-time
    // prekeys from the server (local private key lost) so no peer consumes a
    // KeyPackage we cannot honour (NoMatchingKeyPackage loop).
    void mlsService
      .reconcilePublishedKeyPackages()
      .catch((e) => log(`[KP] Prekey reconciliation failed (non-blocking): ${e}`));
  } catch (e) {
    log(`[KP] Publication failed (${e}) - welcome_request deferred to next connection`);
  }

  // 2. Groupes du serveur
  let groups: UserGroupRow[] = [];
  // `getUserGroups` throws on HTTP errors (502/503/timeout during a CD redeploy).
  // Distinguish "fetch failed" from "0 real groups" to NEVER purge WASM state
  // based on a transient empty list - otherwise all groups would be forgotten,
  // every conversation would become not-ready and SYNC_WATCHDOG would reboot them all.
  let serverFetchOk = false;
  try {
    groups = await mlsService.getUserGroups(userId);
    serverFetchOk = true;
  } catch (e) {
    log(`[SYNC] Failed to fetch user groups: ${e}`);
    console.error('[SYNC] Failed to fetch user groups:', e);
    // Continue anyway to process device invitations.
  }

  const localGroups = new Set(mlsService.getLocalGroups());
  let stateMutated = false;

  // Dedup set: a group and its successor must trigger only one welcome_request
  // (fix R3: no more duplicate Bloc1+Bloc2 calls).
  const seen = new Set<string>();
  // Tous les IDs de groupes connus du serveur (pour nettoyer les orphelins WASM)
  const serverIds = new Set<string>();

  for (const g of groups) {
    // Enregistrer tous les IDs connus (groupe + successeur)
    serverIds.add(g.groupId);
    if (g.successorId) serverIds.add(g.successorId);

    // The target group is the successor when present, otherwise the group itself.
    const targetId = g.successorId ?? g.groupId;
    if (seen.has(targetId)) continue;
    seen.add(targetId);

    // Group deleted without a successor → purge WASM state and notify the UI.
    if (g.deletedAt && !g.successorId) {
      if (localGroups.has(g.groupId)) {
        mlsService.forgetGroup(g.groupId);
        stateMutated = true;
        log(`[SYNC] WASM removed (group deleted): ${g.groupId.slice(0, 8)}…`);
      }
      deps.onGroupDeletedRemotely?.(g.groupId);
      continue;
    }

    // Forget the old group only if the successor is ALREADY in WASM
    // (we already joined B in a previous session).
    // If B has not been joined yet, keep A to decrypt its pending messages
    // before purging - the purge will happen in handleWelcome() as soon as
    // B is joined in this same session.
    if (g.successorId && localGroups.has(g.groupId) && localGroups.has(targetId)) {
      mlsService.forgetGroup(g.groupId);
      stateMutated = true;
      log(`[SYNC] WASM removed (successor already joined): ${g.groupId.slice(0, 8)}…`);
    }

    // Groupe cible absent du WASM.
    if (!localGroups.has(targetId)) {
      // Do not send a welcome_request if KPs are not published:
      // the host would not find our KP and could not invite us.
      if (!keyPackagePublished) {
        log(`[SYNC] ${targetId.slice(0, 8)}… absent - welcome_request deferred (KP not published)`);
        continue;
      }
      const targetEntry = groups.find((x) => x.groupId === targetId);
      if (targetEntry?.deletedAt && !targetEntry?.successorId) {
        // Terminal successor soft-deleted without its own successor.
        // deleteGroup erased dm_group_members → the server cannot forward to anyone.
        // Still trigger onGroupMissing(targetId): requestReAdd arms a 60 s timer
        // that calls reboot(targetId) → findAncestorWithMembers walks up the chain
        // to g.groupId whose dm_group_members is intact (claimSuccessor does not purge it).
        // The watchdog alone was insufficient: it would have called reboot(g.groupId)
        // → joinSuccessor(g.groupId, targetId) → welcome_request for 0 members → stuck.
        log(`[SYNC] Terminal group ${targetId.slice(0, 8)}… deleted - recovery via ancestor`);
        if (deps.onGroupMissing) {
          await deps.onGroupMissing(targetId).catch(() => {});
        }
      } else {
        if (deps.onGroupMissing) {
          await deps.onGroupMissing(targetId).catch(() => {});
          // onGroupMissing (requestReAdd) handles its own logging based on the actual outcome.
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

  // 3. Purge WASM state for groups no longer known to the server.
  // Uses the `localGroups` snapshot captured at the start of the function (same instant
  // as `serverIds`): prevents purging groups created by REBOOT during the async
  // operations in step 2, which would trigger an infinite loop (migrateConversation
  // would point to a group absent from WASM).
  //
  // Anti-reboot-storm guard: NEVER purge if the server list is unreliable.
  //  - `serverFetchOk` false: getUserGroups failed (server unavailable during
  //    a redeploy) → serverIds is empty, all groups would be forgotten.
  //  - empty list while we hold local groups: almost certainly a transient empty
  //    response (an account with active MLS trees always has dm_group_members rows
  //    server-side). Same guard as discoverMissingGroups.
  const serverListReliable = serverFetchOk && (groups.length > 0 || localGroups.size === 0);
  if (serverListReliable) {
    for (const localId of localGroups) {
      if (!serverIds.has(localId)) {
        mlsService.forgetGroup(localId);
        stateMutated = true;
        log(`[SYNC] WASM removed (absent from server): ${localId.slice(0, 8)}…`);
      }
    }
  } else if (localGroups.size > 0) {
    log(
      `[SYNC] WASM purge skipped - server list unreliable (fetchOk=${serverFetchOk}, ${groups.length} group(s))`
    );
  }

  if (stateMutated) {
    await persistMlsStateAfterMutation(mlsService, userId, pin, log);
  }

  // Small delay to let the first batch of messages arrive.
  await new Promise((r) => setTimeout(r, 500));

  // 4. Invitations de nos autres devices (multi-device sync)
  processDeviceInvitationsLocally().catch(() => {});
}

/**
 * Opens the WebSocket, publishes a fresh KeyPackage, and reconciles
 * group state with the server.
 *
 * Steps on each (re-)connection:
 *  1. Guard: leader tab only.
 *  2. Connect to the chat gateway.
 *  3. Publish KeyPackages.
 *  4. Single pass over getUserGroups: welcome_request for any group
 *     absent from WASM, purge of stale states.
 *  5. Process invitations from our own other devices.
 */
export async function initializeConnection(deps: ConnectionDeps): Promise<void> {
  if (!getIsTabLeader()) {
    deps.log('[TAB] Follower tab - skipping initializeConnection.');
    return;
  }

  const connected = await openGatewayConnection(deps);
  if (!connected) return;

  await syncConnectionAfterWsOpen(deps);
}
