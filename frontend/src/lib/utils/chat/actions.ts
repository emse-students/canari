import { exportBackup, importBackup } from '$lib/backup';
import { fromHex, toHex, saveMlsState, loadMlsState, exportMlsStateAsHex } from '$lib/utils/hex';
import type { IStorage } from '$lib/db';
import type { IMlsService } from '$lib/mlsService';
import type { Conversation } from '$lib/types';
import { isChannelConversationId } from '$lib/utils/chat/channelCrypto';
import {
  sendFullHistoryBundle,
  persistMlsStateAfterMutation,
  forgetMlsGroupIfPresent,
  purgeLocalConversationRecord,
  kickStaleLeaf,
  isGroupActiveOnServer,
  handleDuplicateLeafError,
  isSenderForkError,
  parseForkedEpoch,
} from '$lib/utils/chat/groupActions';
import { parseDirectPeerFromName } from '$lib/utils/chat/conversations';
import {
  classifyServerStatus,
  decideAbsentGroupFate,
  type GroupServerStatus,
} from '$lib/utils/chat/groupLifecycle';
import {
  collectKnownSuccessorIds,
  resolveTerminalGroup,
} from '$lib/utils/chat/groupSyncEligibility';
import { isTauriRuntime } from '$lib/utils/openExternal';

/**
 * Process pending device-group invitations.
 *
 * New paradigm: ANY online device of ANY group member can add a pending device.
 * This eliminates deadlocks - the first device to reconnect handles all pending
 * invitations for groups it belongs to.
 *
 * Flow:
 * 1. Fetch all pending invitations from server (devices waiting to join groups this device is in)
 * 2. For each pending device, acquire add-lock → addMember → sendWelcome → update status
 * 3. On WrongEpoch: check if someone else already handled it → skip
 */
export async function processPendingInvitations(params: {
  mlsService: IMlsService;
  storage: IStorage | null;
  userId: string;
  pin: string;
  conversations: Map<string, Conversation>;
  log: (msg: string) => void;
  /**
   * Recovery of a group whose LOCAL state is forked behind the server (commit rejected
   * epoch_mismatch). Performs forget + welcome_request to rejoin at the current epoch.
   * `minEpoch` (known server epoch) rejects stale Welcomes from a diverged branch.
   * Injected by the session layer (needs recovery timers/conversations).
   */
  recoverForkedGroup?: (groupId: string, minEpoch?: number) => Promise<void>;
}) {
  const { mlsService, storage, userId, pin, conversations, log, recoverForkedGroup } = params;

  const myDeviceId = mlsService.getDeviceId();

  // 1. Fetch pending invitations for groups where this device is a full member
  let pendingInvitations: Array<{
    id: string;
    userId: string;
    deviceId: string;
    groupId: string;
    status: string;
  }>;
  try {
    pendingInvitations = await mlsService.getPendingInvitations(userId, myDeviceId);
  } catch (e) {
    log(`[PENDING] Error fetching pending invitations: ${e}`);
    return;
  }

  if (pendingInvitations.length === 0) return;

  log(`[PENDING] ${pendingInvitations.length} pending invitation(s) to process`);

  // Group by groupId for sequential processing per group (avoids epoch races within a group)
  const byGroup = new Map<string, typeof pendingInvitations>();
  for (const inv of pendingInvitations) {
    const list = byGroup.get(inv.groupId) ?? [];
    list.push(inv);
    byGroup.set(inv.groupId, list);
  }

  let totalWelcomes = 0;

  for (const [origGroupId, invitations] of byGroup) {
    // Resolve the terminal before processing (reboot may have extended the chain).
    const { terminalId: groupId } = await resolveTerminalGroup(mlsService, origGroupId);
    const resolved = groupId;

    // "Ready to invite" = conversation active AND group present in local WASM.
    // After a recovery forgetGroup (fork), the conversation stays isReady but the group
    // has left WASM: calling addMember would loop on "Group not found". We fall into the
    // not-ready branch (recovery welcome_request already in flight).
    const readyForInvites =
      conversations.get(groupId)?.lifecycle === 'active' &&
      mlsService.getLocalGroups().includes(groupId);
    if (!readyForInvites) {
      if (resolved !== origGroupId) {
        // The terminal successor exists but is not ready yet (Welcome in transit).
        // onGroupReady() will trigger another pass in 500 ms.
        log(
          `[PENDING] ${origGroupId.slice(0, 8)}... -> successor ${resolved.slice(0, 8)}... not ready yet - skip`
        );
      } else {
        // Original group not ready locally. If completely absent (not even an
        // isReady:false placeholder), send a welcome_request. A placeholder indicates
        // the Welcome may already be in transit from the queue - do not resend.
        const isAbsent = !conversations.has(origGroupId) && !conversations.has(resolved);
        if (isAbsent) {
          const active = await isGroupActiveOnServer(mlsService, userId, resolved);
          if (active === false) {
            log(
              `[PENDING] Group ${origGroupId} deleted or absent from server - cleaning up invitations (${resolved})`
            );
            for (const inv of invitations) {
              mlsService
                .deleteDeviceMembership(inv.userId, inv.deviceId, origGroupId)
                .catch(() => {});
            }
          } else {
            // Group present on server but absent from local WASM -> welcome_request.
            // The useChatSession watchdog escalates to reboot after 60s if no response.
            mlsService.sendWelcomeRequest(resolved).catch(() => {});
            log(
              `[PENDING] Group ${origGroupId} absent locally -> welcome_request sent for ${resolved}`
            );
          }
        } else {
          log(`[PENDING] Group ${groupId}: local conversation not ready - skip`);
        }
      }
      continue;
    }

    if (resolved !== origGroupId) {
      log(`[PENDING] Group ${origGroupId} -> resolved via successor chain: ${resolved}`);
    }

    // Acquire distributed lock to prevent concurrent Add commits (default TTL = worst case
    // mobile: bulk add + Argon2 + commit + Welcomes, cf. MLS_ADD_LOCK_TTL_MS / H1).
    const lockAcquired = await mlsService.acquireAddLock(groupId).catch(() => false);
    if (!lockAcquired) {
      log(`[PENDING] Group ${groupId}: lock held by another device - skip`);
      continue;
    }

    try {
      // ── Add pending devices ───────────────────────────────────────────────
      // Only 'pending' status exists now (stale removed - RFC 9420).
      const currentPending = invitations.filter((inv) => inv.status === 'pending');

      for (const inv of currentPending) {
        try {
          // Fetch fresh KeyPackage for the pending device. fetchUserDevices only returns
          // devices active within the last 30 days; fall back to fetchDeviceKeyPackage for
          // older ones. null from the fallback means the device was deregistered.
          // Best-effort (`.catch(() => [])`) : a network error here must not short-circuit
          // the fetchDeviceKeyPackage fallback below (empty list => try the fallback).
          const devices = await mlsService.fetchUserDevices(inv.userId).catch(() => []);
          let targetDevice = devices.find((d) => d.deviceId === inv.deviceId);
          if (!targetDevice) {
            const fallback = await mlsService
              .fetchDeviceKeyPackage(inv.userId, inv.deviceId)
              .catch(() => null);
            if (!fallback) {
              log(`[PENDING] Device ${inv.deviceId} not found (deregistered) -> cleanup`);
              mlsService.deleteDeviceMembership(inv.userId, inv.deviceId, groupId).catch(() => {});
              continue;
            }
            targetDevice = fallback;
            log(`[PENDING] KeyPackage retrieved via fallback for ${inv.deviceId} (> 30 days)`);
          }

          // Idempotence: if the device's leaf is already in the MLS tree, the invitation is
          // fulfilled - SKIP regardless of server status. Never kick here.
          //
          // An offline device will join via its already-queued Welcome when it reconnects;
          // a device that has truly lost its state will itself emit a welcome_request
          // (signal-driven path, with anti-livelock limiter in handleWelcomeRequest).
          // Proactively kicking a valid leaf is purely harmful: it inflates the epoch on
          // every sync, invalidates the queued Welcome (device receives a stale Welcome
          // -> re-welcome_request -> churn) and resends the history bundle for nothing. This
          // was the cause of repeated kick+re-add cycles on every reconnect for offline peer
          // devices (status stuck at 'pending' because they never confirm 'active').
          try {
            const members = await mlsService.getGroupMembers(groupId);
            if (members.some((m) => m.deviceId === inv.deviceId)) {
              log(
                `[PENDING] ${inv.deviceId} already in tree for ${groupId} - skip (will join via queued Welcome)`
              );
              continue;
            }
          } catch {
            /* proceed with add attempt */
          }

          // Add the member to the MLS group
          const result = await mlsService.addMember(groupId, targetDevice.keyPackage);

          // Register member on server (upsert GroupMember row) (not strictly necessary to add before Welcome, but keeps server state more up-to-date in case of failure during the MLS flow)
          await mlsService.registerMember(groupId, inv.userId);

          // Send Welcome
          if (result.welcome) {
            await mlsService.sendWelcome(
              result.welcome,
              inv.userId,
              groupId,
              inv.deviceId,
              result.ratchetTree
            );
            totalWelcomes++;
            log(`[PENDING] Welcome → ${inv.deviceId} (user: ${inv.userId}) pour ${groupId}`);
          }

          // Save MLS state before commit (crash-safety)
          await persistMlsStateAfterMutation(mlsService, userId, pin, log);

          // Send commit, excluding the inviter (self) and the newly-welcomed device
          let commitError: unknown = null;
          if (result.commit) {
            try {
              await mlsService.sendCommit(result.commit, groupId, [
                `${inv.userId}:${inv.deviceId}`,
              ]);
            } catch (e) {
              commitError = e;
            }
          }

          // The history bundle = APPLICATION MESSAGES (not a commit, does not go through
          // validateCommit). The new member has already joined via the Welcome (same epoch as
          // us), so we send the history even if the commit broadcast failed - otherwise a
          // rejected commit (concurrent race or server counter lag) would silently deprive
          // them of the full history. [[C8]]
          const bundlePromise = sendFullHistoryBundle(groupId, {
            storage,
            pin,
            mlsService,
            log,
          }).catch((e) =>
            log(`[HISTORY_BUNDLE] History send error to ${inv.userId}: ${String(e)}`)
          );

          if (commitError) {
            // Recovery (catch) will forgetGroup: wait for the history send to complete
            // before cutting it, then surface the commit error.
            await bundlePromise;
            throw commitError;
          }
        } catch (e) {
          const errStr = String(e);

          // OUR commit (addMember merged locally) was rejected for epoch_mismatch: we lost a
          // concurrent commit race and are on a divergent branch. All subsequent commits will
          // be rejected and the winning commit dropped as same-epoch benign -> we never catch
          // up alone. We forget the stale state (rejecting Welcomes < server epoch) and
          // re-request a Welcome, then abandon THIS group for this cycle. We escalate at a
          // gap of 1 (`isSenderForkError`), not only >= 2. [[C7]]
          const forked = parseForkedEpoch(e);
          if (isSenderForkError(e)) {
            log(
              `[PENDING] ${groupId.slice(0, 8)}... forked (commit rejected) - recovery + abandon`
            );
            if (recoverForkedGroup)
              await recoverForkedGroup(groupId, forked?.serverEpoch).catch(() => {});
            break;
          }

          // Device already a member: invitation fulfilled (its leaf is already in our MLS tree).
          // Promote the invitation to active so the server stops re-serving this stale pending
          // row on every sync (root cause of the repeated "already a member" reprocessing every
          // login). Best-effort; on failure it is simply retried next cycle. Do not kick.
          if (errStr.includes('ALREADY_MEMBER')) {
            void mlsService
              .updateInvitationStatus(inv.deviceId, inv.userId, inv.groupId, 'active')
              .catch(() => {});
            log(
              `[PENDING] ${inv.deviceId} already a member of ${groupId.slice(0, 8)}... - invitation fulfilled, marked active`
            );
            continue;
          }

          if (errStr.includes('DuplicateSignatur')) {
            log(`[PENDING] ${inv.deviceId} already in MLS tree of ${groupId}`);
            // The kick triggered here itself generates a commit: if rejected for fork,
            // handleDuplicateLeafError surfaces the error -> we switch to recovery.
            try {
              await handleDuplicateLeafError({
                mlsService,
                groupId,
                targetUserId: inv.userId,
                targetDeviceId: inv.deviceId,
                userId,
                pin,
                log,
              });
            } catch (kickErr) {
              if (isSenderForkError(kickErr)) {
                log(
                  `[PENDING] ${groupId.slice(0, 8)}... forked (kick rejected) - recovery + group abandoned`
                );
                if (recoverForkedGroup)
                  await recoverForkedGroup(groupId, parseForkedEpoch(kickErr)?.serverEpoch).catch(
                    () => {}
                  );
                break;
              }
              log(
                `[PENDING] Kick error for ${inv.deviceId} in ${groupId}: ${String(kickErr).slice(0, 100)}`
              );
            }
          } else if (errStr.includes('WrongEpoch') || errStr.includes('epoch_mismatch')) {
            // Transient concurrent race (gap 1): another device committed simultaneously.
            // Check if the invitation is already fulfilled; otherwise let the next cycle retry
            // (the missing commit arrives via the queue and we catch up on our own).
            log(`[PENDING] WrongEpoch for ${inv.deviceId} in ${groupId} - checking...`);
            try {
              const memberships = await mlsService.getDeviceMemberships(inv.userId, inv.deviceId);
              const m = memberships.find((x) => x.groupId === groupId);
              if (m?.status === 'active') {
                log(`[PENDING] ${inv.deviceId} already active - skip`);
                continue;
              }
            } catch {
              /* ignore */
            }
            log(`[PENDING] Non-recoverable error for ${inv.deviceId}: ${errStr.slice(0, 100)}`);
          } else {
            log(`[PENDING] Add error for ${inv.deviceId} to ${groupId}: ${errStr.slice(0, 100)}`);
          }
        }
      }
    } finally {
      await mlsService.releaseAddLock(groupId).catch(() => {});
    }
  }

  if (totalWelcomes > 0) {
    log(`[PENDING] ${totalWelcomes} Welcome(s) sent.`);
  }
}

/**
 * Force re-processing of pending device invitations.
 * Clears any stale local MLS autosave so the next reload starts fresh.
 */
export function forceSyncReset(_userId: string, log: (msg: string) => void) {
  log(`[SYNC] Forced reset. Reload the page to restart pending invitation processing.`);
}

/**
 * Discovers missing groups.
 *
 * Creates local placeholders for server groups absent from the client
 * (Welcome lost, new device, etc.) and immediately drops local groups
 * absent from the server (when the server list was successfully fetched).
 *
 * IMPORTANT: the unique identifier is the pair (userId, deviceId).
 * A given userId can have multiple devices - never use userId alone
 * to identify a participant or a leaf node.
 */
export async function discoverMissingGroups(params: {
  mlsService: IMlsService;
  userId: string;
  pin: string;
  conversations: Map<string, Conversation>;
  saveConversation?: (key: string) => Promise<void>;
  deleteConversation?: (key: string) => Promise<void>;
  log: (msg: string) => void;
  /** Optional: IndexedDB access to verify messages have been migrated before purge. */
  storage?: IStorage | null;
}) {
  const {
    mlsService,
    userId,
    pin,
    conversations,
    saveConversation,
    deleteConversation,
    log,
    storage,
  } = params;

  // ── Phase 1: Create placeholders for server groups not present locally ────

  let serverGroups: {
    groupId: string;
    name: string;
    isGroup: boolean;
    imageMediaId?: string | null;
    successorId?: string | null;
    deletedAt?: string | null;
  }[] = [];
  let serverFetchSucceeded = false;
  try {
    serverGroups = await mlsService.getUserGroups(userId);
    serverFetchSucceeded = true;
  } catch {
    // Continue to Phase 2 even if server fetch fails - there may be pending placeholders
  }

  // Some backends can transiently return duplicates; keep first occurrence by groupId.
  const uniqueServerGroups = Array.from(new Map(serverGroups.map((g) => [g.groupId, g])).values());

  // Active groups only: exclude soft-deleted (replaced by a successor).
  // Soft-deleted groups still exist on the server for recovery routing but should not
  // be created as local placeholders - checkGroupSuccessors handles the migration.
  const activeServerGroups = uniqueServerGroups.filter((g) => !g.deletedAt);

  // ── Orphan cleanup (server membership = source of truth) ─────────────────
  // Phase 1 - MLS WASM: drop OpenMLS trees for groupIds absent from the server.
  // Phase 2 - UI/IndexedDB: drop conversation rows (may exist without WASM state).
  // Only when getUserGroups succeeded (never purge on transient network errors).
  if (serverFetchSucceeded) {
    const serverGroupIds = new Set(uniqueServerGroups.map((g) => g.groupId));
    const knownSuccessorIds = collectKnownSuccessorIds(uniqueServerGroups);
    // Groups dismissed by THIS user (manual deletion/leave on one device): must be purged
    // on ALL their devices (rules 3 & 5), not shown with the banner.
    // Best-effort (`[]` on error -> never purge on doubt).
    const dismissedGroupIds = new Set(await mlsService.getDismissedGroups().catch(() => []));
    let mlsMutated = false;

    for (const groupId of mlsService.getLocalGroups()) {
      if (isChannelConversationId(groupId)) continue;
      const serverEntry = uniqueServerGroups.find((g) => g.groupId === groupId);
      if (
        serverEntry?.successorId &&
        mlsService.getLocalGroups().includes(serverEntry.successorId)
      ) {
        if (forgetMlsGroupIfPresent(mlsService, groupId, log)) mlsMutated = true;
        continue;
      }
      if (!serverGroupIds.has(groupId)) {
        if (forgetMlsGroupIfPresent(mlsService, groupId, log)) mlsMutated = true;
      }
    }
    if (mlsMutated) {
      await persistMlsStateAfterMutation(mlsService, userId, pin, log);
    }

    for (const [key, convo] of conversations.entries()) {
      if (isChannelConversationId(key)) continue;

      // Dismissed by the user (manual deletion/leave on another device). Two cases:
      //  - no longer an active member -> PURGE (rules 3 & 5), no banner. Top priority.
      //  - active member again (RE-INVITE since) -> dismiss is stale: lift it
      //    server-side and keep the conversation (re-add rule). Do NOT purge here,
      //    or we would delete a group we just re-joined.
      if (dismissedGroupIds.has(convo.id)) {
        if (!serverGroupIds.has(convo.id)) {
          log(`[DISCOVERY] UI group "${convo.name || convo.id}" dismissed by user - removing`);
          await purgeLocalConversationRecord({
            conversations,
            contactKey: key,
            groupId: convo.id,
            deleteConversation,
            log,
          });
          continue;
        }
        log(
          `[DISCOVERY] "${convo.name || convo.id}" dismissed but we are a member again - dismiss lifted`
        );
        void mlsService.undismissGroup(convo.id).catch(() => {});
        // On laisse le traitement normal continuer (groupe actif).
      }

      const { terminalId, hasChain } = await resolveTerminalGroup(mlsService, convo.id).catch(
        () => ({ terminalId: convo.id, hasChain: false })
      );
      if (hasChain && terminalId !== convo.id && conversations.has(terminalId)) {
        // Migration safety: do not delete the source if its messages are not yet
        // in the terminal group (interrupted reboot/migration).
        if (storage) {
          const pendingMsgs = await storage.getMessages(convo.id, pin).catch(() => []);
          if (pendingMsgs.length > 0) {
            log(
              `[DISCOVERY] ${convo.id.slice(0, 8)}... kept - ${pendingMsgs.length} msg(s) not yet migrated to ${terminalId.slice(0, 8)}...`
            );
            continue;
          }
        }
        log(
          `[DISCOVERY] UI group "${convo.name || convo.id}" -> terminal ${terminalId.slice(0, 8)}... - removing`
        );
        await purgeLocalConversationRecord({
          conversations,
          contactKey: key,
          groupId: convo.id,
          deleteConversation,
          log,
        });
        continue;
      }

      const serverEntry = uniqueServerGroups.find((g) => g.groupId === convo.id);
      if (serverEntry?.successorId && conversations.has(serverEntry.successorId)) {
        // Migration safety: do not delete the source if its messages are not yet
        // in the successor group (interrupted reboot/migration).
        if (storage) {
          const pendingMsgs = await storage.getMessages(convo.id, pin).catch(() => []);
          if (pendingMsgs.length > 0) {
            log(
              `[DISCOVERY] ${convo.id.slice(0, 8)}... kept - ${pendingMsgs.length} msg(s) not yet migrated to ${serverEntry.successorId.slice(0, 8)}...`
            );
            continue;
          }
        }
        log(
          `[DISCOVERY] UI group "${convo.name || convo.id}" migrated to ${serverEntry.successorId} - removing`
        );
        await purgeLocalConversationRecord({
          conversations,
          contactKey: key,
          groupId: convo.id,
          deleteConversation,
          log,
        });
        continue;
      }

      if (!serverGroupIds.has(convo.id)) {
        // Fate decision centralised in `decideAbsentGroupFate` (single source shared with
        // other reconcilers). We only query the server for genuinely undecided cases: a known
        // tombstone successor or a conv already `deletedRemotely` short-circuit without a
        // network call (migration / manual deletion handle them).
        const isKnownSuccessor = knownSuccessorIds.has(convo.id);
        let serverStatus: GroupServerStatus = { kind: 'unknown' };
        let isStillUserMember: boolean | null = null;
        if (!isKnownSuccessor && convo.lifecycle !== 'removed') {
          serverStatus = classifyServerStatus(await mlsService.getGroupServerStatus(convo.id));
          // Anti-race: only re-validate our actual membership on a LIVE group absent from our
          // getUserGroups snapshot (which may be stale for a group just created/joined).
          if (serverStatus.kind === 'active') {
            const userMembers = await mlsService.getGroupUserMembers(convo.id).catch(() => null);
            isStillUserMember =
              userMembers === null ? null : userMembers.some((m) => m.userId === userId);
          }
        }

        const fate = decideAbsentGroupFate({
          isKnownSuccessor,
          lifecycle: convo.lifecycle,
          serverStatus,
          isStillUserMember,
        });
        const label = convo.name || convo.id;

        if (fate.action === 'purge') {
          log(`[DISCOVERY] UI group "${label}" - ${fate.reason} - removing`);
          await purgeLocalConversationRecord({
            conversations,
            contactKey: key,
            groupId: convo.id,
            deleteConversation,
            log,
          });
          continue;
        }
        if (fate.action === 'markRemoved') {
          conversations.set(key, { ...convo, lifecycle: 'removed' });
          await saveConversation?.(key).catch(() => {});
          log(`[DISCOVERY] UI group "${label}" ${fate.reason} - marked removed`);
          continue;
        }
        // keep
        log(`[DISCOVERY] UI group "${label}" kept - ${fate.reason}`);
        continue;
      }
    }
  }

  // Include both ready and placeholder conversations to avoid recreating
  // the same pending entry on each login.
  // Only create placeholders for active groups - soft-deleted ones are handled by checkGroupSuccessors.
  const localGroupIds = new Set([...conversations.values()].map((c) => c.id));
  const missing = activeServerGroups.filter((g) => !localGroupIds.has(g.groupId));

  if (missing.length > 0) {
    log(
      `[DISCOVERY] ${missing.length} server group(s) missing locally: ${missing.map((g) => g.name || g.groupId).join(', ')}`
    );
  }

  for (const g of missing) {
    if (conversations.has(g.groupId)) continue;

    const directPeer = !g.isGroup ? parseDirectPeerFromName(g.name || '', userId) : null;
    const displayName = directPeer || g.name || g.groupId;

    // Local dedup: if a direct conv with this same peer already exists
    // under a different groupId (server-side duplicate), do not create a
    // second placeholder - just update the key if needed.
    if (directPeer) {
      const alreadyLoaded = [...conversations.values()].find(
        (c) =>
          (c.conversationType ?? 'group') === 'direct' &&
          (c.directPeerId ?? c.contactName).toLowerCase() === directPeer
      );
      if (alreadyLoaded) {
        log(`[DISCOVERY] Duplicate ignored for "${directPeer}" (existing: ${alreadyLoaded.id})`);
        continue;
      }
    }

    const key = g.groupId; // map key = groupId
    conversations.set(key, {
      id: g.groupId,
      contactName: displayName,
      name: displayName,
      messages: [],
      lifecycle: 'pending', // placeholder until the Welcome is processed
      mlsStateHex: null,
      conversationType: g.isGroup ? 'group' : 'direct',
      imageMediaId: g.imageMediaId ?? null,
      ...(directPeer ? { directPeerId: directPeer } : {}),
    });
    if (saveConversation) {
      try {
        await saveConversation(key);
      } catch (e) {
        log(
          `[WARN] Placeholder persistence failed for ${g.groupId}: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
    log(`[DISCOVERY] Placeholder "${displayName}" created.`);
  }

  // ── Seed group avatars from the server (source of truth) ─────────────────
  // imageMediaId is not persisted in the local ConversationMeta; it is re-seeded
  // from getUserGroups on every discovery so a freshly-loaded or new device shows
  // the current group photo. Live changes still arrive via the MLS system message.
  for (const g of activeServerGroups) {
    if (!g.isGroup) continue;
    const convo = conversations.get(g.groupId);
    const nextImage = g.imageMediaId ?? null;
    if (convo && (convo.imageMediaId ?? null) !== nextImage) {
      conversations.set(g.groupId, { ...convo, imageMediaId: nextImage });
    }
  }
}

/** Exports the user's full backup (conversations + messages + MLS state) as a `.canari` file. In Tauri opens a folder picker; in the browser triggers an anchor download. */
export async function exportUserBackup(params: {
  storage: IStorage;
  userId: string;
  pin: string;
  myDeviceId: string;
  log: (msg: string) => void;
}) {
  const { storage, userId, pin, myDeviceId, log } = params;
  const mlsStateHex = await exportMlsStateAsHex(userId);
  const blob = await exportBackup(storage, userId, pin, myDeviceId, mlsStateHex);
  const date = new Date().toISOString().split('T')[0];
  const filename = `canari-backup-${userId}-${date}.canari`;

  if (isTauriRuntime()) {
    // In Tauri (desktop/mobile) blob URLs and anchor downloads do not work.
    // Delegate file writing to the Rust side which saves to the Downloads
    // folder (desktop) or app data dir (mobile).

    const dialog = await import('@tauri-apps/plugin-dialog');
    const fs = await import('@tauri-apps/plugin-fs');
    // Dynamic import: avoids bundling @tauri-apps/api/path in the Web build.
    const { downloadDir } = await import('@tauri-apps/api/path');

    const path = await dialog.open({
      multiple: false,
      directory: true,
      defaultPath: await downloadDir(),
    });
    if (path === null) {
      console.info('directory selection cancelled');
      return;
    }
    const file = await fs.create(`${path}/${filename}`);
    await file.write(new Uint8Array(blob.buffer as ArrayBuffer));
    await file.close();
    log(`[OK] Backup exported: ${filename}`);
  } else {
    const url = URL.createObjectURL(
      new Blob([blob.buffer as ArrayBuffer], { type: 'application/octet-stream' })
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    log(`[OK] Backup exported: ${filename}`);
  }
}

/** Imports a `.canari` backup file: decrypts conversations/messages, restores the MLS state if this is the same device, then reloads the conversation list. */
export async function importUserBackup(params: {
  file: File;
  pin: string;
  storage: IStorage;
  myDeviceId: string;
  userId: string;
  log: (msg: string) => void;
  reloadConversations: () => Promise<void>;
  clearConversations: () => void;
}) {
  const { file, pin, storage, myDeviceId, userId, log, reloadConversations, clearConversations } =
    params;

  const arrayBuffer = await file.arrayBuffer();
  const { data: backup, isSameDevice } = await importBackup(
    new Uint8Array(arrayBuffer),
    pin,
    storage,
    myDeviceId
  );

  if (isSameDevice) {
    const existingMlsState = await loadMlsState(userId);
    if (backup.mlsState && !existingMlsState) {
      await saveMlsState(userId, fromHex(backup.mlsState));
      log('MLS state restored (same device).');
    } else if (existingMlsState) {
      log('Local MLS state preserved (device already active).');
    }
  } else {
    log(
      '[WARNING] New device detected. Conversations are imported as read-only. ' +
        'Reconnect the exporting device to trigger automatic group invitation.'
    );
  }

  clearConversations();
  await reloadConversations();

  log(
    `[OK] Backup imported: ${backup.conversations.length} conversation(s), ` +
      `${backup.messages.length} message(s).`
  );
}

/** Dev helper: generates a new MLS KeyPackage for this device and returns it as a hex string. */
export async function generateDevKeyPackage(params: { mlsService: IMlsService; pin: string }) {
  const { mlsService, pin } = params;
  const bytes = await mlsService.generateKeyPackage(pin);
  return toHex(bytes);
}

/** Dev helper: adds a member to a group using a hex-encoded KeyPackage, returning the commit and welcome as hex strings. */
export async function addDevMember(params: {
  mlsService: IMlsService;
  groupId: string;
  incomingBytesHex: string;
}) {
  const { mlsService, groupId, incomingBytesHex } = params;
  const result = await mlsService.addMember(groupId, fromHex(incomingBytesHex));
  return {
    commitHex: toHex(result.commit),
    welcomeHex: result.welcome ? toHex(result.welcome) : '',
  };
}

/** Dev helper: processes an MLS Welcome message from a hex-encoded byte string. */
export async function processDevWelcome(params: {
  mlsService: IMlsService;
  incomingBytesHex: string;
}) {
  const { mlsService, incomingBytesHex } = params;
  await mlsService.processWelcome(fromHex(incomingBytesHex));
}

// In-process guard: prevents the same tab from handling two welcome_requests
// for the same group concurrently (e.g. rapid retries arriving before the
// first one finishes).  Cross-device races are handled by acquireAddLock below.
const welcomeRequestInProgress = new Set<string>();

/** Re-add attempts keyed by `${groupId}:${requesterDeviceId}` within the sliding window. */
const reAddAttempts = new Map<string, { count: number; first: number }>();

/** Maximum re-add attempts for the same device within the window before suspending. */
const MAX_READD_ATTEMPTS = 3;

/** Sliding window duration for the re-add anti-livelock guard. */
const READD_WINDOW_MS = 3 * 60_000;

/** Timestamp of the last Welcome sent, keyed by `${groupId}:${requesterDeviceId}`. */
const lastWelcomeSentAt = new Map<string, number>();

/**
 * Cooldown after which a freshly-invited device is presumed "still joining".
 * While it runs, further welcome_requests from that device are ignored: its leaf is fresh,
 * not stale, and kicking it would cause UseAfterEviction on send. Must cover Welcome
 * decryption + history bundle ingestion (several seconds).
 */
const WELCOME_COOLDOWN_MS = 30_000;

/**
 * Handles a welcome_request received from a device that wants to join a group.
 *
 * Nominal case: addMember -> sendWelcome -> sendCommit.
 *
 * "Leaf already present" case: if the device was previously in the group
 * (stale, crash, etc.), its leaf node is still in the MLS tree but its
 * local state is lost. In this case:
 *   1. removeMemberDevice (kick the stale leaf)
 *   2. kickStaleDevice (reset server membership to pending)
 *   3. addMember with a fresh KeyPackage -> sendWelcome -> sendCommit
 *
 * IMPORTANT: the unique identifier is (userId, deviceId), not userId alone.
 *
 * Security: refuses to re-add a requester absent from dm_group_members (a removed user).
 * The gateway authenticates the sender but does not check their membership before relaying.
 */
export async function handleWelcomeRequest(params: {
  mlsService: IMlsService;
  storage: IStorage | null;
  userId: string;
  pin: string;
  conversations: Map<string, Conversation>;
  log: (msg: string) => void;
  requesterUserId: string;
  requesterDeviceId: string;
  groupId: string;
  /** Called when the terminal group exists but is not ready yet (Welcome in transit). */
  onNotReady?: (terminalGroupId: string) => void;
  /**
   * Recovery of a group whose LOCAL state is forked behind the server (commit rejected
   * epoch_mismatch during add). Performs forget + welcome_request.
   * `minEpoch` (known server epoch) rejects stale Welcomes from a diverged branch.
   */
  recoverForkedGroup?: (groupId: string, minEpoch?: number) => Promise<void>;
}) {
  const {
    mlsService,
    storage,
    userId,
    pin,
    conversations,
    log,
    requesterUserId,
    requesterDeviceId,
    groupId: requestedGroupId,
    onNotReady,
    recoverForkedGroup,
  } = params;

  // Anti-self guard: the gateway broadcasts welcome_requests to ALL devices of the user,
  // including the sender. A device must never handle its own request: it would add itself
  // to the MLS tree and kick its own leaf (self-eviction), leaving the group it just created
  // and restarting the successor cascade.
  if (requesterUserId === userId && requesterDeviceId === mlsService.getDeviceId()) {
    log(`[WELCOME_REQ] Request from self (${requesterDeviceId.slice(0, 12)}...) - ignored`);
    return;
  }

  // Resolve the terminal group in the successor chain (max 10 hops).
  const {
    terminalId,
    groupMeta: terminalMeta,
    hasChain,
  } = await resolveTerminalGroup(mlsService, requestedGroupId);

  // Group not found on server.
  if (!terminalMeta) {
    log(`[WELCOME_REQ] Group ${requestedGroupId.slice(0, 8)}... not found - refusing`);
    return;
  }

  // Entire lineage is deleted - refuse to invite into a dead group.
  if (terminalMeta.deletedAt) {
    log(`[WELCOME_REQ] Lineage of ${requestedGroupId.slice(0, 8)}... deleted - refusing`);
    return;
  }

  if (hasChain) {
    log(`[WELCOME_REQ] ${requestedGroupId.slice(0, 8)}… → terminal ${terminalId.slice(0, 8)}…`);
  }

  // groupId now points to the terminal of the lineage.
  const groupId = terminalId;

  // ── Membership guard (security) ─────────────────────────────────────────────
  // The gateway authenticates the sender (no spoofing) but relays the request without checking
  // membership; we must therefore refuse here to re-add a REMOVED user. The source of truth is
  // dm_group_members (user-level): a removed user no longer has a row, whereas a legitimate
  // invited/pending user has one BEFORE emitting any welcome_request (addGroupMember /
  // acceptGroupInvite create it first). We cannot gate on group:members / the MLS tree: the very
  // purpose of a welcome_request is to serve someone absent from routing (lost WASM state).
  // Fail-closed: if the list is unavailable (network), refuse - the requester retries (60s cadence)
  // and another peer can honor it. Never re-add on doubt.
  const userMembers = await mlsService.getGroupUserMembers(groupId).catch(() => null);
  if (userMembers === null) {
    log(
      `[WELCOME_REQ] Members of ${groupId.slice(0, 8)}… unavailable - refused (requester will retry)`
    );
    return;
  }
  if (!userMembers.some((m) => m.userId === requesterUserId)) {
    log(
      `[WELCOME_REQ] ${requesterUserId} not a member of ${groupId.slice(0, 8)}… (removed) - re-add refused`
    );
    return;
  }

  // Defence in depth: verify we have a ready conversation for this terminal group.
  // If this device is not yet in the terminal group (Welcome in transit or initial sync
  // not complete), signal via onNotReady so the caller defers and retries.
  if (conversations.get(groupId)?.lifecycle !== 'active') {
    log(`[WELCOME_REQ] No ready conversation for ${groupId.slice(0, 8)}... - deferring`);
    onNotReady?.(groupId);
    return;
  }

  // Guard in-process: prevents two concurrent handles for the same group
  // in the same tab (rapid retries arrive before the first one finishes)
  if (welcomeRequestInProgress.has(groupId)) {
    log(`[WELCOME_REQ] Already in progress for ${groupId} - skip`);
    return;
  }
  welcomeRequestInProgress.add(groupId);

  // Acquire the distributed lock to prevent races with
  // processPendingInvitations on another device of the same group (default TTL, cf. H1)
  const lockAcquired = await mlsService.acquireAddLock(groupId).catch(() => false);
  if (!lockAcquired) {
    log(`[WELCOME_REQ] Lock busy for ${groupId} - another device in progress, skip`);
    welcomeRequestInProgress.delete(groupId);
    return;
  }

  try {
    const attemptKey = `${groupId}:${requesterDeviceId}`;
    const now = Date.now();

    // Post-Welcome cooldown: if we sent a Welcome to this device recently, it is almost
    // certainly still processing it (decryption + history bundle take several seconds).
    // Kicking now would evict a freshly-added leaf -> the invitee falls into
    // UseAfterEviction on send. Let it finish joining.
    const lastWelcome = lastWelcomeSentAt.get(attemptKey);
    if (lastWelcome && now - lastWelcome < WELCOME_COOLDOWN_MS) {
      log(
        `[WELCOME_REQ] ${requesterDeviceId.slice(0, 12)}... Welcome sent ${Math.round((now - lastWelcome) / 1000)}s ago - still joining, skip`
      );
      return;
    }

    // Anti-livelock guard: limits repeated re-adds of the same device within a sliding
    // window. If the invitee loops (their published KeyPackages are orphaned from their
    // private key -> NoMatchingKeyPackage client-side), re-adding is pointless and would
    // saturate the server (Welcome + history bundle each round). The fix is client-side
    // (republish); here we simply stop looping.
    const prev = reAddAttempts.get(attemptKey);
    const attempt = prev && now - prev.first < READD_WINDOW_MS ? prev : { count: 0, first: now };
    attempt.count += 1;
    reAddAttempts.set(attemptKey, attempt);
    if (attempt.count > MAX_READD_ATTEMPTS) {
      log(
        `[WELCOME_REQ] ${requesterDeviceId.slice(0, 12)}... re-added ${attempt.count - 1}x in vain on ${groupId.slice(0, 8)}... - re-add suspended (fix needed client-side)`
      );
      return;
    }

    // Fetch a fresh KeyPackage for the requesting device.
    // If absent: the device has not yet published its KP -> cannot invite it.
    // Causality is guaranteed upstream: syncConnectionAfterWsOpen does not send a
    // welcome_request until generateKeyPackage has succeeded.
    // Best-effort: a network error must not short-circuit the fetchDeviceKeyPackage fallback.
    const devices = await mlsService.fetchUserDevices(requesterUserId).catch(() => []);
    let targetDevice = devices.find((d) => d.deviceId === requesterDeviceId);
    if (!targetDevice) {
      // fetchUserDevices applies a 30-day cutoff: the requesting device may be absent
      // (old device reconnecting). Retry via fetchDeviceKeyPackage, which has no cutoff -
      // same fallback as processPendingInvitations. Without this, a valid but out-of-window
      // device stays stuck (silent abandon, no re-add possible).
      const fallback = await mlsService
        .fetchDeviceKeyPackage(requesterUserId, requesterDeviceId)
        .catch(() => null);
      if (!fallback) {
        log(`[WELCOME_REQ] KeyPackage not found for ${requesterDeviceId} - aborting`);
        return;
      }
      targetDevice = fallback;
      log(`[WELCOME_REQ] KeyPackage retrieved via fallback for ${requesterDeviceId} (> 30 days)`);
    }

    // ── Check if the device's leaf is already in the MLS tree ────────────
    // Do not check status='active' here: sendWelcome marks the device active
    // optimistically before the phone processes the Welcome. If the device loses its
    // WASM state (restart, fresh-install, NoMatchingKeyPackage), it resends a
    // welcome_request while already marked 'active' server-side.
    // -> always kick + re-add when the leaf is present in the tree.
    try {
      const currentMembers = await mlsService.getGroupMembers(groupId);
      if (currentMembers.some((m) => m.deviceId === requesterDeviceId)) {
        log(`[WELCOME_REQ] ${requesterDeviceId.slice(0, 12)}... leaf in MLS tree - kick + re-add`);
        await kickStaleLeaf(groupId, requesterUserId, requesterDeviceId, mlsService, log);

        // Save MLS state after the remove commit
        await persistMlsStateAfterMutation(mlsService, userId, pin, log);

        // Re-fetch KeyPackage (may have changed after kick)
        // Best-effort: empty list on network error => freshDevice not found => clean skip.
        const freshDevices = await mlsService.fetchUserDevices(requesterUserId).catch(() => []);
        const freshDevice = freshDevices.find((d) => d.deviceId === requesterDeviceId);
        if (!freshDevice) {
          log(`[WELCOME_REQ] KeyPackage not found after kick for ${requesterDeviceId} - skip`);
          return;
        }
        // Update the reference for the add below
        targetDevice.keyPackage = freshDevice.keyPackage;
      }
    } catch {
      // On verification error, still attempt the add
    }

    // ── Add the device to the MLS group ────────────────────────────────
    const result = await mlsService.addMember(groupId, targetDevice.keyPackage);
    await mlsService.registerMember(groupId, requesterUserId);

    // Send the Welcome to the requesting device
    if (result.welcome) {
      await mlsService.sendWelcome(
        result.welcome,
        requesterUserId,
        groupId,
        requesterDeviceId,
        result.ratchetTree
      );
      lastWelcomeSentAt.set(attemptKey, Date.now());
      log(`[WELCOME_REQ] Welcome -> ${requesterUserId}:${requesterDeviceId} for ${groupId}`);
    }

    // Save MLS state before the commit (crash-safety)
    await persistMlsStateAfterMutation(mlsService, userId, pin, log);

    // Broadcast the commit excluding the inviter (self) and the invitee
    let commitError: unknown = null;
    if (result.commit) {
      try {
        await mlsService.sendCommit(result.commit, groupId, [
          `${requesterUserId}:${requesterDeviceId}`,
        ]);
      } catch (e) {
        commitError = e;
      }
    }

    // Send the full history to the new member. These are APPLICATION MESSAGES
    // (not a commit, do not go through validateCommit): the recipient has already joined via
    // the Welcome (same epoch as us), so we send the history EVEN IF the commit broadcast
    // failed - otherwise a rejected commit (concurrent race, server counter lag) would silently
    // deprive them of the full history. The bundle arrives after the Welcome client-side
    // (order guaranteed by MLS) and reads IndexedDB (including messages migrated from the
    // predecessor via migrateConversation). [[C8]]
    const bundlePromise = sendFullHistoryBundle(groupId, { storage, pin, mlsService, log }).catch(
      (e) => log(`[HISTORY_BUNDLE] History send error to ${requesterUserId}: ${String(e)}`)
    );

    if (commitError) {
      // Recovery (catch) will forgetGroup: wait for the history send to complete before
      // cutting it, then surface the commit error to trigger the heal (C7).
      await bundlePromise;
      throw commitError;
    }
  } catch (e) {
    const errStr = String(e);

    // OUR commit (addMember merged locally) was rejected for epoch_mismatch: divergent branch
    // after a lost concurrent race, we never catch up alone (the winning commit is dropped as
    // same-epoch benign). We forget the stale state and re-request a Welcome for ourselves.
    // We escalate at a gap of 1 (`isSenderForkError`). [[C7]]
    const forked = parseForkedEpoch(e);
    if (isSenderForkError(e)) {
      log(`[WELCOME_REQ] ${groupId.slice(0, 8)}... forked (commit rejected) - recovery`);
      if (recoverForkedGroup)
        await recoverForkedGroup(groupId, forked?.serverEpoch).catch(() => {});
    } else if (errStr.includes('ALREADY_MEMBER')) {
      // Device already a member: request fulfilled (will join via queued Welcome).
      log(
        `[WELCOME_REQ] ${requesterDeviceId} already a member of ${groupId.slice(0, 8)}... - skip`
      );
    } else if (errStr.includes('DuplicateSignatur')) {
      try {
        await handleDuplicateLeafError({
          mlsService,
          groupId,
          targetUserId: requesterUserId,
          targetDeviceId: requesterDeviceId,
          userId,
          pin,
          log,
        });
      } catch (kickErr) {
        const kickForked = parseForkedEpoch(kickErr);
        if (isSenderForkError(kickErr)) {
          log(`[WELCOME_REQ] ${groupId.slice(0, 8)}... forked (kick rejected) - recovery`);
          if (recoverForkedGroup)
            await recoverForkedGroup(groupId, kickForked?.serverEpoch).catch(() => {});
        } else {
          log(
            `[WELCOME_REQ] Kick error for ${requesterDeviceId}: ${String(kickErr).slice(0, 100)}`
          );
        }
      }
    } else {
      log(`[WELCOME_REQ] Error for ${requesterDeviceId}: ${errStr.slice(0, 100)}`);
    }
  } finally {
    await mlsService.releaseAddLock(groupId).catch(() => {});
    welcomeRequestInProgress.delete(groupId);
  }
}
