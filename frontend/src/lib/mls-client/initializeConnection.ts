import type { IMlsService, UserGroupRow } from './IMlsService';
import { getIsTabLeader } from './tabLeader';
import { persistMlsStateAfterMutation } from '$lib/utils/chat/groupActions';
import {
  connectionSweepDecision,
  groupsOwingAudit,
  noteConnection,
  noteGroupsAudited,
  reconcileAllGroups,
} from '$lib/utils/chat/historyReconcile';

/** Dependencies injected into initializeConnection; only the tab-leader tab calls this function. */
export interface ConnectionDeps {
  mlsService: IMlsService;
  userId: string;
  deviceKeyB64: string;
  scheduleReconnect: () => void;
  setIsWsConnected: (value: boolean) => void;
  setReconnectAttempts: (value: number) => void;
  processDeviceInvitationsLocally: () => Promise<void>;
  log: (msg: string) => void;
  /**
   * Called for each group absent from WASM at connection time. Drives the single recovery seam
   * (`requestReAdd`: external join, else welcome_request). When omitted, falls back to
   * `sendWelcomeRequest` alone (the session watchdog takes over the cadence when available).
   */
  onGroupMissing?: (groupId: string) => Promise<void>;
  /**
   * Called when sync detects that a group was deleted server-side (deletedAt set). Lets the UI
   * mark the conversation `deletedRemotely` instead of removing it silently.
   */
  onGroupDeletedRemotely?: (groupId: string) => void;
}

export type SyncAfterConnectDeps = Pick<
  ConnectionDeps,
  | 'mlsService'
  | 'userId'
  | 'deviceKeyB64'
  | 'processDeviceInvitationsLocally'
  | 'log'
  | 'onGroupMissing'
> & {
  /**
   * Called when sync detects that a group was deleted server-side (deletedAt set) and the
   * conversation still exists locally. The callback must set deletedRemotely=true on the
   * conversation so the UI shows the remote-deletion banner.
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
      // The `disconnect` control frame is the ONLY departure signal, and it is deliberately the
      // only one. A close code was added here on 2026-08-15 to spend `1001 - going away` instead of
      // letting a dying document report `1006`, and it was measured inert the same day: the gateway
      // handles `disconnect` with `handle_disconnect(...); break`, so it has already left its read
      // loop before any close frame can be read - 0 `Client closed connection` lines in 25 minutes
      // of production traffic - while the browser fills the page's own `CloseEvent` with `1006`
      // regardless, because a closing handshake cannot complete inside an unload. Do not re-add it:
      // this frame already tells the gateway everything a close code would, and earlier.
      window.addEventListener('beforeunload', () => mlsService.sendDisconnect(), { once: true });
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
 * Single pass over getUserGroups. For each group active on the server with no local WASM state:
 *   - if `onGroupMissing` is provided: calls it (recovery seam - external join / welcome_request).
 *   - otherwise: sendWelcomeRequest alone (useChatSession watchdog takes over when available).
 *
 * Deleted groups (tombstones): WASM state purged and the UI notified.
 */
export async function syncConnectionAfterWsOpen(deps: SyncAfterConnectDeps): Promise<void> {
  const { mlsService, userId, deviceKeyB64, processDeviceInvitationsLocally, log } = deps;

  if (!getIsTabLeader()) return;

  // 1. Publish KeyPackages
  // welcome_requests must only be sent if this step succeeds:
  // a device sending a welcome_request must have its KPs available on
  // the server so the host can invite it immediately after.
  let keyPackagePublished = false;
  try {
    await mlsService.generateKeyPackage(deviceKeyB64);
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
  // every conversation would become not-ready and SYNC_WATCHDOG would re-add them all.
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

  // All group IDs known to the server (used to purge WASM orphans in step 3).
  const serverIds = new Set<string>();

  for (const g of groups) {
    serverIds.add(g.groupId);

    // Group deleted server-side (tombstone) -> purge WASM state and notify the UI.
    if (g.deletedAt) {
      if (localGroups.has(g.groupId)) {
        mlsService.forgetGroup(g.groupId);
        stateMutated = true;
        log(`[SYNC] WASM removed (group deleted): ${g.groupId.slice(0, 8)}…`);
      }
      deps.onGroupDeletedRemotely?.(g.groupId);
      continue;
    }

    // Group absent from WASM -> drive recovery.
    if (!localGroups.has(g.groupId)) {
      // Do not send a welcome_request if KPs are not published:
      // the host would not find our KP and could not invite us.
      if (!keyPackagePublished) {
        log(
          `[SYNC] ${g.groupId.slice(0, 8)}… absent - welcome_request deferred (KP not published)`
        );
        continue;
      }
      if (deps.onGroupMissing) {
        await deps.onGroupMissing(g.groupId).catch(() => {});
        // onGroupMissing (requestReAdd) handles its own logging based on the actual outcome.
      } else {
        await mlsService.sendWelcomeRequest(g.groupId).catch(() => {});
        log(`[SYNC] welcome_request → ${g.groupId.slice(0, 8)}…`);
      }
    }
  }

  // 3. Purge WASM state for groups no longer known to the server.
  // Uses the `localGroups` snapshot captured at the start of the function (same instant
  // as `serverIds`): prevents purging groups joined during the async operations in step 2.
  //
  // Anti-purge-storm guard: NEVER purge if the server list is unreliable.
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
    await persistMlsStateAfterMutation(mlsService, userId, deviceKeyB64, log);
  }

  // 4. Invitations de nos autres devices (multi-device sync)
  //
  // WAIT FOR THE DRAIN, DO NOT SLEEP THROUGH IT. There used to be `await new Promise(r =>
  // setTimeout(r, 500))` here, described as "a small delay to let the first batch of messages
  // arrive" - a guess that is too long on a fast network and far too short on a slow one.
  // `waitForMessageQueueIdle` is the same intent stated as a fact: the queue is empty, whenever
  // that happens to be.
  //
  // IT NO LONGER CARRIES THE RECONCILIATION GUARANTEE, and that is the point. Ordering the mailbox
  // ahead of the comparison here protected exactly ONE of the four triggers - the three reactive
  // ones fire from wherever they are raised - so the barrier now lives inside `reconcileGroup`,
  // where every trigger present and future must pass. What is left of this line is what it also
  // always did: the device invitations below are read from a store the drain is still writing.
  await mlsService.waitForMessageQueueIdle().catch(() => {});

  processDeviceInvitationsLocally().catch(() => {});

  // 5. Reconciliation. LAST, and after the drain above for a reason that is the whole shape of this
  // mechanism: a device comparing what it holds while its own mailbox is still being applied
  // reports a difference it is in the middle of closing by itself, and then repairs it by asking a
  // peer for messages already on their way.
  //
  // AND ONLY WHEN THE SERVER COULD HAVE DROPPED SOMETHING. This used to sweep every group on every
  // connection; the drain above is what makes that unnecessary, because anything the server still
  // holds for this device has just been delivered by it, and anything that could not be applied
  // raised its own trigger where it failed. `connectionSweepDecision` states the one remaining
  // case - see it for why the other two need nobody asked.
  const deviceId = mlsService.getDeviceId();
  // READ AGAIN HERE, deliberately: the `localGroups` snapshot taken before the sync loop predates
  // the joins and purges it performs, and reconciling a stale list would audit groups this device
  // has just left and miss the ones it has just joined.
  const groupsNow = [...mlsService.getLocalGroups()];
  const { sweep, reason } = connectionSweepDecision(userId, deviceId);

  // TWO INDEPENDENT REASONS TO COMPARE, and only one of them is about this connection. The sweep
  // asks "could the server have dropped something for me"; the audit asks "was this group damaged
  // before anything on this device was able to notice". A device that answers no to the first can
  // still owe the second, and it owes it exactly once per group - see `groupsOwingAudit`.
  const owing = groupsOwingAudit(userId, deviceId, groupsNow);
  const targets = sweep ? groupsNow : owing;

  if (targets.length > 0) {
    log(
      sweep
        ? `[HISTORY_RECONCILE] sweeping every group - ${reason}`
        : `[HISTORY_RECONCILE] no sweep - ${reason}; auditing ${owing.length} group(s) that never have been`
    );
    const askedGroups = await reconcileAllGroups(mlsService, targets, log);
    // DISCHARGED ON THE ASK ITSELF. `reconcileAllGroups` returns the groups a probe really left for,
    // which is shorter than `targets` by whatever was deferred - and those come back next time.
    noteGroupsAudited(userId, deviceId, askedGroups);
  } else {
    log(`[HISTORY_RECONCILE] no sweep - ${reason}; every group already audited`);
  }
  noteConnection(userId, deviceId);
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
