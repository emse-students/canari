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

export async function syncOwnDevicesToGroups(params: {
  mlsService: IMlsService;
  userId: string;
  pin: string;
  conversations: Map<string, Conversation>;
  log: (msg: string) => void;
}) {
  const { mlsService, userId, pin, conversations, log } = params;

  let allOwnDevices: { keyPackage: Uint8Array; deviceId: string }[];
  try {
    allOwnDevices = (await mlsService.fetchUserDevices(userId)).filter(
      (d) => d.deviceId !== mlsService.getDeviceId()
    );
  } catch (e) {
    log(`[SYNC] Erreur lors de la recuperation des appareils: ${e}`);
    return;
  }

  log(
    `[SYNC] Appareils distants trouves: ${allOwnDevices.length} (${allOwnDevices.map((d) => d.deviceId).join(', ')})`
  );

  // Ensure this device is registered as a member for all ready conversations.
  // Repairs server-side state when a Welcome was processed without registration
  // (e.g. pending welcome replayed by gateway, or older code without registration).
  const readyConvos = [...conversations.entries()].filter(([, c]) => c.isReady);
  const selfRegKey = `self_registered:${userId}:${mlsService.getDeviceId()}`;
  if (!localStorage.getItem(selfRegKey) && readyConvos.length > 0) {
    for (const [, convo] of readyConvos) {
      try {
        await mlsService.registerMember(convo.groupId, userId, mlsService.getDeviceId());
      } catch {
        /* ignore */
      }
    }
    localStorage.setItem(selfRegKey, '1');
  }

  if (allOwnDevices.length === 0) return;

  const cacheKey = `known_own_devices:${userId}`;
  let knownIds: Set<string>;
  try {
    knownIds = new Set(JSON.parse(localStorage.getItem(cacheKey) ?? '[]'));
  } catch {
    knownIds = new Set();
  }
  log(`[SYNC] Appareils deja connus en cache: ${knownIds.size} (${[...knownIds].join(', ')})`);

  const newDevices = allOwnDevices.filter((d) => !knownIds.has(d.deviceId));
  if (newDevices.length === 0) {
    log(`[SYNC] Aucun nouvel appareil a synchroniser.`);
    return;
  }

  log(`[SYNC] Nouveaux appareils detectes: ${newDevices.map((d) => d.deviceId).join(', ')}`);

  log(`[SYNC] Conversations pretes: ${readyConvos.length}/${conversations.size}`);
  if (conversations.size > 0 && readyConvos.length === 0) {
    const pending = [...conversations.values()]
      .filter((c) => !c.isReady)
      .map((c) => c.name || c.groupId)
      .slice(0, 5);
    log(
      `[SYNC][DIAG] Aucune conversation n'est prete. Placeholders en attente de Welcome: ${pending.join(', ') || 'n/a'}`
    );
  }

  let totalWelcomes = 0;

  // Process devices ONE AT A TIME with delays to avoid epoch race conditions.
  // Each device must fully receive and process their Welcome before we add the next device.
  for (const device of newDevices) {
    let deviceWelcomes = 0;
    let hadAttempt = false;
    let hadFailure = false;
    let pendingSkipped = 0;

    // Re-fetch the device's latest KeyPackage to avoid using stale data
    // (the device might have just published a new KeyPackage after reconnecting)
    let freshKeyPackage = device.keyPackage;
    try {
      const freshDevices = await mlsService.fetchUserDevices(userId);
      const freshDevice = freshDevices.find((d) => d.deviceId === device.deviceId);
      if (freshDevice) {
        freshKeyPackage = freshDevice.keyPackage;
        log(`[SYNC] KeyPackage rafraichi pour ${device.deviceId}`);
      }
    } catch {
      // Use the original KeyPackage if refresh fails
    }

    for (const [, convo] of conversations.entries()) {
      if (!convo.isReady) {
        pendingSkipped++;
        continue;
      }
      hadAttempt = true;

      // Check if device is already a member of this group (server-side)
      try {
        const members = await mlsService.getGroupMembers(convo.groupId);
        if (members.some((m) => m.deviceId === device.deviceId)) {
          log(`[SYNC] ${device.deviceId} deja membre de ${convo.groupId} (skip)`);
          continue;
        }
      } catch {
        // If member check fails, proceed with add attempt
      }

      try {
        const result = await mlsService.addMember(convo.groupId, freshKeyPackage);
        log(
          `[SYNC][DIAG] addMember ${convo.groupId} -> commit=${result.commit?.length ?? 0}B, welcome=${result.welcome?.length ?? 0}B, ratchetTree=${result.ratchetTree?.length ?? 0}B`
        );
        await mlsService.registerMember(convo.groupId, userId, device.deviceId);
        if (result.welcome) {
          await mlsService.sendWelcome(
            result.welcome,
            userId,
            convo.groupId,
            device.deviceId,
            result.ratchetTree
          );
          totalWelcomes++;
          deviceWelcomes++;
          log(`[SYNC] Welcome envoye a ${device.deviceId} pour groupe ${convo.groupId}`);
        } else {
          log(
            `[SYNC][DIAG] Aucun Welcome retourne par MLS pour ${device.deviceId} sur ${convo.groupId}.`
          );
        }
        if (result.commit) {
          await mlsService.sendCommit(result.commit, convo.groupId);
        } else {
          log(`[SYNC][DIAG] Aucun commit retourne par MLS pour ${convo.groupId}.`);
        }
        const stBytes = await mlsService.saveState(pin);
        localStorage.setItem('mls_autosave_' + userId, toHex(stBytes));

        // Small delay between groups to allow propagation
        await new Promise((r) => setTimeout(r, 100));
      } catch (e) {
        const errStr = String(e);
        // DuplicateSignatureKey means device is already in the MLS tree — not a real failure
        const isAlreadyMember = errStr.includes('DuplicateSignatur') || errStr.includes('already');
        if (isAlreadyMember) {
          log(
            `[SYNC][DIAG] ${device.deviceId} deja dans l'arbre MLS de ${convo.groupId} (${errStr.slice(0, 80)})`
          );
          // Ensure server-side membership is consistent with the MLS tree
          // (the device is in the tree but may be missing from Redis group:members)
          try {
            await mlsService.registerMember(convo.groupId, userId, device.deviceId);
          } catch {
            /* ignore registration errors */
          }
        } else if (errStr.includes('WrongEpoch')) {
          log(
            `[SYNC][DIAG] WrongEpoch lors de addMember ${device.deviceId} sur ${convo.groupId}: ${errStr.slice(0, 80)}`
          );
        } else {
          log(
            `[SYNC] Erreur ajout ${device.deviceId} au groupe ${convo.groupId}: ${errStr.slice(0, 100)}`
          );
        }
        if (!isAlreadyMember) {
          hadFailure = true;
        }
      }
    }

    if (pendingSkipped > 0 && !hadAttempt) {
      log(
        `[SYNC][DIAG] ${device.deviceId}: ${pendingSkipped} conversation(s) ignoree(s) car non pretes (Welcome manquant).`
      );
    }

    // Wait for the device to process their Welcomes before adding the next device
    // This helps avoid epoch race conditions where multiple commits happen before Welcomes are processed
    if (deviceWelcomes > 0) {
      log(`[SYNC] Attente propagation pour ${device.deviceId} (${deviceWelcomes} Welcome(s))...`);
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Cache the device only after at least one successful welcome, or when there
    // was nothing to sync at all. If all attempts failed, keep it uncached so a
    // later reconnect retries the repair automatically.
    const hasNoConversation = conversations.size === 0;
    const markKnown =
      deviceWelcomes > 0 || (hasNoConversation && !hadAttempt) || (hadAttempt && !hadFailure);
    if (markKnown) {
      knownIds.add(device.deviceId);
      localStorage.setItem(cacheKey, JSON.stringify([...knownIds]));
    } else {
      log(
        `[SYNC] Synchronisation partielle pour ${device.deviceId}; nouvelle tentative automatique au prochain reconnect.`
      );
    }
  }

  if (totalWelcomes > 0) {
    log(`[OK] ${totalWelcomes} Welcome(s) envoye(s) aux nouveaux appareils.`);
  } else if (readyConvos.length > 0 && newDevices.length > 0) {
    log(`[SYNC] Aucun Welcome envoye - verifier les etats des groupes.`);
  }
}

/** Force re-sync by clearing the known devices cache (Ctrl+Shift+S in dev UI) */
export function forceSyncReset(userId: string, log: (msg: string) => void) {
  const cacheKey = `known_own_devices:${userId}`;
  localStorage.removeItem(cacheKey);
  log(
    `[SYNC] Cache des appareils connus efface. Rechargez la page pour relancer la synchronisation.`
  );
}

/**
 * Discover groups this user belongs to on the server but doesn't have locally.
 * For each missing group, request a re-invitation from another online device by
 * fetching the group's members and asking a peer to re-send a Welcome.
 */
export async function discoverMissingGroups(params: {
  mlsService: IMlsService;
  userId: string;
  conversations: Map<string, Conversation>;
  saveConversation?: (key: string) => Promise<void>;
  log: (msg: string) => void;
}) {
  const { mlsService, userId, conversations, saveConversation, log } = params;

  let serverGroups: { groupId: string; name: string; isGroup: boolean }[];
  try {
    serverGroups = await mlsService.getUserGroups(userId);
  } catch {
    return;
  }
  if (serverGroups.length === 0) return;

  // Some backends can transiently return duplicates; keep first occurrence by groupId.
  const uniqueServerGroups = Array.from(new Map(serverGroups.map((g) => [g.groupId, g])).values());

  // Include both ready and placeholder conversations to avoid recreating
  // the same pending entry on each login.
  const localGroupIds = new Set([...conversations.values()].map((c) => c.groupId));
  const missing = uniqueServerGroups.filter((g) => !localGroupIds.has(g.groupId));
  if (missing.length === 0) return;

  log(
    `[DISCOVERY] ${missing.length} groupe(s) serveur absent(s) localement: ${missing.map((g) => g.name || g.groupId).join(', ')}`
  );

  // For each missing group, create a placeholder conversation so the user sees it.
  // The group will become functional once a Welcome is received (pending Welcome fetch
  // or another device re-adds this device).
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
    // Persist to DB so the placeholder survives page reloads
    if (saveConversation) {
      try {
        await saveConversation(key);
      } catch (e) {
        log(
          `[WARN] Echec persistance placeholder ${g.groupId}: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
    log(`[DISCOVERY] Groupe "${displayName}" ajouté en attente de Welcome.`);
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
