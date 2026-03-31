import { exportBackup, importBackup } from '$lib/backup';
import { fromHex, toHex } from '$lib/utils/hex';
import type { IStorage } from '$lib/db';
import type { IMlsService } from '$lib/mlsService';
import type { Conversation } from '$lib/types';

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

  const readyConvos = [...conversations.entries()].filter(([, c]) => c.isReady);
  log(`[SYNC] Conversations pretes: ${readyConvos.length}/${conversations.size}`);

  let totalWelcomes = 0;

  for (const device of newDevices) {
    let deviceWelcomes = 0;
    let hadAttempt = false;
    let hadFailure = false;

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
      if (!convo.isReady) continue;
      hadAttempt = true;
      try {
        const result = await mlsService.addMember(convo.groupId, freshKeyPackage);
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
        }
        if (result.commit) {
          await mlsService.sendCommit(result.commit, convo.groupId);
        }
        const stBytes = await mlsService.saveState(pin);
        localStorage.setItem('mls_autosave_' + userId, toHex(stBytes));
      } catch {
        // Per-group failure is expected (deleted group, wrong epoch, etc.).
        hadFailure = true;
      }
    }

    // Cache the device only after at least one successful welcome, or when there
    // was nothing to sync at all. If all attempts failed, keep it uncached so a
    // later reconnect retries the repair automatically.
    const markKnown = deviceWelcomes > 0 || !hadAttempt || !hadFailure;
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

/** Force re-sync by clearing the known devices cache */
export function forceSyncReset(userId: string, log: (msg: string) => void) {
  const cacheKey = `known_own_devices:${userId}`;
  localStorage.removeItem(cacheKey);
  log(
    `[SYNC] Cache des appareils connus efface. Rechargez la page pour relancer la synchronisation.`
  );
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
