import type { IMlsService } from '$lib/mlsService';
import type { IStorage } from '$lib/db';
import type { Conversation } from '$lib/types';
import { toHex } from '$lib/utils/hex';
import type { SvelteMap } from 'svelte/reactivity';
import { encodeAppMessage, mkSystem } from '$lib/proto/codec';

interface GroupCreationDeps {
  mlsService: IMlsService;
  storage: IStorage | null;
  userId: string;
  pin: string;
  historyBaseUrl: string;
  conversations: SvelteMap<string, Conversation>;
  selectConversation: (name: string) => void;
  saveConversation: (contactName: string) => Promise<void>;
  log: (msg: string) => void;
}

function toUiDiscussionError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const lower = raw.toLowerCase();

  if (lower.includes('aucun appareil actif trouvé') || lower.includes('no registered device')) {
    return "Le destinataire ne possède pas encore d'appareil actif.";
  }
  if (lower.includes('session expir') || lower.includes('401') || lower.includes('403')) {
    return 'Session expirée ou droits insuffisants. Reconnectez-vous puis réessayez.';
  }
  if (lower.includes('failed to fetch') || lower.includes('network')) {
    return 'Service de messagerie indisponible. Vérifiez votre connexion réseau.';
  }
  if (lower.includes("impossible d'envoyer l'invitation sécurisée")) {
    return raw;
  }

  return raw;
}

async function fetchDevicesWithRetry(
  mlsService: IMlsService,
  userId: string,
  log: (msg: string) => void,
  attempts = 6,
  delayMs = 1500
) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const devices = await mlsService.fetchUserDevices(userId);
    if (devices.length > 0) return devices;
    if (attempt < attempts) {
      log(
        `[RETRY] Appareils introuvables pour ${userId} (tentative ${attempt}/${attempts}), nouvelle tentative dans ${delayMs / 1000}s...`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return [];
}

/**
 * Crée un nouveau groupe MLS multi-utilisateurs.
 * Ajoute automatiquement les autres appareils de l'utilisateur courant au groupe.
 */
export async function createNewGroup(name: string, deps: GroupCreationDeps): Promise<void> {
  const { mlsService, userId, pin, conversations, selectConversation, saveConversation, log } =
    deps;

  if (!name.trim()) return;
  const groupDisplayName = name.trim();
  const duplicateGroup = Array.from(conversations.values()).find(
    (c) =>
      (c.conversationType ?? 'group') === 'group' &&
      c.name.toLowerCase() === groupDisplayName.toLowerCase()
  );
  if (duplicateGroup) return log(`Groupe "${groupDisplayName}" existe déjà.`);

  const conversationKey = `grp_${crypto.randomUUID()}`;
  let groupId: string | undefined;

  try {
    groupId = await mlsService.createRemoteGroup(groupDisplayName, true); // true = multi-user group
    await mlsService.createGroup(groupId);
    await mlsService.registerMember(groupId, userId);

    // Add own other devices to the group — use a single bulk commit to avoid
    // epoch fragmentation (sequential addMember would create one commit per device,
    // causing WrongEpoch errors on already-joined devices).
    const ownDevices = (await mlsService.fetchUserDevices(userId)).filter(
      (d) => d.deviceId !== mlsService.getDeviceId()
    );
    log(
      `[GROUP] Mes autres appareils: ${ownDevices.length} (${ownDevices.map((d) => d.deviceId).join(', ')})`
    );

    if (ownDevices.length > 0) {
      const lockAcquired = await mlsService.acquireAddLock(groupId).catch(() => false);
      try {
        const bulk = await mlsService.addMembersBulk(groupId, ownDevices);
        log(
          `[GROUP] addMembersBulk result: welcome=${!!bulk.welcome} (${bulk.welcome?.length ?? 0} bytes), added=${bulk.addedDeviceIds.length} (${bulk.addedDeviceIds.join(', ')})`
        );

        await mlsService.registerMember(groupId, userId);

        if (bulk.welcome) {
          for (const did of bulk.addedDeviceIds) {
            try {
              log(`[GROUP] Envoi Welcome a ${userId}:${did}...`);
              await mlsService.sendWelcome(bulk.welcome, userId, groupId, did, bulk.ratchetTree);
              log(`[GROUP] Welcome envoye a ${did}`);
            } catch (e) {
              log(`[GROUP] Erreur Welcome ${did}: ${e}`);
            }
          }
        } else {
          log('[GROUP] PAS DE WELCOME dans le bulk!');
        }

        // Sauvegarder l'état MLS AVANT d'envoyer le commit au réseau.
        // En cas de crash entre le saveState et le sendCommit, l'état local
        // reste cohérent (post-addMember) et le commit peut être retenté.
        const stateBytes = await mlsService.saveState(pin);
        localStorage.setItem('mls_autosave_' + userId, toHex(stateBytes));

        if (bulk.commit) {
          await mlsService.sendCommit(bulk.commit, groupId);
        }
      } catch (e) {
        log(`Erreur synchro propres appareils: ${e}`);
      } finally {
        if (lockAcquired) await mlsService.releaseAddLock(groupId).catch(() => {});
      }
    } else {
      // Pas d'autres appareils : sauvegarder quand même après createGroup
      const stateBytes = await mlsService.saveState(pin);
      localStorage.setItem('mls_autosave_' + userId, toHex(stateBytes));
    }

    conversations.set(conversationKey, {
      contactName: groupDisplayName,
      name: groupDisplayName, // conserve la casse originale pour l'affichage
      groupId,
      messages: [],
      isReady: true,
      mlsStateHex: null,
      conversationType: 'group',
    });
    selectConversation(conversationKey);
    await saveConversation(conversationKey);
    log(`[OK] Groupe "${groupDisplayName}" cree.`);
  } catch (e) {
    log(`Erreur création groupe: ${toUiDiscussionError(e)}`);
    conversations.delete(conversationKey);

    // Best-effort: clean up the orphan remote group
    if (groupId) {
      try {
        await mlsService.deleteGroupOnServer(groupId);
      } catch {
        // Non-blocking
      }
    }
  }
}

// Helper function to process generic bulk addition logic
async function processBulkAddition(
  memberIds: string[],
  conversation: Conversation,
  deps: GroupCreationDeps
): Promise<void> {
  const { mlsService, userId, pin, log } = deps;
  if (memberIds.length === 0) return;

  const targetUsers = memberIds.map((m) => m.trim().toLowerCase()).filter(Boolean);
  if (targetUsers.length === 0) return;

  log(`Invitation de ${targetUsers.length} membres: ${targetUsers.join(', ')}...`);

  try {
    await mlsService.registerMember(conversation.groupId, userId);

    // Collect devices for ALL users
    const allDevices: any[] = [];
    const userMap = new Map<string, string>(); // deviceId -> userId

    for (const targetUser of targetUsers) {
      const devices = await fetchDevicesWithRetry(mlsService, targetUser, log);
      if (devices.length === 0) {
        log(`[WARN] Ignore: Appareils introuvables pour ${targetUser}.`);
        continue;
      }
      devices.forEach((d: any) => {
        allDevices.push(d);
        userMap.set(d.deviceId, targetUser);
      });
    }

    if (allDevices.length === 0) {
      log('[ERREUR] Aucun appareil trouve pour les utilisateurs demandes.');
      return;
    }

    const lockAcquired = await mlsService
      .acquireAddLock(conversation.groupId, 15_000)
      .catch(() => false);
    if (!lockAcquired) {
      log(`[WARN] Verrou occupé pour ${conversation.groupId}, tentative quand même...`);
    }

    // Track delivery success per user. We only register server membership when a
    // Welcome has been successfully accepted by delivery service for that device.
    const deliveredUsers = new Set<string>();

    try {
      // Add all devices in bulk (single MLS commit)
      const bulk = await mlsService.addMembersBulk(conversation.groupId, allDevices);

      const stateBytes = await mlsService.saveState(pin);
      localStorage.setItem('mls_autosave_' + userId, toHex(stateBytes));

      // Send welcomes per-device; do not abort all recipients on one failure.
      log(
        `[SYNC] bulk.welcome exists: ${!!bulk.welcome}, bulk.welcome length: ${bulk.welcome?.length ?? 0}`
      );
      log(`[SYNC] bulk.addedDeviceIds: ${bulk.addedDeviceIds.join(', ')}`);

      if (bulk.welcome) {
        for (const did of bulk.addedDeviceIds) {
          const tUser = userMap.get(did);
          if (!tUser) continue;
          try {
            log(`[SYNC] Envoi Welcome a ${tUser}:${did} pour groupe ${conversation.groupId}...`);
            await mlsService.sendWelcome(
              bulk.welcome,
              tUser,
              conversation.groupId,
              did,
              bulk.ratchetTree
            );
            await mlsService.registerMember(conversation.groupId, tUser);
            deliveredUsers.add(tUser);
            log(`[SYNC] Welcome envoye avec succes a ${tUser}:${did}`);
          } catch (err) {
            log(
              `[WARN] Welcome non livre pour ${tUser}:${did} - ${
                err instanceof Error ? err.message : String(err)
              }`
            );
          }
        }
      }

      if (bulk.commit) await mlsService.sendCommit(bulk.commit, conversation.groupId);

      log(
        `[OK] Ajoutes: ${targetUsers.join(', ')} (${bulk.addedDeviceIds.length} appareils). (${deliveredUsers.size} utilisateur(s) livrés)`
      );
    } finally {
      if (lockAcquired) await mlsService.releaseAddLock(conversation.groupId).catch(() => {});
    }

    // Broadcast member addition notification (one generic or multiple specific?)
    // Let's send one generic message listing all new users
    if (deliveredUsers.size > 0) {
      try {
        const controlMsg = encodeAppMessage(
          mkSystem('memberAdded', JSON.stringify({ newUsers: [...deliveredUsers] }))
        );
        await mlsService.sendMessage(conversation.groupId, controlMsg);
        const st = await mlsService.saveState(pin);
        localStorage.setItem('mls_autosave_' + userId, toHex(st));
      } catch (e) {
        console.warn('Failed to broadcast member addition:', e);
      }
    } else {
      log(
        '[WARN] Aucun Welcome livré: aucun membre ajouté ne sera annoncé tant que la livraison échoue.'
      );
    }
  } catch (e: any) {
    log(`Erreur invitation groupée: ${toUiDiscussionError(e)}`);
  }
}

/**
 * Invite un ou plusieurs membres dans le groupe actuellement sélectionné.
 */
export async function inviteMembersToGroup(
  memberIds: string[],
  conversation: Conversation,
  deps: GroupCreationDeps
): Promise<void> {
  return processBulkAddition(memberIds, conversation, deps);
}

/**
 * Invite un nouveau membre dans le groupe actuellement sélectionné.
 * Ajoute tous les appareils du membre cible et diffuse une notification.
 */
export async function inviteMemberToGroup(
  memberId: string,
  conversation: Conversation,
  deps: GroupCreationDeps
): Promise<void> {
  return inviteMembersToGroup([memberId], conversation, deps);
}

/**
 * Démarre une nouvelle conversation 1-to-1 avec un contact.
 * Crée un groupe à deux utilisateurs et invite le contact cible.
 */
export async function startNewConversation(
  contactName: string,
  deps: GroupCreationDeps
): Promise<void> {
  const { mlsService, userId, pin, conversations, selectConversation, saveConversation, log } =
    deps;

  const contact = contactName.trim().toLowerCase();
  if (!contact || contact === userId) return;

  const existingDirect = Array.from(conversations.entries()).find(([, convo]) => {
    if ((convo.conversationType ?? 'group') !== 'direct') return false;
    return (convo.directPeerId ?? convo.contactName).toLowerCase() === contact;
  });

  if (existingDirect) {
    selectConversation(existingDirect[0]);
    return;
  }

  // IMPORTANT: Check if contact is available BEFORE creating the group
  // This prevents orphaned groups on other devices if the contact isn't online
  log(`Vérification de la disponibilité de ${contact}...`);
  const contactDevices = await fetchDevicesWithRetry(mlsService, contact, log);
  if (contactDevices.length === 0) {
    log(
      `[ERREUR] Appareils introuvables pour ${contact}. Le contact doit se connecter une première fois pour publier son KeyPackage.`
    );
    return;
  }

  const conversationKey = `dm_${crypto.randomUUID()}`;
  const groupName = `${userId}::${contact}`;
  let groupId: string | undefined;
  try {
    groupId = await mlsService.createRemoteGroup(groupName, false); // false = 1-to-1 direct conversation

    conversations.set(conversationKey, {
      contactName: contact,
      name: contact,
      groupId,
      messages: [],
      isReady: false,
      mlsStateHex: null,
      conversationType: 'direct',
      directPeerId: contact,
    });
    selectConversation(conversationKey);

    await mlsService.createGroup(groupId);
    await mlsService.registerMember(groupId, userId);

    // Collect ALL devices (contact + own) for a single bulk add
    const ownDevices = (await mlsService.fetchUserDevices(userId)).filter(
      (d) => d.deviceId !== mlsService.getDeviceId()
    );
    const allDevices = [...contactDevices, ...ownDevices];
    const contactDeviceIds = new Set(contactDevices.map((d) => d.deviceId));

    const lockAcquired = await mlsService.acquireAddLock(groupId).catch(() => false);
    try {
      const bulk = await mlsService.addMembersBulk(groupId, allDevices);

      for (const did of bulk.addedDeviceIds) {
        const owner = contactDeviceIds.has(did) ? contact : userId;
        await mlsService.registerMember(groupId, owner);
      }

      if (bulk.welcome) {
        for (const did of bulk.addedDeviceIds) {
          const owner = contactDeviceIds.has(did) ? contact : userId;
          try {
            await mlsService.sendWelcome(bulk.welcome, owner, groupId, did, bulk.ratchetTree);
          } catch (e) {
            log(
              `[DM] Welcome echoue ${owner}:${did}: ${e instanceof Error ? e.message : String(e)}`
            );
          }
        }
      }

      // Sauvegarder AVANT sendCommit (crash-safety)
      const stBytes = await mlsService.saveState(pin);
      localStorage.setItem('mls_autosave_' + userId, toHex(stBytes));
      if (bulk.commit) await mlsService.sendCommit(bulk.commit, groupId);
    } finally {
      if (lockAcquired) await mlsService.releaseAddLock(groupId).catch(() => {});
    }

    const convo = conversations.get(conversationKey)!;
    conversations.set(conversationKey, { ...convo, isReady: true });
    saveConversation(conversationKey);
    log(`[OK] Canal sécurisé avec ${contact}.`);
  } catch (_e: unknown) {
    const msg = _e instanceof Error ? _e.message : String(_e);
    log(`Erreur création: ${toUiDiscussionError(msg)}`);
    conversations.delete(conversationKey);

    // Clean up local MLS state (epoch may have advanced after addMembersBulk)
    if (groupId) {
      try {
        mlsService.forgetGroup(groupId, 0);
      } catch {
        // Non-blocking
      }
    }

    // Best-effort: clean up the orphan remote group to avoid server-side litter
    if (groupId) {
      try {
        await mlsService.deleteGroupOnServer(groupId);
      } catch {
        // Non-blocking: orphan will be cleaned up on next server-side GC
      }
    }
  }
}

export async function repairDirectConversation(
  conversationKey: string,
  deps: GroupCreationDeps
): Promise<boolean> {
  const { mlsService, userId, pin, conversations, saveConversation, log } = deps;
  const convo = conversations.get(conversationKey);
  if (!convo || convo.conversationType !== 'direct') return false;

  const contact = (convo.directPeerId ?? convo.contactName).toLowerCase();
  const groupName = `${userId}::${contact}`;

  // Check contact availability first
  log(`Vérification de la disponibilité de ${contact}...`);
  const devices = await fetchDevicesWithRetry(mlsService, contact, log, 3, 1000);
  if (devices.length === 0) {
    log(`Échec de la réparation : aucun appareil pour ${contact}`);
    return false;
  }

  let groupId: string | undefined;
  try {
    log(`Réparation automatique de la connexion avec ${contact}...`);
    groupId = await mlsService.createRemoteGroup(groupName, false); // false = 1-to-1 direct conversation

    await mlsService.createGroup(groupId);
    await mlsService.registerMember(groupId, userId);

    // Collect ALL devices (contact + own) for a single bulk add
    const ownDevices = (await mlsService.fetchUserDevices(userId)).filter(
      (d) => d.deviceId !== mlsService.getDeviceId()
    );
    const allDevices = [...devices, ...ownDevices];
    const contactDeviceIds = new Set(devices.map((d) => d.deviceId));

    const lockAcquired = await mlsService.acquireAddLock(groupId).catch(() => false);
    try {
      const bulk = await mlsService.addMembersBulk(groupId, allDevices);

      for (const did of bulk.addedDeviceIds) {
        const owner = contactDeviceIds.has(did) ? contact : userId;
        await mlsService.registerMember(groupId, owner);
      }

      if (bulk.welcome) {
        for (const did of bulk.addedDeviceIds) {
          const owner = contactDeviceIds.has(did) ? contact : userId;
          try {
            await mlsService.sendWelcome(bulk.welcome, owner, groupId, did, bulk.ratchetTree);
          } catch (e) {
            log(
              `[REPAIR] Welcome echoue ${owner}:${did}: ${e instanceof Error ? e.message : String(e)}`
            );
          }
        }
      }

      // Sauvegarder AVANT sendCommit (crash-safety)
      const stBytes = await mlsService.saveState(pin);
      localStorage.setItem('mls_autosave_' + userId, toHex(stBytes));
      if (bulk.commit) await mlsService.sendCommit(bulk.commit, groupId);
    } finally {
      if (lockAcquired) await mlsService.releaseAddLock(groupId).catch(() => {});
    }

    conversations.set(conversationKey, { ...convo, groupId, isReady: true });
    await saveConversation(conversationKey);
    log(`[OK] Connexion réparée avec ${contact}.`);
    return true;
  } catch (e) {
    log(`Erreur de réparation : ${toUiDiscussionError(e)}`);

    // Clean up local MLS state (epoch may have advanced after addMembersBulk)
    if (groupId) {
      try {
        mlsService.forgetGroup(groupId, 0);
      } catch {
        // Non-blocking
      }
    }

    // Best-effort: clean up the orphan remote group
    if (groupId) {
      try {
        await mlsService.deleteGroupOnServer(groupId);
      } catch {
        // Non-blocking
      }
    }
    return false;
  }
}
