import { exportBackup, importBackup } from '$lib/backup';
import { fromHex, toHex, saveMlsState, loadMlsState, exportMlsStateAsHex } from '$lib/utils/hex';
import type { IStorage } from '$lib/db';
import type { IMlsService } from '$lib/mlsService';
import type { Conversation } from '$lib/types';
import { downloadDir } from '@tauri-apps/api/path';

/**
 * Extracts the other user's ID from a DM group name formatted as "userA::userB".
 * Returns null when the name does not match the pattern (i.e. for named group chats).
 */
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

  for (const [origGroupId, invitations] of byGroup) {
    // Only process groups where we have a ready local conversation.
    // Si le groupe a un successeur connu, traiter via celui-ci.
    let groupId = origGroupId;
    if (!conversations.get(groupId)?.isReady) {
      const meta = await mlsService.getGroupMeta(groupId).catch(() => null);
      if (meta?.successorId && conversations.get(meta.successorId)?.isReady) {
        log(`[PENDING] Groupe ${groupId} → successeur ${meta.successorId}`);
        groupId = meta.successorId;
      } else {
        log(`[PENDING] Groupe ${groupId}: pas de conversation locale prête — skip`);
        continue;
      }
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
          await saveMlsState(userId, stBytes);

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

          // Check if device is already in the MLS group (idempotency).
          // If the device is in the tree but Welcome was never received (e.g. sendWelcome
          // failed on a previous attempt), kick the stale leaf so the next round can reinvite.
          try {
            const members = await mlsService.getGroupMembers(groupId);
            if (members.some((m) => m.deviceId === inv.deviceId)) {
              const memberships = await mlsService
                .getDeviceMemberships(inv.userId, inv.deviceId)
                .catch(() => []);
              const memberStatus = memberships.find((x) => x.groupId === groupId)?.status;
              if (memberStatus === 'welcome_received') {
                log(`[PENDING] ${inv.deviceId} déjà membre (Welcome reçu) — skip`);
                continue;
              }
              // Device is in MLS tree but Welcome was lost — kick to allow reinvite
              log(`[PENDING] ${inv.deviceId} dans l'arbre MLS sans Welcome — kick du leaf stale`);
              const deviceIdentity = `${inv.userId}:${inv.deviceId}`;
              await mlsService.removeMemberDevice(groupId, [deviceIdentity]).catch(() => {});
              await mlsService.kickStaleDevice(inv.deviceId, inv.userId, groupId).catch(() => {});
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
          await saveMlsState(userId, stBytes);

          // Send commit, excluding the inviter (self) and the newly-welcomed device
          if (result.commit) {
            await mlsService.sendCommit(result.commit, groupId, [`${inv.userId}:${inv.deviceId}`]);
          }

          // Short delay for commit propagation
          await new Promise((r) => setTimeout(r, 150));
        } catch (e) {
          const errStr = String(e);
          if (errStr.includes('DuplicateSignatur') || errStr.includes('already')) {
            // addMember threw DuplicateSignature — device is in MLS tree.
            // If Welcome was received, nothing to do. If Welcome was lost (e.g. a
            // previous addMember succeeded but sendWelcome threw), kick the stale
            // leaf so the next round can re-add with a fresh Welcome.
            log(`[PENDING] ${inv.deviceId} déjà dans l'arbre MLS de ${groupId}`);
            try {
              const memberships = await mlsService.getDeviceMemberships(inv.userId, inv.deviceId);
              const memberStatus = memberships.find((x) => x.groupId === groupId)?.status;
              if (memberStatus !== 'welcome_received') {
                const deviceIdentity = `${inv.userId}:${inv.deviceId}`;
                await mlsService.removeMemberDevice(groupId, [deviceIdentity]).catch(() => {});
                await mlsService.kickStaleDevice(inv.deviceId, inv.userId, groupId).catch(() => {});
              }
            } catch {
              await mlsService
                .updateInvitationStatus(inv.deviceId, inv.userId, groupId, 'welcome_received')
                .catch(() => {});
            }
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
export function forceSyncReset(_userId: string, log: (msg: string) => void) {
  log(`[SYNC] Reset forcé. Rechargez la page pour relancer le traitement des invitations.`);
}

/**
 * Découverte des groupes manquants.
 *
 * Crée des placeholders locaux pour les groupes serveur absents du client
 * (Welcome perdu, nouveau device, etc.) et supprime les groupes locaux
 * absents du serveur après une période de grâce.
 *
 * IMPORTANT : l'identifiant unique est le couple (userId, deviceId).
 * Un même userId peut avoir plusieurs devices — ne jamais utiliser userId
 * seul pour identifier un participant ou un leaf node.
 */
export async function discoverMissingGroups(params: {
  mlsService: IMlsService;
  userId: string;
  pin: string;
  conversations: Map<string, Conversation>;
  saveConversation?: (key: string) => Promise<void>;
  deleteConversation?: (key: string) => Promise<void>;
  log: (msg: string) => void;
}) {
  const { mlsService, userId, conversations, saveConversation, deleteConversation, log } = params;

  // ── Phase 1: Create placeholders for server groups not present locally ────

  let serverGroups: {
    groupId: string;
    name: string;
    isGroup: boolean;
    successorId?: string | null;
    deletedAt?: string | null;
  }[] = [];
  let serverFetchSucceeded = false;
  try {
    serverGroups = await mlsService.getUserGroups(userId);
    serverFetchSucceeded = true;
  } catch {
    // Continue to Phase 2 even if server fetch fails — there may be pending placeholders
  }

  // Some backends can transiently return duplicates; keep first occurrence by groupId.
  const uniqueServerGroups = Array.from(new Map(serverGroups.map((g) => [g.groupId, g])).values());

  // Active groups only: exclude soft-deleted (replaced by a successor).
  // Soft-deleted groups still exist on the server for recovery routing but should not
  // be created as local placeholders — checkGroupSuccessors handles the migration.
  const activeServerGroups = uniqueServerGroups.filter((g) => !g.deletedAt);

  // ── Orphan cleanup: delete local groups absent from server ────────────────
  // Only when the server fetch succeeded (avoid deleting on transient network errors).
  // Skip channel conversations (keyed as `channel_*`) — they use a separate system.
  // Grace period: a group must be consistently absent for >60 s before deletion
  // to guard against slow server responses during group creation.
  const ORPHAN_GRACE_MS = 60_000;
  if (serverFetchSucceeded) {
    // Use the full set (including deleted groups) so soft-deleted entries don't trigger
    // the orphan grace-period logic — checkGroupSuccessors handles their cleanup.
    const serverGroupIds = new Set(uniqueServerGroups.map((g) => g.groupId));
    for (const [key, convo] of conversations.entries()) {
      if (key.startsWith('channel_')) continue;

      // Belt-and-suspenders: if this group was already migrated (successor exists locally),
      // clean up the stale entry here rather than waiting for checkGroupSuccessors.
      const serverEntry = uniqueServerGroups.find((g) => g.groupId === convo.id);
      if (serverEntry?.successorId && conversations.has(serverEntry.successorId)) {
        log(
          `[DISCOVERY] Groupe "${convo.name || convo.id}" déjà migré vers ${serverEntry.successorId} — nettoyage`
        );
        localStorage.removeItem(`discovery_absent:${convo.id}`);
        try {
          mlsService.forgetGroup(convo.id, 0);
        } catch {
          /* non-blocking */
        }
        conversations.delete(key);
        if (deleteConversation) await deleteConversation(key).catch(() => {});
        continue;
      }

      if (!serverGroupIds.has(convo.id)) {
        const absentKey = `discovery_absent:${convo.id}`;
        const absentSince = parseInt(localStorage.getItem(absentKey) ?? '0', 10);
        if (!absentSince) {
          localStorage.setItem(absentKey, String(Date.now()));
          log(
            `[DISCOVERY] Groupe local "${convo.name || convo.id}" absent du serveur — grâce 60 s`
          );
          continue;
        }
        if (Date.now() - absentSince < ORPHAN_GRACE_MS) {
          log(
            `[DISCOVERY] Groupe "${convo.name || convo.id}" absent depuis ${Math.round((Date.now() - absentSince) / 1000)}s — en attente`
          );
          continue;
        }
        log(
          `[DISCOVERY] Groupe local "${convo.name || convo.id}" absent du serveur — suppression locale`
        );
        localStorage.removeItem(absentKey);
        try {
          mlsService.forgetGroup(convo.id, 0);
        } catch {
          /* non-blocking */
        }
        localStorage.removeItem(`discovery_pending:${convo.id}`);
        conversations.delete(key);
        if (deleteConversation) {
          await deleteConversation(key).catch(() => {});
        }
      } else {
        // Group is present on server — clear any stale absence marker
        localStorage.removeItem(`discovery_absent:${convo.id}`);
      }
    }
  }

  // Include both ready and placeholder conversations to avoid recreating
  // the same pending entry on each login.
  // Only create placeholders for active groups — soft-deleted ones are handled by checkGroupSuccessors.
  const localGroupIds = new Set([...conversations.values()].map((c) => c.id));
  const missing = activeServerGroups.filter((g) => !localGroupIds.has(g.groupId));

  if (missing.length > 0) {
    log(
      `[DISCOVERY] ${missing.length} groupe(s) serveur absent(s) localement: ${missing.map((g) => g.name || g.groupId).join(', ')}`
    );
  }

  for (const g of missing) {
    if (conversations.has(g.groupId)) continue;

    const directPeer = !g.isGroup ? parseDirectPeerFromName(g.name || '', userId) : null;
    const displayName = directPeer || g.name || g.groupId;

    // Dédoublon local : si une conv directe avec ce même pair existe déjà
    // sous un groupId différent (doublon côté serveur), on ne crée pas un
    // second placeholder — on met juste à jour la clé si nécessaire.
    if (directPeer) {
      const alreadyLoaded = [...conversations.values()].find(
        (c) =>
          (c.conversationType ?? 'group') === 'direct' &&
          (c.directPeerId ?? c.contactName).toLowerCase() === directPeer
      );
      if (alreadyLoaded) {
        log(`[DISCOVERY] Doublon ignoré pour "${directPeer}" (existant: ${alreadyLoaded.id})`);
        continue;
      }
    }

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

  const isTauri = !!(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  if (isTauri) {
    // In Tauri (desktop/mobile) blob URLs and anchor downloads do not work.
    // Delegate file writing to the Rust side which saves to the Downloads
    // folder (desktop) or app data dir (mobile).

    const dialog = await import('@tauri-apps/plugin-dialog');
    const fs = await import('@tauri-apps/plugin-fs');

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
  } else {
    const url = URL.createObjectURL(
      new Blob([blob.buffer as ArrayBuffer], { type: 'application/octet-stream' })
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    log(`[OK] Sauvegarde exportée : ${filename}`);
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

/**
 * Traite un welcome_request reçu d'un device qui veut rejoindre un groupe.
 *
 * Cas nominal : addMember → sendWelcome → sendCommit.
 *
 * Cas "leaf déjà présent" : si le device était précédemment dans le groupe
 * (stale, crash, etc.), son leaf node est encore dans l'arbre MLS mais son
 * état local est perdu. Dans ce cas :
 *   1. removeMemberDevice (kick le leaf stale)
 *   2. kickStaleDevice (reset la membership serveur à pending)
 *   3. addMember avec un KeyPackage frais → sendWelcome → sendCommit
 *
 * IMPORTANT : l'identifiant unique est (userId, deviceId), pas userId seul.
 */
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
    groupId: requestedGroupId,
  } = params;

  // Vérifier qu'on a une conversation prête pour ce groupe.
  // Si le groupe a un successeur, rediriger vers celui-ci.
  let groupId = requestedGroupId;
  if (!conversations.get(groupId)?.isReady) {
    const meta = await mlsService.getGroupMeta(groupId).catch(() => null);
    if (meta?.successorId && conversations.get(meta.successorId)?.isReady) {
      log(`[WELCOME_REQ] Groupe ${groupId} → successeur ${meta.successorId}`);
      groupId = meta.successorId;
    } else {
      log(`[WELCOME_REQ] Pas de conversation prête pour ${groupId} — skip`);
      return;
    }
  }

  // Guard in-process : empêche deux traitements simultanés du même groupe
  // dans le même onglet (les retries rapides arrivent avant la fin du premier)
  if (welcomeRequestInProgress.has(groupId)) {
    log(`[WELCOME_REQ] Déjà en cours pour ${groupId} — skip`);
    return;
  }
  welcomeRequestInProgress.add(groupId);

  // Acquérir le verrou distribué pour éviter les races avec
  // processPendingInvitations sur un autre device du même groupe
  const lockAcquired = await mlsService.acquireAddLock(groupId, 15_000).catch(() => false);
  if (!lockAcquired) {
    log(`[WELCOME_REQ] Verrou occupé pour ${groupId} — autre device en cours, skip`);
    welcomeRequestInProgress.delete(groupId);
    return;
  }

  try {
    // Récupérer le KeyPackage frais du device demandeur
    const devices = await mlsService.fetchUserDevices(requesterUserId);
    const targetDevice = devices.find((d) => d.deviceId === requesterDeviceId);
    if (!targetDevice) {
      log(`[WELCOME_REQ] KeyPackage introuvable pour ${requesterDeviceId} — skip`);
      return;
    }

    // ── Vérifier si le leaf du device est déjà dans l'arbre MLS ────────
    // Si oui, il faut d'abord le retirer (removeMemberDevice) avant de le
    // ré-ajouter. Sinon addMember échouerait avec DuplicateSignature.
    // C'est le cas typique d'un device stale qui a envoyé un welcome_request
    // après avoir perdu son état local.
    try {
      const currentMembers = await mlsService.getGroupMembers(groupId);
      const deviceIdentity = `${requesterUserId}:${requesterDeviceId}`;
      if (currentMembers.some((m) => m.deviceId === requesterDeviceId)) {
        log(
          `[WELCOME_REQ] ${requesterDeviceId} déjà dans l'arbre MLS — kick du leaf stale avant ré-ajout`
        );
        // Retirer le leaf stale de l'arbre MLS (remove commit)
        await mlsService.removeMemberDevice(groupId, [deviceIdentity]);
        // Remettre la membership serveur à "pending"
        await mlsService.kickStaleDevice(requesterDeviceId, requesterUserId, groupId);

        // Sauvegarder l'état MLS après le remove commit
        const stBytes = await mlsService.saveState(pin);
        await saveMlsState(userId, stBytes);

        // Court délai pour la propagation du commit de remove
        await new Promise((r) => setTimeout(r, 150));

        // Re-fetch le KeyPackage (peut avoir changé après le kick)
        const freshDevices = await mlsService.fetchUserDevices(requesterUserId);
        const freshDevice = freshDevices.find((d) => d.deviceId === requesterDeviceId);
        if (!freshDevice) {
          log(`[WELCOME_REQ] KeyPackage introuvable après kick pour ${requesterDeviceId} — skip`);
          return;
        }
        // Mettre à jour la référence pour l'ajout ci-dessous
        targetDevice.keyPackage = freshDevice.keyPackage;
      }
    } catch {
      // En cas d'erreur sur la vérification, on tente quand même l'ajout
    }

    // ── Ajouter le device au groupe MLS ────────────────────────────────
    const result = await mlsService.addMember(groupId, targetDevice.keyPackage);
    await mlsService.registerMember(groupId, requesterUserId);

    // Envoyer le Welcome au device demandeur
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

    // Sauvegarder l'état MLS avant le commit (crash-safety)
    const stBytes = await mlsService.saveState(pin);
    await saveMlsState(userId, stBytes);

    // Broadcaster le commit en excluant l'inviteur (self) et l'invité
    if (result.commit) {
      await mlsService.sendCommit(result.commit, groupId, [
        `${requesterUserId}:${requesterDeviceId}`,
      ]);
    }
  } catch (e) {
    const errStr = String(e);
    if (errStr.includes('DuplicateSignatur') || errStr.includes('already')) {
      // Le device est déjà dans l'arbre MLS — marquer comme welcome_received
      await mlsService
        .updateInvitationStatus(requesterDeviceId, requesterUserId, groupId, 'welcome_received')
        .catch(() => {});
    } else {
      log(`[WELCOME_REQ] Erreur pour ${requesterDeviceId}: ${errStr.slice(0, 100)}`);
    }
  } finally {
    await mlsService.releaseAddLock(groupId).catch(() => {});
    welcomeRequestInProgress.delete(groupId);
  }
}
