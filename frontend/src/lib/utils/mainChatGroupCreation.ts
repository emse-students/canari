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
        `⏳ Appareils introuvables pour ${userId} (tentative ${attempt}/${attempts}), nouvelle tentative dans ${delayMs / 1000}s...`
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
  const groupName = groupDisplayName.toLowerCase(); // clé normalisée utilisée dans la map et la DB
  if (conversations.has(groupName)) return log(`Groupe "${groupDisplayName}" existe déjà.`);

  try {
    const groupId = await mlsService.createRemoteGroup(groupDisplayName);
    await mlsService.createGroup(groupId);
    await mlsService.registerMember(groupId, userId, mlsService.getDeviceId());

    // Add own other devices to the group
    const ownDevices = (await mlsService.fetchUserDevices(userId)).filter(
      (d) => d.deviceId !== mlsService.getDeviceId()
    );
    for (const device of ownDevices) {
      try {
        const result = await mlsService.addMember(groupId, device.keyPackage);
        await mlsService.registerMember(groupId, userId, device.deviceId);
        if (result.welcome) {
          if (result.ratchetTree) {
            await mlsService.sendWelcome(
              result.welcome,
              userId,
              groupId,
              device.deviceId,
              result.ratchetTree
            );
          } else {
            await mlsService.sendWelcome(result.welcome, userId, groupId, device.deviceId);
          }
        }
        if (result.commit) {
          await mlsService.sendCommit(result.commit, groupId);
        }
      } catch (e) {
        log(`Erreur synchro propre appareil ${device.deviceId}: ${e}`);
      }
    }

    const stateBytes = await mlsService.saveState(pin);
    localStorage.setItem('mls_autosave_' + userId, toHex(stateBytes));

    conversations.set(groupName, {
      contactName: groupName,
      name: groupDisplayName, // conserve la casse originale pour l'affichage
      groupId,
      messages: [],
      isReady: true,
      mlsStateHex: null,
    });
    selectConversation(groupName);
    saveConversation(groupName);
    log(`✅ Groupe "${groupDisplayName}" créé!`);
  } catch (e) {
    log(`Erreur création groupe: ${e}`);
  }
}

// Helper function to process generic bulk addition logic
async function processBulkAddition(
  memberIds: string[],
  conversation: Conversation,
  deps: GroupCreationDeps
): Promise<void> {
  const { mlsService, userId, pin, historyBaseUrl, log } = deps;
  if (memberIds.length === 0) return;

  const targetUsers = memberIds.map((m) => m.trim().toLowerCase()).filter(Boolean);
  if (targetUsers.length === 0) return;

  log(`Invitation de ${targetUsers.length} membres: ${targetUsers.join(', ')}...`);

  try {
    await mlsService.registerMember(conversation.groupId, userId, mlsService.getDeviceId());

    // Collect devices for ALL users
    const allDevices: any[] = [];
    const userMap = new Map<string, string>(); // deviceId -> userId

    for (const targetUser of targetUsers) {
      const devices = await fetchDevicesWithRetry(mlsService, targetUser, log);
      if (devices.length === 0) {
        log(`⚠️ Ignoré: Appareils introuvables pour ${targetUser}.`);
        continue;
      }
      devices.forEach((d: any) => {
        allDevices.push(d);
        userMap.set(d.deviceId, targetUser);
      });
    }

    if (allDevices.length === 0) {
      return log('❌ Aucun appareil trouvé pour les utilisateurs demandés.');
    }

    // Add all devices in bulk (single MLS commit)
    const bulk = await mlsService.addMembersBulk(conversation.groupId, allDevices);

    // Register mapping for all added devices
    for (const did of bulk.addedDeviceIds) {
      const u = userMap.get(did);
      if (u) await mlsService.registerMember(conversation.groupId, u, did);
    }

    const stateBytes = await mlsService.saveState(pin);
    localStorage.setItem('mls_autosave_' + userId, toHex(stateBytes));

    // Send Welcomes
    if (bulk.welcome) {
      const welcomeB64 = btoa(
        Array.from(bulk.welcome)
          .map((b) => String.fromCharCode(b))
          .join('')
      );
      const ratchetTreeB64 = bulk.ratchetTree
        ? btoa(
            Array.from(bulk.ratchetTree)
              .map((b) => String.fromCharCode(b))
              .join('')
          )
        : undefined;

      for (const did of bulk.addedDeviceIds) {
        const tUser = userMap.get(did);
        if (tUser) {
          await fetch(`${historyBaseUrl}/mls-api/welcome`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              targetDeviceId: did,
              targetUserId: tUser,
              senderUserId: userId,
              welcomePayload: welcomeB64,
              ratchetTreePayload: ratchetTreeB64,
              groupId: conversation.groupId,
            }),
          });
        }
      }
    }

    if (bulk.commit) await mlsService.sendCommit(bulk.commit, conversation.groupId);

    log(`✅ Ajoutés: ${targetUsers.join(', ')} (${bulk.addedDeviceIds.length} appareils).`);

    // Broadcast member addition notification (one generic or multiple specific?)
    // Let's send one generic message listing all new users
    try {
      const controlMsg = encodeAppMessage(
        mkSystem('memberAdded', JSON.stringify({ newUsers: targetUsers }))
      );
      await mlsService.sendMessage(conversation.groupId, controlMsg);
      const st = await mlsService.saveState(pin);
      localStorage.setItem('mls_autosave_' + userId, toHex(st));
    } catch (e) {
      console.warn('Failed to broadcast member addition:', e);
    }
  } catch (e: any) {
    log(`Erreur invitation groupée: ${e?.message ?? e}`);
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
  const {
    mlsService,
    userId,
    pin,
    historyBaseUrl,
    conversations,
    selectConversation,
    saveConversation,
    log,
  } = deps;

  const contact = contactName.trim().toLowerCase();
  if (!contact || contact === userId) return;

  if (conversations.has(contact)) {
    selectConversation(contact);
    return;
  }

  const groupName = `${userId} & ${contact}`;
  try {
    const groupId = await mlsService.createRemoteGroup(groupName);

    conversations.set(contact, {
      contactName: contact,
      name: groupName,
      groupId,
      messages: [],
      isReady: false,
      mlsStateHex: null,
    });
    selectConversation(contact);

    await mlsService.createGroup(groupId);
    await mlsService.registerMember(groupId, userId, mlsService.getDeviceId());

    // Add own other devices
    const ownDevices = (await mlsService.fetchUserDevices(userId)).filter(
      (d) => d.deviceId !== mlsService.getDeviceId()
    );
    for (const device of ownDevices) {
      try {
        const result = await mlsService.addMember(groupId, device.keyPackage);
        await mlsService.registerMember(groupId, userId, device.deviceId);
        if (result.welcome)
          if (result.ratchetTree) {
            await mlsService.sendWelcome(
              result.welcome,
              userId,
              groupId,
              device.deviceId,
              result.ratchetTree
            );
          } else {
            await mlsService.sendWelcome(result.welcome, userId, groupId, device.deviceId);
          }
        if (result.commit) await mlsService.sendCommit(result.commit, groupId);
      } catch {
        // Silently ignore errors in device sync
      }
    }

    const stBytes = await mlsService.saveState(pin);
    localStorage.setItem('mls_autosave_' + userId, toHex(stBytes));

    // Add target contact's devices
    const devices = await fetchDevicesWithRetry(mlsService, contact, log);
    if (devices.length > 0) {
      const bulk = await mlsService.addMembersBulk(groupId, devices);

      for (const did of bulk.addedDeviceIds) {
        await mlsService.registerMember(groupId, contact, did);
      }

      const st2Bytes = await mlsService.saveState(pin);
      localStorage.setItem('mls_autosave_' + userId, toHex(st2Bytes));

      if (bulk.welcome) {
        const welcomeB64 = btoa(
          Array.from(bulk.welcome)
            .map((b) => String.fromCharCode(b))
            .join('')
        );
        const ratchetTreeB64 = bulk.ratchetTree
          ? btoa(
              Array.from(bulk.ratchetTree)
                .map((b) => String.fromCharCode(b))
                .join('')
            )
          : undefined;
        for (const did of bulk.addedDeviceIds) {
          await fetch(`${historyBaseUrl}/mls-api/welcome`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              targetDeviceId: did,
              targetUserId: contact,
              senderUserId: userId,
              welcomePayload: welcomeB64,
              ratchetTreePayload: ratchetTreeB64,
              groupId,
            }),
          });
        }
      }
      if (bulk.commit) await mlsService.sendCommit(bulk.commit, groupId);

      const convo = conversations.get(contact)!;
      conversations.set(contact, { ...convo, isReady: true });
      saveConversation(contact);
      log(`✅ Canal sécurisé avec ${contact}.`);
    } else {
      log(
        `❌ Appareils introuvables pour ${contact}. Le contact doit se connecter une première fois pour publier son KeyPackage.`
      );
      conversations.delete(contact);
    }
  } catch (_e: unknown) {
    const msg = _e instanceof Error ? _e.message : String(_e);
    log(`Erreur création: ${msg}`);
  }
}
