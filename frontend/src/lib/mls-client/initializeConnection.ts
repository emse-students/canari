import type { IMlsService } from './IMlsService';
import { republishBaseIfStale } from '$lib/utils/chat/staleBase';
import { DeviceLimitReachedError } from './mlsDeliveryApi';
import { getIsTabLeader } from './tabLeader';
import { showToast } from '$lib/stores/toast.svelte';
import { m } from '$lib/paraglide/messages';
import { dropGroupState } from '$lib/utils/chat/dropGroupState';
import { persistMlsStateAfterMutation } from '$lib/utils/chat/groupActions';
import { forgetGroupsAbsentFromServer, readGroupSweepSnapshot } from '$lib/utils/chat/groupSweep';
import { removeStrayLeaves } from '$lib/utils/chat/strayLeaves';
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
   * (`requestReAdd`: external join first, `welcome_request` only when no base can be used).
   *
   * REQUIRED, AND IT USED TO HAVE A FALLBACK. When it was omitted this pass called
   * `sendWelcomeRequest` directly, which skips the whole ladder: no self-service external join, no
   * `readWelcomeOwed` (so it could race a member's in-flight Add into a duplicate leaf), no
   * throttle, and no terminal reading of a 403. Both call sites - `sessionAuth` and
   * `sessionConnection` - have always passed it, so the fallback was a path that existed only to be
   * silently worse than the one next to it.
   */
  onGroupMissing: (groupId: string) => Promise<void>;
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
 * A handshake started ahead of the code that will use the socket, settled either way.
 *
 * `null` means the socket opened; an `Error` is the rejection {@link openGatewayConnection} would
 * have caught had it called `connect` itself. IT NEVER REJECTS, and that is the point: this promise
 * is created long before anything awaits it, and a rejecting one left in flight for the length of
 * an MLS state load is an unhandled rejection - which on this path also means a `SessionExpiredError`
 * reported by the wrong mechanism, at the wrong time, to nobody.
 */
export type StartedHandshake = Promise<Error | null>;

/**
 * Starts the gateway handshake WITHOUT waiting for it, so it runs beside the MLS state load.
 *
 * The two have no data dependency in either direction: the socket carries a device id and a token,
 * both of which exist before a byte of MLS state is decrypted. Measured on production 2026-09-16,
 * the handshake was 182 ms of a 1308 ms cold start and every one of those milliseconds was spent
 * waiting for a state the socket never reads.
 *
 * WHAT MAKES IT SAFE IS NOT HERE BUT AT THE OTHER END: an early socket can be handed a frame before
 * the MLS client that must interpret it exists, so `BaseMlsService` holds every inbound frame until
 * the login calls `markInboundReady`. **Do not call this without that call.** The caller that
 * awaits the result is {@link openGatewayConnection}, which does the whole of the post-connect half
 * exactly as it does for a handshake it started itself.
 *
 * @returns the started handshake, or `null` on a follower tab, which opens no socket at all.
 */
export function startGatewayHandshake(
  deps: Pick<ConnectionDeps, 'mlsService' | 'log'>
): StartedHandshake | null {
  if (!getIsTabLeader()) {
    deps.log('[TAB] Follower tab - skipping openGatewayConnection.');
    return null;
  }
  deps.log('Connecting to Gateway…');
  return (async () => {
    const { getToken } = await import('$lib/stores/auth');
    const token = await getToken();
    await deps.mlsService.connect(token);
  })().then(
    () => null,
    (e: unknown) => (e instanceof Error ? e : new Error(String(e)))
  );
}

/**
 * Opens the WebSocket to the chat gateway (leader tab only).
 * Returns true when the socket is up; false when skipped or connect failed.
 *
 * @param started a handshake already in flight from {@link startGatewayHandshake}. Omitted, this
 *   function starts one itself and awaits it, which is what the reconnect path does - it has
 *   nothing to overlap the wait with.
 */
export async function openGatewayConnection(
  deps: ConnectionDeps,
  started?: StartedHandshake | null
): Promise<boolean> {
  const { mlsService, scheduleReconnect, setIsWsConnected, setReconnectAttempts, log } = deps;

  if (!getIsTabLeader()) {
    log('[TAB] Follower tab - skipping openGatewayConnection.');
    return false;
  }

  try {
    if (started) {
      // The failure is RE-THROWN rather than returned, so both routes reach the one catch below
      // and a `SessionExpiredError` is still re-thrown to the caller that must stop retrying.
      const failure = await started;
      if (failure) throw failure;
    } else {
      log('Connecting to Gateway…');
      const { getToken } = await import('$lib/stores/auth');
      const token = await getToken();
      await mlsService.connect(token);
    }
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
      log(`[WARN] Failed to fetch initial pending messages: ${String(e)}`);
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
    const msg = String(wsErr);
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
 * Single pass over getUserGroups. Every group active on the server with no local WASM state goes to
 * `onGroupMissing` - the single recovery seam - and nowhere else.
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
    // A REFUSAL IS NOT A DEFERRAL, AND ONLY THE THROW KNOWS WHICH THIS IS. Every failure here used
    // to be logged as "deferred to next connection", which is true of a 502 and false of the device
    // cap: the server refuses a 16th device with a 400 forever, so the next connection is refused
    // identically and the device never becomes addressable. Measured on prod 2026-08-28 - an account
    // sat at 15/15 while its client reported a deferral every reconnection, published no KeyPackage,
    // and was answered `reason=no_key_package` on every membership activation. Nothing healed, and
    // nothing said so. The distinction is carried as a TYPE from the seam that reads the status.
    if (e instanceof DeviceLimitReachedError) {
      log(
        `[KP] REFUSED - this account is at its device limit (${e.max ?? 'unknown'}).` +
          ' This device cannot register and NOTHING will heal it: an unused device must be deleted.'
      );
      // The only actor who can lift it is the user, so the only useful place to say so is the UI.
      showToast(m.chat_device_limit_reached({ max: e.max ?? '' }), 'error', 12_000);
    } else {
      log(`[KP] Publication failed (${e}) - welcome_request deferred to next connection`);
    }
  }

  // 2. Groupes du serveur, and the local set that will be compared against them.
  //
  // ONE SEAM READS BOTH, because the ORDER between them is load-bearing and a caller stating it is
  // a caller that can get it wrong - which both sweeps did, and both were fixed separately hours
  // apart on 2026-08-30. `groupSweep.ts` carries the measurement and the other three ways these two
  // copies had drifted. A failed fetch is not thrown: the device invitations below still run.
  const snapshot = await readGroupSweepSnapshot(mlsService, userId, log);
  const { localGroups } = snapshot;

  let stateMutated = false;

  for (const g of snapshot.serverGroups) {
    // Group deleted server-side (tombstone) -> purge WASM state and notify the UI.
    if (g.deletedAt) {
      if (localGroups.has(g.groupId)) {
        // Deferred: the sync walks every group and its own checkpoint follows the loop, so awaiting
        // one encrypted save per deleted group would serialise the whole connection behind them.
        await dropGroupState(mlsService, g.groupId, {
          reason: 'deleted server-side',
          checkpoint: 'deferred',
          log,
        });
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
      // requestReAdd handles its own logging, based on the actual outcome.
      await deps.onGroupMissing(g.groupId).catch(() => {});
      continue;
    }

    // THE SYMMETRIC BRANCH, AND IT WAS MISSING. Above: this device holds no state for the group and
    // asks somebody. Here: this device HOLDS the tree, which makes it the only kind of thing that
    // can mint an external-join base - so it is the one that repairs a base that has fallen behind.
    //
    // A base is minted only as a follow-up to a commit (`void refreshGroupInfo`), so losing that
    // call strands the published base one epoch behind for ever: the epoch gate accepts
    // `baseEpoch == activeEpoch` and nothing else, so every stateless device is refused from that
    // moment on. Measured on production 2026-09-04 - four groups stale, all by exactly one epoch,
    // two of them for five days with three devices waiting on them. The repair existed for
    // distribution groups only, and three of those four are conversations.
    //
    // It belongs HERE because this loop is the one read every device already makes on every
    // connection, and both epochs now travel on it: no timer, no queue, and no second copy of a
    // fact the server holds authoritatively. See `staleBase.ts` for the four properties.
    await republishBaseIfStale(mlsService, g, log).catch((e) =>
      log(`[BASE] ${g.groupId.slice(0, 8)}… republish check failed: ${String(e).slice(0, 120)}`)
    );

    // AND THE SECOND THING ONLY A HOLDER CAN DO: EVICT A LEAF ITS OWNER WALKED AWAY FROM.
    //
    // Leaving stages no Remove for the leaver's own leaf and cannot - a departing member is exactly
    // the party that may not commit its own eviction - so the leaf stays in every remaining tree,
    // holding key material for a conversation its owner has left. The repair existed for
    // distribution groups only, the same sentence the branch above carries. See `strayLeaves.ts`
    // for the diff, the cost it pays and why nothing is broadcast.
    const evicted = await removeStrayLeaves(mlsService, g.groupId, userId, log).catch((e) => {
      log(`[STRAY] ${g.groupId.slice(0, 8)}… reconciliation failed: ${String(e).slice(0, 120)}`);
      return [];
    });
    if (evicted.length > 0) stateMutated = true;
  }

  // 3. Purge WASM state for groups no longer known to the server - the same call discovery makes,
  // over the same snapshot, with the same guard and the same log vocabulary. The guard used to live
  // here and NOT in discovery, while a comment here asserted that it did; that divergence is `D5`.
  if (await forgetGroupsAbsentFromServer(mlsService, snapshot, log)) stateMutated = true;

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
  // `null`: this is the connection edge itself, about every group and inside no decrypt session.
  await mlsService.waitForMessageQueueIdle('connection sync', null).catch(() => {});

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
