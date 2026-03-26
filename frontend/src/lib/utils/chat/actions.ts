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
  } catch {
    return;
  }
  if (allOwnDevices.length === 0) return;

  const cacheKey = `known_own_devices:${userId}`;
  let knownIds: Set<string>;
  try {
    knownIds = new Set(JSON.parse(localStorage.getItem(cacheKey) ?? '[]'));
  } catch {
    knownIds = new Set();
  }

  const newDevices = allOwnDevices.filter((d) => !knownIds.has(d.deviceId));
  if (newDevices.length === 0) return;

  log(`[SYNC] Nouvel appareil detecte : synchronisation en cours...`);
  let totalWelcomes = 0;

  for (const device of newDevices) {
    for (const [, convo] of conversations.entries()) {
      if (!convo.isReady) continue;
      try {
        const result = await mlsService.addMember(convo.groupId, device.keyPackage);
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
        }
        if (result.commit) {
          await mlsService.sendCommit(result.commit, convo.groupId);
        }
        const stBytes = await mlsService.saveState(pin);
        localStorage.setItem('mls_autosave_' + userId, toHex(stBytes));
      } catch {
        // Per-group failure is expected (deleted group, wrong epoch, etc.).
        // Don't block caching — we still mark the device as known so we
        // don't re-trigger a full sync-storm on every reconnect.
      }
    }
    // Always cache the device as "known" after attempting the sync.
    // If a specific group failed, it will be fixed separately (re-invite, etc.)
    // rather than by re-running the full sync loop on every connection.
    knownIds.add(device.deviceId);
    localStorage.setItem(cacheKey, JSON.stringify([...knownIds]));
  }

  if (totalWelcomes > 0) {
    log(`[OK] ${totalWelcomes} Welcome(s) envoye(s) aux nouveaux appareils.`);
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
