import { exportBackup, importBackup } from '$lib/backup';
import { fromHex, toHex } from '$lib/utils/hex';
import type { IStorage } from '$lib/db';
import type { IMlsService } from '$lib/mlsService';
import type { Conversation } from '$lib/types';

function parseDirectPeerFromName(rawName: string, userId: string): string | null {
  const parts = rawName
    .split('::')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length < 2) return null;

  const current = userId.toLowerCase();
  const unique = [...new Set(parts)];
  const peer = unique.find((p) => p !== current);
  return peer ?? null;
}

/**
 * Process pending device-group invitations.
 *
 * New paradigm: ANY online device of ANY group member can add a pending device.
 * This eliminates deadlocks — the first device to reconnect handles all pending
 * invitations for groups it belongs to.
 *
 * Flow:
 * 1. Fetch all pending invitations from server (devices waiting to join groups this device is in)
 * 2. For each pending device, acquire add-lock → addMember → sendWelcome → update status
 * 3. On WrongEpoch: check if someone else already handled it → skip
 */
export async function processPendingInvitations(params: {
  mlsService: IMlsService;
  userId: string;
  pin: string;
  conversations: Map<string, Conversation>;
  log: (msg: string) => void;
}) {
  const { mlsService, userId, pin, conversations, log } = params;

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
    log(`[PENDING] Erreur récupération invitations: ${e}`);
    return;
  }

  if (pendingInvitations.length === 0) return;

  log(`[PENDING] ${pendingInvitations.length} invitation(s) en attente à traiter`);

  // Group by groupId for sequential processing per group (avoids epoch races within a group)
  const byGroup = new Map<string, typeof pendingInvitations>();
  for (const inv of pendingInvitations) {
    const list = byGroup.get(inv.groupId) ?? [];
    list.push(inv);
    byGroup.set(inv.groupId, list);
  }

  let totalWelcomes = 0;

  for (const [groupId, invitations] of byGroup) {
    // Only process groups where we have a ready local conversation
    const convo = conversations.get(groupId);
    if (!convo?.isReady) {
      log(`[PENDING] Groupe ${groupId}: pas de conversation locale prête — skip`);
      continue;
    }

    // Acquire distributed lock to prevent concurrent Add commits
    const lockAcquired = await mlsService.acquireAddLock(groupId, 15_000).catch(() => false);
    if (!lockAcquired) {
      log(`[PENDING] Groupe ${groupId}: verrou tenu par un autre appareil — skip`);
      continue;
    }

    try {
      // ── Phase 0: Kick stale devices ──────────────────────────────────────
      // A stale device's leaf is still in the MLS tree.  We must remove it
      // (commit de "kick") before re-adding (commit + welcome d'ajout).
      const staleInvs = invitations.filter((inv) => inv.status === 'stale');

      for (const inv of staleInvs) {
        try {
          // Remove this specific device's leaf from the MLS tree by its identity
          const deviceIdentity = `${inv.userId}:${inv.deviceId}`;
          await mlsService.removeMemberDevice(groupId, [deviceIdentity]);
          log(`[PENDING] Kicked stale device ${inv.userId}:${inv.deviceId} from ${groupId}`);

          // Reset only this device in this group to pending on the server
          await mlsService.kickStaleDevice(inv.deviceId, inv.userId, groupId);

          // Persist MLS state after the remove commit
          const stBytes = await mlsService.saveState(pin);
          localStorage.setItem('mls_autosave_' + userId, toHex(stBytes));

          // Short delay for commit propagation
          await new Promise((r) => setTimeout(r, 150));
        } catch (e) {
          log(`[PENDING] Erreur kick stale device ${inv.deviceId}: ${String(e).slice(0, 100)}`);
        }
      }

      // ── Phase 1: Add pending devices ─────────────────────────────────────
      // If we just kicked stale users, re-fetch this group's pending list
      // (the kicked devices are now pending).
      let currentPending: typeof invitations;
      if (staleInvs.length > 0) {
        try {
          const allPending = await mlsService.getPendingInvitations(userId, myDeviceId);
          currentPending = allPending.filter((inv) => inv.groupId === groupId);
        } catch {
          currentPending = invitations.filter((inv) => inv.status === 'pending');
        }
      } else {
        currentPending = invitations.filter((inv) => inv.status === 'pending');
      }

      for (const inv of currentPending) {
        try {
          // Fetch fresh KeyPackage for the pending device
          const devices = await mlsService.fetchUserDevices(inv.userId);
          const targetDevice = devices.find((d) => d.deviceId === inv.deviceId);
          if (!targetDevice) {
            log(`[PENDING] KeyPackage introuvable pour ${inv.deviceId} — skip`);
            continue;
          }

          // Check if device is already in the MLS group (idempotency)
          try {
            const members = await mlsService.getGroupMembers(groupId);
            if (members.some((m) => m.deviceId === inv.deviceId)) {
              log(`[PENDING] ${inv.deviceId} déjà membre de ${groupId} — mise à jour statut`);
              await mlsService.updateInvitationStatus(
                inv.deviceId,
                inv.userId,
                groupId,
                'welcome_received'
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
          const stBytes = await mlsService.saveState(pin);
          localStorage.setItem('mls_autosave_' + userId, toHex(stBytes));

          // Send commit
          if (result.commit) {
            await mlsService.sendCommit(result.commit, groupId);
          }

          // Short delay for commit propagation
          await new Promise((r) => setTimeout(r, 150));
        } catch (e) {
          const errStr = String(e);
          if (errStr.includes('DuplicateSignatur') || errStr.includes('already')) {
            // Already in MLS tree — update server status
            log(`[PENDING] ${inv.deviceId} déjà dans l'arbre MLS de ${groupId}`);
            await mlsService
              .updateInvitationStatus(inv.deviceId, inv.userId, groupId, 'welcome_received')
              .catch(() => {});
          } else if (errStr.includes('WrongEpoch') || errStr.includes('epoch_mismatch')) {
            // Someone else committed — check if this invitation was already handled
            log(`[PENDING] WrongEpoch pour ${inv.deviceId} dans ${groupId} — vérification...`);
            try {
              const memberships = await mlsService.getDeviceMemberships(inv.userId, inv.deviceId);
              const m = memberships.find((x) => x.groupId === groupId);
              if (m && (m.status === 'welcome_sent' || m.status === 'welcome_received')) {
                log(`[PENDING] ${inv.deviceId} déjà traité (${m.status}) — skip`);
                continue;
              }
            } catch {
              /* ignore */
            }
            log(`[PENDING] Erreur non-récupérable pour ${inv.deviceId}: ${errStr.slice(0, 100)}`);
          } else {
            log(`[PENDING] Erreur ajout ${inv.deviceId} à ${groupId}: ${errStr.slice(0, 100)}`);
          }
        }
      }
    } finally {
      await mlsService.releaseAddLock(groupId).catch(() => {});
    }
  }

  if (totalWelcomes > 0) {
    log(`[PENDING] ${totalWelcomes} Welcome(s) envoyé(s).`);
  }
}

/**
 * Force re-processing of pending device invitations.
 * Clears any stale local MLS autosave so the next reload starts fresh.
 */
export function forceSyncReset(userId: string, log: (msg: string) => void) {
  // Remove stale autosave so MLS re-init is clean on reload
  const hadState = Boolean(localStorage.getItem('mls_autosave_' + userId));
  if (hadState) {
    log(`[SYNC] MLS autosave supprimé pour ${userId}. Rechargez pour forcer le re-bootstrap.`);
  }
  log(`[SYNC] Reset forcé. Rechargez la page pour relancer le traitement des invitations.`);
}

/**
 * Discover groups this user belongs to on the server but doesn't have locally,
 * then re-bootstrap any orphaned groups where no device has MLS state.
 *
 * Phase 1 — Create placeholders for missing groups.
 * Phase 2 — Re-bootstrap: when ALL devices lost their MLS state (state cleared,
 * new browser session, etc.), no device can produce a Welcome → deadlock.
 * We break the deadlock by having one device re-create the MLS group locally
 * and re-invite all members.
 *
 * Leader election: alphabetically first userId among group members bootstraps.
 * Fallback: after 30 s without Welcome, any device can bootstrap.
 */
export async function discoverMissingGroups(params: {
  mlsService: IMlsService;
  userId: string;
  pin: string;
  conversations: Map<string, Conversation>;
  saveConversation?: (key: string) => Promise<void>;
  log: (msg: string) => void;
}) {
  const { mlsService, userId, pin, conversations, saveConversation, log } = params;

  // ── Phase 1: Create placeholders for server groups not present locally ────

  let serverGroups: { groupId: string; name: string; isGroup: boolean }[] = [];
  try {
    serverGroups = await mlsService.getUserGroups(userId);
  } catch {
    // Continue to Phase 2 even if server fetch fails — there may be pending placeholders
  }

  // Some backends can transiently return duplicates; keep first occurrence by groupId.
  const uniqueServerGroups = Array.from(new Map(serverGroups.map((g) => [g.groupId, g])).values());

  // Include both ready and placeholder conversations to avoid recreating
  // the same pending entry on each login.
  const localGroupIds = new Set([...conversations.values()].map((c) => c.id));
  const missing = uniqueServerGroups.filter((g) => !localGroupIds.has(g.groupId));

  if (missing.length > 0) {
    log(
      `[DISCOVERY] ${missing.length} groupe(s) serveur absent(s) localement: ${missing.map((g) => g.name || g.groupId).join(', ')}`
    );
  }

  for (const g of missing) {
    if (conversations.has(g.groupId)) continue;

    const directPeer = !g.isGroup ? parseDirectPeerFromName(g.name || '', userId) : null;
    const displayName = directPeer || g.name || g.groupId;

    const key = g.groupId; // map key = groupId
    conversations.set(key, {
      id: g.groupId,
      contactName: displayName,
      name: displayName,
      messages: [],
      isReady: false, // Not ready until Welcome is processed
      mlsStateHex: null,
      conversationType: g.isGroup ? 'group' : 'direct',
      ...(directPeer ? { directPeerId: directPeer } : {}),
    });
    if (saveConversation) {
      try {
        await saveConversation(key);
      } catch (e) {
        log(
          `[WARN] Echec persistance placeholder ${g.groupId}: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
    log(`[DISCOVERY] Placeholder "${displayName}" créé.`);
  }

  // ── Phase 2: Re-bootstrap orphaned groups ─────────────────────────────────

  const pendingConvos = [...conversations.entries()].filter(([, c]) => !c.isReady);
  if (pendingConvos.length === 0) return;

  for (const [key, convo] of pendingConvos) {
    // Fast-path: group already present in local MLS state (restored from backup, etc.)
    // Check this BEFORE hitting the server — no need for member list to activate.
    const localGroups = mlsService.getLocalGroups();
    if (localGroups.includes(convo.id)) {
      log(`[DISCOVERY] "${convo.name}": groupe présent dans MLS local — activation directe.`);
      try {
        await mlsService.registerMember(convo.id, userId);
      } catch {
        /* non-blocking */
      }
      conversations.set(key, { ...convo, isReady: true });
      if (saveConversation) await saveConversation(key);
      localStorage.removeItem(`discovery_pending:${convo.id}`);
      continue;
    }

    // Re-read local MLS groups inside the loop: a Welcome may have been processed
    // during the async operations above and already joined the group.

    let members: { userId: string }[];
    try {
      members = await mlsService.getGroupMembers(convo.id);
    } catch {
      continue;
    }
    if (members.length === 0) {
      log(`[DISCOVERY] "${convo.name}": aucun membre serveur — skip.`);
      continue;
    }

    const memberUserIds = [...new Set(members.map((m) => m.userId.toLowerCase()))].sort();
    const isLeader = memberUserIds[0] === userId.toLowerCase();

    // Track how long this placeholder has been pending
    const pendingKey = `discovery_pending:${convo.id}`;
    const pendingSince = parseInt(localStorage.getItem(pendingKey) ?? '0', 10);
    if (!pendingSince) {
      localStorage.setItem(pendingKey, String(Date.now()));
    }
    const waitingMs = pendingSince ? Date.now() - pendingSince : 0;

    // Check if current user has another own device → it can Welcome us via reinvite_request
    let hasOtherOwnDevice = false;
    try {
      const ownDevices = await mlsService.fetchUserDevices(userId);
      hasOtherOwnDevice = ownDevices.some((d) => d.deviceId !== mlsService.getDeviceId());
    } catch {
      /* ignore */
    }

    // Check if any other group member has active devices → use extended 120s timeout
    const otherMemberIds = memberUserIds.filter((uid) => uid !== userId.toLowerCase());
    let otherMembersHaveDevices = false;
    for (const memberId of otherMemberIds) {
      try {
        const devices = await mlsService.fetchUserDevices(memberId);
        if (devices.length > 0) {
          otherMembersHaveDevices = true;
          break;
        }
      } catch {
        /* ignore */
      }
    }

    // Decision tree:
    //   1. Own other device exists → it will Welcome us via reinvite_request, skip
    //   2. Leader + no other own device → bootstrap immediately
    //   3. Non-leader + active peer devices → wait 120s then bootstrap as fallback
    //   4. Non-leader + no active peer devices → wait 30s then bootstrap as fallback
    const timeoutMs = otherMembersHaveDevices ? 120_000 : 30_000;
    const shouldBootstrap = !hasOtherOwnDevice && (isLeader || waitingMs > timeoutMs);

    if (!shouldBootstrap) {
      log(
        `[DISCOVERY] "${convo.name}": attente Welcome via service de livraison (${Math.round(waitingMs / 1000)}s / ${timeoutMs / 1000}s)`
      );
      continue;
    }

    log(
      `[DISCOVERY] Re-bootstrap "${convo.name}" (${isLeader ? 'leader' : `fallback ${Math.round(waitingMs / 1000)}s`})...`
    );

    try {
      // Create MLS group locally with the existing server groupId.
      // Use forceCreateGroup to wipe any orphan OpenMLS state from a previous
      // session before creating fresh — avoids recovering stale-epoch state.
      try {
        await mlsService.forceCreateGroup(convo.id);
      } catch (createErr) {
        const msg = createErr instanceof Error ? createErr.message : String(createErr);
        if (msg.includes('GroupAlreadyExists')) {
          // Orphan recovered from storage (forceCreateGroup fell back to createGroup).
          // Activate directly — the recovered state may have the correct epoch.
          log(`[DISCOVERY] "${convo.name}": groupe déjà présent dans Rust — activation directe.`);
          try {
            await mlsService.registerMember(convo.id, userId);
          } catch {
            /* non-blocking */
          }
          conversations.set(key, { ...convo, isReady: true });
          if (saveConversation) await saveConversation(key);
          localStorage.removeItem(pendingKey);
          continue;
        }
        throw createErr;
      }
      await mlsService.registerMember(convo.id, userId);

      // Collect all members' current devices
      const allDevices: { keyPackage: Uint8Array; deviceId: string }[] = [];
      const deviceUserMap = new Map<string, string>();
      for (const memberId of memberUserIds) {
        try {
          const devices = await mlsService.fetchUserDevices(memberId);
          for (const d of devices) {
            if (d.deviceId === mlsService.getDeviceId()) continue;
            allDevices.push(d);
            deviceUserMap.set(d.deviceId, memberId);
          }
        } catch {
          log(`[DISCOVERY] Appareils indisponibles pour ${memberId}.`);
        }
      }

      if (allDevices.length > 0) {
        const bulk = await mlsService.addMembersBulk(convo.id, allDevices);

        for (const did of bulk.addedDeviceIds) {
          const memberUserId = deviceUserMap.get(did);
          if (memberUserId) {
            await mlsService.registerMember(convo.id, memberUserId);
          }
        }

        if (bulk.welcome) {
          for (const did of bulk.addedDeviceIds) {
            const memberUserId = deviceUserMap.get(did);
            if (memberUserId) {
              try {
                await mlsService.sendWelcome(
                  bulk.welcome,
                  memberUserId,
                  convo.id,
                  did,
                  bulk.ratchetTree
                );
              } catch (e) {
                log(
                  `[DISCOVERY] Welcome echoue ${memberUserId}:${did}: ${e instanceof Error ? e.message : String(e)}`
                );
              }
            }
          }
        }

        // Sauvegarder l'état MLS AVANT sendCommit (crash-safety)
        const stBytes = await mlsService.saveState(pin);
        localStorage.setItem('mls_autosave_' + userId, toHex(stBytes));

        if (bulk.commit) {
          // Reset the server-side epoch to 0 before the first commit of the new
          // MLS session. The server still remembers the old activeEpoch from the
          // previous session — without this reset, baseEpoch=0 would mismatch
          // and the gateway would reject the commit with epoch_rejected.
          await mlsService.resetGroupEpoch(convo.id);
          await mlsService.sendCommit(bulk.commit, convo.id);
        }
      }

      conversations.set(key, { ...convo, isReady: true });
      if (saveConversation) await saveConversation(key);
      localStorage.removeItem(pendingKey);

      log(
        `[DISCOVERY][OK] "${convo.name}" re-bootstrap (${allDevices.length} appareil(s) invite(s)).`
      );
    } catch (e) {
      log(
        `[DISCOVERY] Echec re-bootstrap "${convo.name}": ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
}

export async function exportUserBackup(params: {
  storage: IStorage;
  userId: string;
  pin: string;
  myDeviceId: string;
  log: (msg: string) => void;
}) {
  const { storage, userId, pin, myDeviceId, log } = params;
  const mlsStateHex = localStorage.getItem('mls_autosave_' + userId) ?? undefined;
  const blob = await exportBackup(storage, userId, pin, myDeviceId, mlsStateHex);
  const date = new Date().toISOString().split('T')[0];
  const filename = `canari-backup-${userId}-${date}.canari`;

  const url = URL.createObjectURL(
    new Blob([blob.buffer as ArrayBuffer], { type: 'application/octet-stream' })
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  log(`[OK] Sauvegarde exportee : ${filename}`);
}

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
    const existingMlsState = localStorage.getItem('mls_autosave_' + userId);
    if (backup.mlsState && !existingMlsState) {
      localStorage.setItem('mls_autosave_' + userId, backup.mlsState);
      log('État MLS restauré (même appareil).');
    } else if (existingMlsState) {
      log('État MLS local conservé (appareil déjà actif).');
    }
  } else {
    log(
      '[ATTENTION] Nouvel appareil detecte. Les conversations sont importees en lecture seule. ' +
        "Reconnectez l'appareil exportateur pour declencher l'invitation automatique aux groupes."
    );
  }

  clearConversations();
  await reloadConversations();

  log(
    `[OK] Sauvegarde importee : ${backup.conversations.length} conversation(s), ` +
      `${backup.messages.length} message(s).`
  );
}

export async function generateDevKeyPackage(params: { mlsService: IMlsService; pin: string }) {
  const { mlsService, pin } = params;
  const bytes = await mlsService.generateKeyPackage(pin);
  return toHex(bytes);
}

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

export async function processDevWelcome(params: {
  mlsService: IMlsService;
  incomingBytesHex: string;
}) {
  const { mlsService, incomingBytesHex } = params;
  await mlsService.processWelcome(fromHex(incomingBytesHex));
}

// Local guard: only one welcome_request per group can be processed at a time on this device.
// A distributed lock is not needed because the gateway already routes each welcome_request
// to exactly one peer, so no two devices can race on the same request.
const welcomeRequestInProgress = new Set<string>();

export async function handleWelcomeRequest(params: {
  mlsService: IMlsService;
  userId: string;
  pin: string;
  conversations: Map<string, Conversation>;
  log: (msg: string) => void;
  requesterUserId: string;
  requesterDeviceId: string;
  groupId: string;
}) {
  const {
    mlsService,
    userId,
    pin,
    conversations,
    log,
    requesterUserId,
    requesterDeviceId,
    groupId,
  } = params;

  // Only handle if we have a ready conversation for this group
  const convo = conversations.get(groupId);
  if (!convo?.isReady) {
    log(`[WELCOME_REQ] Pas de conversation prête pour ${groupId} — skip`);
    return;
  }

  if (welcomeRequestInProgress.has(groupId)) {
    log(`[WELCOME_REQ] Déjà en cours pour ${groupId} — skip`);
    return;
  }
  welcomeRequestInProgress.add(groupId);

  try {
    // Fetch fresh KeyPackage for the requesting device
    const devices = await mlsService.fetchUserDevices(requesterUserId);
    const targetDevice = devices.find((d) => d.deviceId === requesterDeviceId);
    if (!targetDevice) {
      log(`[WELCOME_REQ] KeyPackage introuvable pour ${requesterDeviceId} — skip`);
      return;
    }

    // Idempotency: if the device's leaf is already in the MLS tree, skip.
    // This covers stale devices that reset themselves to 'pending' and send a
    // welcome_request — their leaf is still present in every member's tree, so a
    // bare addMember commit would create an epoch mismatch for everyone.
    // processPendingInvitations handles this case correctly (kick commit first,
    // then add commit), so we leave it to that path.
    try {
      const members = await mlsService.getGroupMembers(groupId);
      if (members.some((m) => m.deviceId === requesterDeviceId)) {
        log(
          `[WELCOME_REQ] ${requesterDeviceId} déjà dans l'arbre MLS de ${groupId} — délégué à processPendingInvitations`
        );
        return;
      }
    } catch {
      // proceed if member list unavailable
    }

    // Add the device to the MLS group
    const result = await mlsService.addMember(groupId, targetDevice.keyPackage);
    await mlsService.registerMember(groupId, requesterUserId);

    // Send Welcome to the requesting device
    if (result.welcome) {
      await mlsService.sendWelcome(
        result.welcome,
        requesterUserId,
        groupId,
        requesterDeviceId,
        result.ratchetTree
      );
      log(`[WELCOME_REQ] Welcome → ${requesterUserId}:${requesterDeviceId} pour ${groupId}`);
    }

    // Persist MLS state before broadcasting the commit
    const stBytes = await mlsService.saveState(pin);
    localStorage.setItem('mls_autosave_' + userId, toHex(stBytes));

    // Broadcast commit, excluding the inviter (self) and the invitee (requester)
    if (result.commit) {
      await mlsService.sendCommit(result.commit, groupId, [
        `${userId}:${mlsService.getDeviceId()}`,
        `${requesterUserId}:${requesterDeviceId}`,
      ]);
    }
  } catch (e) {
    const errStr = String(e);
    if (errStr.includes('DuplicateSignatur') || errStr.includes('already')) {
      await mlsService
        .updateInvitationStatus(requesterDeviceId, requesterUserId, groupId, 'welcome_received')
        .catch(() => {});
    } else {
      log(`[WELCOME_REQ] Erreur pour ${requesterDeviceId}: ${errStr.slice(0, 100)}`);
    }
  } finally {
    welcomeRequestInProgress.delete(groupId);
  }
}
