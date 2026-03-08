import type { IMlsService } from '$lib/mlsService';
import type { IStorage } from '$lib/db';
import type { Conversation } from '$lib/types';
import { toHex } from '$lib/utils/hex';
import type { SvelteMap } from 'svelte/reactivity';

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

/**
 * Crée un nouveau groupe MLS multi-utilisateurs.
 * Ajoute automatiquement les autres appareils de l'utilisateur courant au groupe.
 */
export async function createNewGroup(name: string, deps: GroupCreationDeps): Promise<void> {
  const {
    mlsService,
    userId,
    pin,
    conversations,
    selectConversation,
    saveConversation,
    log,
  } = deps;

  if (!name.trim()) return;
  const groupName = name.trim();
  if (conversations.has(groupName)) return log(`Groupe "${groupName}" existe déjà.`);

  try {
    const groupId = await mlsService.createRemoteGroup(groupName);
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
          await mlsService.sendWelcome(result.welcome, userId, groupId, device.deviceId);
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
      name: groupName,
      groupId,
      messages: [],
      isReady: true,
      mlsStateHex: null,
    });
    selectConversation(groupName);
    saveConversation(groupName);
    log(`✅ Groupe "${groupName}" créé!`);
  } catch (e) {
    log(`Erreur création groupe: ${e}`);
  }
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
  const { mlsService, userId, pin, historyBaseUrl, log } = deps;

  if (!memberId.trim()) return;
  const targetUser = memberId.trim().toLowerCase();

  log(`Invitation de ${targetUser}...`);
  try {
    await mlsService.registerMember(conversation.groupId, userId, mlsService.getDeviceId());
    const devices = await mlsService.fetchUserDevices(targetUser);
    if (devices.length === 0) return log(`❌ Aucun appareil trouvé pour ${targetUser}.`);

    // Add all devices in bulk
    const bulk = await mlsService.addMembersBulk(conversation.groupId, devices);

    for (const did of bulk.addedDeviceIds) {
      await mlsService.registerMember(conversation.groupId, targetUser, did);
    }

    const stateBytes = await mlsService.saveState(pin);
    localStorage.setItem('mls_autosave_' + userId, toHex(stateBytes));

    // Send Welcome messages
    if (bulk.welcome) {
      const welcomeB64 = btoa(
        Array.from(bulk.welcome)
          .map((b) => String.fromCharCode(b))
          .join('')
      );
      for (const did of bulk.addedDeviceIds) {
        await fetch(`${historyBaseUrl}/mls-api/welcome`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            targetDeviceId: did,
            targetUserId: targetUser,
            senderUserId: userId,
            welcomePayload: welcomeB64,
            groupId: conversation.groupId,
          }),
        });
      }
    }

    if (bulk.commit) await mlsService.sendCommit(bulk.commit, conversation.groupId);

    log(`✅ ${targetUser} invité (${bulk.addedDeviceIds.length}/${devices.length} appareils).`);

    // Broadcast member addition notification
    try {
      const controlMsg = JSON.stringify({ type: 'memberAdded', newUser: targetUser });
      await mlsService.sendMessage(conversation.groupId, controlMsg);
      const st = await mlsService.saveState(pin);
      localStorage.setItem('mls_autosave_' + userId, toHex(st));
    } catch (e) {
      console.warn('Failed to broadcast member addition:', e);
    }
  } catch (e) {
    log(`Erreur invitation: ${e}`);
  }
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
          await mlsService.sendWelcome(result.welcome, userId, groupId, device.deviceId);
        if (result.commit) await mlsService.sendCommit(result.commit, groupId);
      } catch {
        // Silently ignore errors in device sync
      }
    }

    const stBytes = await mlsService.saveState(pin);
    localStorage.setItem('mls_autosave_' + userId, toHex(stBytes));

    // Add target contact's devices
    const devices = await mlsService.fetchUserDevices(contact);
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
        for (const did of bulk.addedDeviceIds) {
          await fetch(`${historyBaseUrl}/mls-api/welcome`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              targetDeviceId: did,
              targetUserId: contact,
              senderUserId: userId,
              welcomePayload: welcomeB64,
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
      log(`❌ Appareils introuvables pour ${contact}.`);
      conversations.delete(contact);
    }
  } catch (_e: unknown) {
    const msg = _e instanceof Error ? _e.message : String(_e);
    log(`Erreur création: ${msg}`);
  }
}
