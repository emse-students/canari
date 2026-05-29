import type { IMlsService } from '$lib/mlsService';
import type { IStorage } from '$lib/db';
import type { Conversation } from '$lib/types';
import { saveMlsState } from '$lib/utils/hex';
import { globalMessaging } from '$lib/stores/globalChatSingleton.svelte';
import type { SvelteMap } from 'svelte/reactivity';
import { encodeAppMessage, mkSystem } from '$lib/proto/codec';

/** Dependencies injected into all group-creation and conversation-management helpers. */
interface GroupCreationDeps {
  mlsService: IMlsService;
  storage: IStorage | null;
  userId: string;
  pin: string;
  historyBaseUrl: string;
  /** Reactive map of all loaded conversations, keyed by MLS group ID. */
  conversations: SvelteMap<string, Conversation>;
  /** Callback to select a conversation in the UI. */
  selectConversation: (name: string) => void;
  /** Callback to persist a conversation to the local DB. */
  saveConversation: (contactName: string) => Promise<void>;
  log: (msg: string) => void;
}

/**
 * Maps raw error messages from the MLS/network layer to user-friendly French strings
 * suitable for display in the UI. Falls back to the raw message for unrecognised errors.
 */
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

/**
 * Fetches the list of registered devices for a user, retrying up to `attempts` times
 * before giving up. Returns an empty array if no devices are found after all retries.
 * Used before creating a group to confirm the peer is reachable.
 */
async function fetchDevicesWithRetry(
  mlsService: IMlsService,
  userId: string,
  log: (msg: string) => void,
  attempts = 6,
  delayMs = 1500
) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const devices = await mlsService.fetchUserDevices(userId);
      if (devices.length > 0) return devices;
    } catch (err) {
      log(
        `[RETRY] Erreur réseau pour ${userId} (tentative ${attempt}/${attempts}): ${String(err).slice(0, 80)}`
      );
    }
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
 * Creates a new named MLS multi-user group on the server, initialises the local
 * MLS state, and automatically adds all other devices belonging to the current user
 * in a single bulk commit to avoid epoch fragmentation.
 *
 * On failure the partially-created group is cleaned up server-side and the
 * conversation is removed from the reactive map.
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

  let groupId: string | undefined;
  let conversationKey: string | undefined;

  try {
    groupId = await mlsService.createRemoteGroup(groupDisplayName, true); // true = multi-user group
    conversationKey = groupId;
    await mlsService.createGroup(groupId);
    await mlsService.registerMember(groupId, userId);

    // Add own other devices to the group - use a single bulk commit to avoid
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
              console.error(`[GROUP] Welcome failed for ${did}:`, e);
            }
          }
        } else {
          log('[GROUP] PAS DE WELCOME dans le bulk!');
          console.warn('[GROUP] addMembersBulk returned no welcome for own devices');
        }

        // Sauvegarder l'état MLS AVANT d'envoyer le commit au réseau.
        // En cas de crash entre le saveState et le sendCommit, l'état local
        // reste cohérent (post-addMember) et le commit peut être retenté.
        const stateBytes = await mlsService.saveState(pin);
        await saveMlsState(userId, stateBytes);

        if (bulk.commit) {
          const excludeIds = bulk.addedDeviceIds.map((did) => `${userId}:${did}`);
          await mlsService.sendCommit(bulk.commit, groupId, excludeIds);
        }
      } catch (e) {
        log(`Erreur synchro propres appareils: ${e}`);
        console.error('[GROUP] Sync own devices failed:', e);
      } finally {
        if (lockAcquired) await mlsService.releaseAddLock(groupId).catch(() => {});
      }
    } else {
      // Pas d'autres appareils : sauvegarder quand même après createGroup
      const stateBytes = await mlsService.saveState(pin);
      await saveMlsState(userId, stateBytes);
    }

    conversations.set(conversationKey, {
      id: groupId,
      contactName: groupDisplayName,
      name: groupDisplayName, // conserve la casse originale pour l'affichage
      messages: [],
      isReady: true,
      mlsStateHex: null,
      conversationType: 'group',
    });
    selectConversation(conversationKey);
    await saveConversation(conversationKey);
    log(`[OK] Groupe "${groupDisplayName}" cree.`);
    console.log(`[GROUP] Group "${groupDisplayName}" created successfully (id=${groupId})`);
    // MLS commits from group setup can leave the catch-up overlay stuck on mobile if begin/end desync.
    queueMicrotask(() => {
      if (globalMessaging.isMessageCatchupActive) {
        globalMessaging.resetMessageCatchupState();
      }
    });
  } catch (e) {
    log(`Erreur création groupe: ${toUiDiscussionError(e)}`);
    console.error('[GROUP] createNewGroup failed:', e);
    globalMessaging.resetMessageCatchupState();
    if (conversationKey) conversations.delete(conversationKey);

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

/**
 * Core helper that collects all devices for the given user IDs, adds them to
 * the MLS group in a single bulk commit, delivers Welcome messages per-device,
 * and broadcasts a `memberAdded` system event to all existing members.
 *
 * Users whose devices cannot be fetched are skipped with a warning rather than
 * aborting the entire operation.
 */
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
    await mlsService.registerMember(conversation.id, userId);

    // Collect devices for ALL users
    const allDevices: any[] = [];
    const userMap = new Map<string, string>(); // deviceId -> userId

    for (const targetUser of targetUsers) {
      const devices = await fetchDevicesWithRetry(mlsService, targetUser, log);
      if (devices.length === 0) {
        log(`[WARN] Ignore: Appareils introuvables pour ${targetUser}.`);
        console.warn(`[SYNC] No devices found for ${targetUser}, skipping`);
        continue;
      }
      devices.forEach((d: any) => {
        allDevices.push(d);
        userMap.set(d.deviceId, targetUser);
      });
    }

    if (allDevices.length === 0) {
      log('[ERREUR] Aucun appareil trouve pour les utilisateurs demandes.');
      console.error('[SYNC] No devices found for any requested user - aborting bulk add');
      return;
    }

    const lockAcquired = await mlsService
      .acquireAddLock(conversation.id, 15_000)
      .catch(() => false);
    if (!lockAcquired) {
      log(`[WARN] Verrou occupé pour ${conversation.id}, tentative quand même...`);
      console.warn(`[SYNC] Add-lock busy for ${conversation.id}, proceeding anyway`);
    }

    // Track delivery success per user. We only register server membership when a
    // Welcome has been successfully accepted by delivery service for that device.
    const deliveredUsers = new Set<string>();

    try {
      // Add all devices in bulk (single MLS commit)
      const bulk = await mlsService.addMembersBulk(conversation.id, allDevices);

      const stateBytes = await mlsService.saveState(pin);
      await saveMlsState(userId, stateBytes);

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
            log(`[SYNC] Envoi Welcome a ${tUser}:${did} pour groupe ${conversation.id}...`);
            await mlsService.sendWelcome(
              bulk.welcome,
              tUser,
              conversation.id,
              did,
              bulk.ratchetTree
            );
            await mlsService.registerMember(conversation.id, tUser);
            deliveredUsers.add(tUser);
            log(`[SYNC] Welcome envoye avec succes a ${tUser}:${did}`);
          } catch (err) {
            log(
              `[WARN] Welcome non livre pour ${tUser}:${did} - ${
                err instanceof Error ? err.message : String(err)
              }`
            );
            console.warn(
              `[SYNC] sendWelcome failed for ${tUser}:${did}:`,
              err instanceof Error ? err.message : err
            );
          }
        }
      }

      if (bulk.commit) {
        const excludeIds = bulk.addedDeviceIds
          .map((did) => {
            const uid = userMap.get(did);
            return uid ? `${uid}:${did}` : null;
          })
          .filter((s): s is string => s !== null);
        await mlsService.sendCommit(bulk.commit, conversation.id, excludeIds);
      }

      log(
        `[OK] Ajoutes: ${targetUsers.join(', ')} (${bulk.addedDeviceIds.length} appareils). (${deliveredUsers.size} utilisateur(s) livrés)`
      );
      console.log(
        `[SYNC] Members added: ${targetUsers.join(', ')} (${deliveredUsers.size}/${targetUsers.length} delivered)`
      );
    } finally {
      if (lockAcquired) await mlsService.releaseAddLock(conversation.id).catch(() => {});
    }

    // Broadcast member addition notification (one generic or multiple specific?)
    // Let's send one generic message listing all new users
    if (deliveredUsers.size > 0) {
      try {
        const controlMsg = encodeAppMessage(
          mkSystem('memberAdded', JSON.stringify({ newUsers: [...deliveredUsers] }))
        );
        await mlsService.sendMessage(conversation.id, controlMsg);
        const st = await mlsService.saveState(pin);
        await saveMlsState(userId, st);
      } catch (e) {
        console.warn('Failed to broadcast member addition:', e);
      }
    } else {
      log(
        '[WARN] Aucun Welcome livré: aucun membre ajouté ne sera annoncé tant que la livraison échoue.'
      );
      console.warn('[SYNC] No Welcome delivered - member addition notification skipped');
    }
  } catch (e: any) {
    log(`Erreur invitation groupée: ${toUiDiscussionError(e)}`);
    console.error('[SYNC] processBulkAddition failed:', e);
  }
}

/**
 * Core direct-conversation setup: acquires the add-lock, calls addMembersBulk,
 * delivers Welcomes and registers memberships per-device, saves state, then sends the commit.
 *
 * `contactDeviceIds` identifies which devices belong to the contact vs. the current user,
 * so that registerMember uses the correct owner for each device.
 *
 * Shared by startNewConversation and repairDirectConversation - both do exactly this sequence.
 */

async function performDirectAdd(
  groupId: string,
  allDevices: any[],
  contactDeviceIds: Set<string>,
  contact: string,
  deps: Pick<GroupCreationDeps, 'mlsService' | 'userId' | 'pin' | 'log'>
): Promise<void> {
  const { mlsService, userId, pin, log } = deps;

  const lockAcquired = await mlsService.acquireAddLock(groupId).catch(() => false);
  try {
    const bulk = await mlsService.addMembersBulk(groupId, allDevices);
    log(
      `[ADD] ${bulk.addedDeviceIds.length} appareil(s), welcome=${!!bulk.welcome}, commit=${!!bulk.commit}`
    );

    for (const did of bulk.addedDeviceIds) {
      const owner = contactDeviceIds.has(did) ? contact : userId;
      await mlsService.registerMember(groupId, owner);
    }

    if (bulk.welcome) {
      for (const did of bulk.addedDeviceIds) {
        const owner = contactDeviceIds.has(did) ? contact : userId;
        try {
          await mlsService.sendWelcome(bulk.welcome, owner, groupId, did, bulk.ratchetTree);
          log(`[ADD] Welcome → ${owner}:${did} ✓`);
        } catch (e) {
          log(
            `[ADD] Welcome échoué → ${owner}:${did}: ${e instanceof Error ? e.message : String(e)}`
          );
          console.warn(
            `[ADD] sendWelcome failed for ${owner}:${did}:`,
            e instanceof Error ? e.message : e
          );
        }
      }
    } else {
      log('[ADD] addMembersBulk a retourné welcome=null');
      console.warn('[ADD] addMembersBulk returned no welcome');
    }

    // Sauvegarder AVANT sendCommit (crash-safety : l'état local doit survivre à un crash ici)
    const stBytes = await mlsService.saveState(pin);
    saveMlsState(userId, stBytes);

    if (bulk.commit) {
      const excludeIds = bulk.addedDeviceIds.map((did) => {
        const owner = contactDeviceIds.has(did) ? contact : userId;
        return `${owner}:${did}`;
      });
      await mlsService.sendCommit(bulk.commit, groupId, excludeIds);
      log(`[ADD] Commit envoyé (exclu: ${excludeIds.join(', ')})`);
    }
  } finally {
    if (lockAcquired) await mlsService.releaseAddLock(groupId).catch(() => {});
  }
}

/**
 * Adds one or more users to an existing MLS group by their Canari user IDs.
 * All devices belonging to each user are added in a single bulk MLS commit.
 */
export async function inviteMembersToGroup(
  memberIds: string[],
  conversation: Conversation,
  deps: GroupCreationDeps
): Promise<void> {
  return processBulkAddition(memberIds, conversation, deps);
}

/**
 * Convenience wrapper around `inviteMembersToGroup` for adding a single user.
 * Adds all devices of the target user and broadcasts a `memberAdded` notification.
 */
export async function inviteMemberToGroup(
  memberId: string,
  conversation: Conversation,
  deps: GroupCreationDeps
): Promise<void> {
  return inviteMembersToGroup([memberId], conversation, deps);
}

/**
 * Starts a new 1-to-1 encrypted direct conversation with `contactName`.
 *
 * Before creating anything the function checks whether a conversation already
 * exists locally or on the server (handles the case where another device already
 * created it). The contact's devices are also fetched upfront - if none are found
 * the function aborts without creating an orphaned group.
 *
 * All of the contact's devices plus the current user's other devices are added
 * in a single bulk MLS commit to keep epoch numbers contiguous.
 */
export async function startNewConversation(
  contactName: string,
  deps: GroupCreationDeps
): Promise<void> {
  const { mlsService, userId, conversations, selectConversation, saveConversation, log } = deps;

  const contact = contactName.trim().toLowerCase();
  if (!contact || contact === userId) return;

  // Check local map first
  const existingDirect = Array.from(conversations.entries()).find(([, convo]) => {
    if ((convo.conversationType ?? 'group') !== 'direct') return false;
    return (convo.directPeerId ?? convo.contactName).toLowerCase() === contact;
  });

  if (existingDirect) {
    selectConversation(existingDirect[0]);
    return;
  }

  // Check server-side: a direct group might exist but not be loaded locally yet
  // (e.g. after state clear, backup import, or another device created it first).
  // Names can be "alice::bob" or "bob::alice" - check both orderings.
  try {
    const serverGroups = await mlsService.getUserGroups(userId);
    const expectedNames = [
      `${userId.toLowerCase()}::${contact}`,
      `${contact}::${userId.toLowerCase()}`,
    ];
    const existing = serverGroups.find(
      (g) => !g.isGroup && expectedNames.includes((g.name ?? '').toLowerCase())
    );
    if (existing) {
      log(
        `[1v1] Groupe serveur existant trouvé (${existing.groupId}) - chargement sans recréation.`
      );
      const key = existing.groupId;
      if (!conversations.has(key)) {
        conversations.set(key, {
          id: key,
          contactName: contact,
          name: contact,
          messages: [],
          isReady: false,
          mlsStateHex: null,
          conversationType: 'direct',
          directPeerId: contact,
        });
        if (saveConversation) await saveConversation(key);
      }
      selectConversation(key);
      return;
    }
  } catch {
    // Non-bloquant : on continue avec la création normale
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

  const groupName = `${userId}::${contact}`;
  let groupId: string | undefined;
  try {
    groupId = await mlsService.createRemoteGroup(groupName, false); // false = 1-to-1 direct conversation
    console.log(`[DM] createRemoteGroup → groupId=${groupId}`);
    log(`[DM] Groupe distant créé: ${groupId}`);
    const conversationKey = groupId;

    conversations.set(conversationKey, {
      id: groupId,
      contactName: contact,
      name: contact,
      messages: [],
      isReady: false,
      mlsStateHex: null,
      conversationType: 'direct',
      directPeerId: contact,
    });
    selectConversation(conversationKey);

    await mlsService.createGroup(groupId);
    log(`[DM] Groupe MLS local créé: ${groupId}`);
    await mlsService.registerMember(groupId, userId);
    log(`[DM] Membership serveur enregistré pour ${userId}`);

    // Collect ALL devices (contact + own) for a single bulk add
    const ownDevices = (await mlsService.fetchUserDevices(userId)).filter(
      (d) => d.deviceId !== mlsService.getDeviceId()
    );
    const allDevices = [...contactDevices, ...ownDevices];
    const contactDeviceIds = new Set(contactDevices.map((d) => d.deviceId));
    log(
      `[DM] Appareils à ajouter: ${allDevices.length} (contact=${contactDevices.length}, propres=${ownDevices.length})`
    );
    console.log(
      `[DM] allDevices:`,
      allDevices.map((d) => d.deviceId)
    );

    await performDirectAdd(groupId, allDevices, contactDeviceIds, contact, deps);

    const convo = conversations.get(conversationKey)!;
    conversations.set(conversationKey, { ...convo, isReady: true });
    saveConversation(conversationKey);
    log(`[OK] Canal sécurisé avec ${contact}.`);
    console.log(`[DM] Conversation 1v1 avec ${contact} prête (groupId=${groupId})`);
  } catch (_e: unknown) {
    const msg = _e instanceof Error ? _e.message : String(_e);
    log(`Erreur création: ${toUiDiscussionError(msg)}`);
    if (groupId) conversations.delete(groupId);

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

/** Repairs a broken direct conversation by recreating its MLS group and re-inviting both parties. Returns true on success, false if the contact has no reachable devices. */
export async function repairDirectConversation(
  conversationKey: string,
  deps: GroupCreationDeps
): Promise<boolean> {
  const { mlsService, userId, conversations, saveConversation, log } = deps;
  const convo = conversations.get(conversationKey);
  if (!convo || convo.conversationType !== 'direct') return false;

  const contact = (convo.directPeerId ?? convo.contactName).toLowerCase();
  const groupName = `${userId}::${contact}`;

  // Check contact availability first
  log(`Vérification de la disponibilité de ${contact}...`);
  const devices = await fetchDevicesWithRetry(mlsService, contact, log, 3, 1000);
  if (devices.length === 0) {
    log(`Échec de la réparation : aucun appareil pour ${contact}`);
    console.error(`[REPAIR] No devices found for ${contact} - cannot repair`);
    return false;
  }

  let groupId: string | undefined;
  try {
    log(`Réparation automatique de la connexion avec ${contact}...`);
    console.log(`[REPAIR] Starting repair for direct conversation with ${contact}`);
    groupId = await mlsService.createRemoteGroup(groupName, false); // false = 1-to-1 direct conversation

    await mlsService.createGroup(groupId);
    await mlsService.registerMember(groupId, userId);

    // Collect ALL devices (contact + own) for a single bulk add
    const ownDevices = (await mlsService.fetchUserDevices(userId)).filter(
      (d) => d.deviceId !== mlsService.getDeviceId()
    );
    const allDevices = [...devices, ...ownDevices];
    const contactDeviceIds = new Set(devices.map((d) => d.deviceId));

    await performDirectAdd(groupId, allDevices, contactDeviceIds, contact, deps);

    // The new groupId becomes the new conversation key.
    // Remove the old entry and re-insert under the new key.
    conversations.delete(conversationKey);
    conversations.set(groupId, { ...convo, id: groupId, isReady: true });
    await saveConversation(groupId);
    log(`[OK] Connexion réparée avec ${contact}.`);
    console.log(`[REPAIR] Direct conversation with ${contact} repaired (newGroupId=${groupId})`);
    return true;
  } catch (e) {
    log(`Erreur de réparation : ${toUiDiscussionError(e)}`);
    console.error(`[REPAIR] repairDirectConversation failed for ${contact}:`, e);

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
