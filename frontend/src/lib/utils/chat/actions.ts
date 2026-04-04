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
    const convo = [...conversations.values()].find((c) => c.groupId === groupId && c.isReady);
    if (!convo) {
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
      for (const inv of invitations) {
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

          // Register member on server
          await mlsService.registerMember(groupId, inv.userId, inv.deviceId);

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
  const localGroupIds = new Set([...conversations.values()].map((c) => c.groupId));
  const missing = uniqueServerGroups.filter((g) => !localGroupIds.has(g.groupId));

  if (missing.length > 0) {
    log(
      `[DISCOVERY] ${missing.length} groupe(s) serveur absent(s) localement: ${missing.map((g) => g.name || g.groupId).join(', ')}`
    );
  }

  for (const g of missing) {
    const existingEntry = [...conversations.entries()].find(([, c]) => c.groupId === g.groupId);
    if (existingEntry) continue;

    const directPeer = !g.isGroup ? parseDirectPeerFromName(g.name || '', userId) : null;
    const displayName = directPeer || g.name || g.groupId;

    const key = g.isGroup ? `grp_${crypto.randomUUID()}` : `dm_${crypto.randomUUID()}`;
    conversations.set(key, {
      contactName: displayName,
      name: displayName,
      groupId: g.groupId,
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

  // Groupes déjà présents dans l'état MLS en mémoire (chargés depuis localStorage).
  // Si le groupe existe ici, l'état cryptographique est intact — un re-bootstrap
  // le détruirait et créerait un split-brain (AeadError permanent).
  const localMlsGroupIds = new Set(mlsService.getLocalGroups());

  for (const [key, convo] of pendingConvos) {
    // ── Fast path : l'état MLS existe déjà (ex: nouvel onglet ayant chargé le state) ──
    if (localMlsGroupIds.has(convo.groupId)) {
      log(
        `[DISCOVERY] "${convo.name}": etat MLS present localement — activation sans re-bootstrap.`
      );
      // S'enregistrer auprès du gateway pour que les futurs messages soient routés ici
      try {
        await mlsService.registerMember(convo.groupId, userId, mlsService.getDeviceId());
      } catch {
        /* non-blocking */
      }
      conversations.set(key, { ...convo, isReady: true });
      if (saveConversation) await saveConversation(key);
      localStorage.removeItem(`discovery_pending:${convo.groupId}`);
      continue;
    }

    let members: { userId: string }[];
    try {
      members = await mlsService.getGroupMembers(convo.groupId);
    } catch {
      continue;
    }
    if (members.length === 0) {
      log(`[DISCOVERY] "${convo.name}": aucun membre serveur — skip.`);
      continue;
    }

    const memberUserIds = [...new Set(members.map((m) => m.userId.toLowerCase()))].sort();
    const isLeader = memberUserIds[0] === userId.toLowerCase();
    const otherMemberIds = memberUserIds.filter((m) => m !== userId.toLowerCase());

    // Track how long this placeholder has been pending
    const pendingKey = `discovery_pending:${convo.groupId}`;
    const pendingSince = parseInt(localStorage.getItem(pendingKey) ?? '0', 10);
    if (!pendingSince) {
      localStorage.setItem(pendingKey, String(Date.now()));
    }
    const waitingMs = pendingSince ? Date.now() - pendingSince : 0;

    // Check if any of our OWN other devices are published.
    // If so, one of them should add us via processPendingInvitations (triggered by
    // our sync_request). Re-bootstrapping while they have a valid MLS state would
    // create a split-brain (incompatible key material → permanent AeadError).
    let hasOtherOwnDevices = false;
    try {
      const ownDevices = await mlsService.fetchUserDevices(userId);
      hasOtherOwnDevices = ownDevices.some((d) => d.deviceId !== mlsService.getDeviceId());
    } catch {
      // ignore
    }

    let otherMemberIsActive = false;
    if (!hasOtherOwnDevices) {
      // Only check other members when we have no own devices that can send us a Welcome.
      for (const memberId of otherMemberIds) {
        try {
          const devices = await mlsService.fetchUserDevices(memberId);
          if (devices.length > 0) {
            otherMemberIsActive = true;
            break;
          }
        } catch {
          // ignore
        }
      }
    }

    // Decision logic:
    // 1. Own devices exist → ALWAYS wait for Welcome (they handle sync via sync_request)
    // 2. No own devices, other members active → they can't add us (single-writer),
    //    but leader can re-bootstrap; non-leader waits 120s
    // 3. No own devices, nobody active → truly orphaned; leader bootstraps, others wait 30s
    let shouldBootstrap: boolean;
    if (hasOtherOwnDevices) {
      // Only re-bootstrap as extreme fallback if Welcome never arrives
      shouldBootstrap = waitingMs > 120_000;
    } else if (otherMemberIsActive) {
      shouldBootstrap = isLeader || waitingMs > 120_000;
    } else {
      shouldBootstrap = isLeader || waitingMs > 30_000;
    }

    if (!shouldBootstrap) {
      log(
        hasOtherOwnDevices
          ? `[DISCOVERY] "${convo.name}": autre(s) appareil(s) propre(s) detecte(s), attente Welcome via sync_request... (${Math.round(waitingMs / 1000)}s / 120s)`
          : otherMemberIsActive
            ? `[DISCOVERY] "${convo.name}": ${otherMemberIds[0] ?? 'membre'} actif, attente re-invitation... (${Math.round(waitingMs / 1000)}s / 120s)`
            : `[DISCOVERY] "${convo.name}": attente bootstrap par ${memberUserIds[0]} (${Math.round(waitingMs / 1000)}s / 30s)`
      );
      continue;
    }

    log(
      `[DISCOVERY] Re-bootstrap "${convo.name}" (${isLeader ? 'leader' : `fallback ${Math.round(waitingMs / 1000)}s`})...`
    );

    try {
      // Create MLS group locally with the existing server groupId
      await mlsService.createGroup(convo.groupId);
      await mlsService.registerMember(convo.groupId, userId, mlsService.getDeviceId());

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
        const bulk = await mlsService.addMembersBulk(convo.groupId, allDevices);

        for (const did of bulk.addedDeviceIds) {
          const memberUserId = deviceUserMap.get(did);
          if (memberUserId) {
            await mlsService.registerMember(convo.groupId, memberUserId, did);
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
                  convo.groupId,
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
          await mlsService.sendCommit(bulk.commit, convo.groupId);
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
