import type { IMlsService } from '$lib/mlsService';
import type { IStorage } from '$lib/db';
import type { Conversation } from '$lib/types';
import { persistMlsStateAfterMutation, warnSkippedKeyPackages } from '$lib/utils/chat/groupActions';
import { globalMessaging } from '$lib/stores/globalChatSingleton.svelte';
import type { SvelteMap } from 'svelte/reactivity';
import { encodeAppMessage, mkSystem } from '$lib/proto/codec';
import { requestReAdd } from '$lib/utils/chat/recovery';
import { findActiveDirectGroupForPeer } from '$lib/utils/chat/groupSyncEligibility';
import { isRawId } from '$lib/utils/chat/conversations';

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
 * Maps raw error messages from the MLS/network layer to user-friendly strings
 * suitable for display in the UI. Falls back to the raw message for unrecognised errors.
 */
function toUiDiscussionError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const lower = raw.toLowerCase();

  if (lower.includes('no registered device') || lower.includes('no active device')) {
    return 'The recipient does not yet have an active device.';
  }
  if (lower.includes('session expir') || lower.includes('401') || lower.includes('403')) {
    return 'Session expired or insufficient permissions. Please sign in and try again.';
  }
  if (lower.includes('failed to fetch') || lower.includes('network')) {
    return 'Messaging service unavailable. Check your network connection.';
  }
  if (lower.includes('cannot send the secure invitation')) {
    return raw;
  }
  if (lower.includes('already_member')) {
    return 'This member is already present locally; they will join the group via automatic sync.';
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
        `[RETRY] Network error for ${userId} (attempt ${attempt}/${attempts}): ${String(err).slice(0, 80)}`
      );
    }
    if (attempt < attempts) {
      log(
        `[RETRY] No devices found for ${userId} (attempt ${attempt}/${attempts}), retrying in ${delayMs / 1000}s...`
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
  if (duplicateGroup) return log(`Group "${groupDisplayName}" already exists.`);

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
    // Best-effort: a network error fetching OUR own device list must not abort group creation
    // (other devices recover via their own welcome_request). `[]` => create the group with
    // the current device only.
    const ownDevices = (await mlsService.fetchUserDevices(userId).catch(() => [])).filter(
      (d) => d.deviceId !== mlsService.getDeviceId()
    );
    log(
      `[GROUP] My other devices: ${ownDevices.length} (${ownDevices.map((d) => d.deviceId).join(', ')})`
    );

    if (ownDevices.length > 0) {
      const lockAcquired = await mlsService.acquireAddLock(groupId).catch(() => false);
      try {
        // Staged transaction (C7-A): exclude every candidate device from the commit broadcast (the
        // added subset receives the Welcome instead; skipped devices are not in the group anyway).
        const excludeIds = ownDevices.map((d) => `${userId}:${d.deviceId}`);
        const bulk = await mlsService.addMembersBulk(groupId, ownDevices, excludeIds);
        log(
          `[GROUP] addMembersBulk result: welcome=${!!bulk.welcome} (${bulk.welcome?.length ?? 0} bytes), added=${bulk.addedDeviceIds.length} (${bulk.addedDeviceIds.join(', ')})`
        );
        warnSkippedKeyPackages(bulk.skippedDeviceIds, groupId, '[GROUP]', log);

        if (bulk.welcome) {
          for (const did of bulk.addedDeviceIds) {
            try {
              log(`[GROUP] Sending Welcome to ${userId}:${did}...`);
              await mlsService.sendWelcome(bulk.welcome, userId, groupId, did, bulk.ratchetTree);
              log(`[GROUP] Welcome sent to ${did}`);
            } catch (e) {
              log(`[GROUP] Welcome failed for ${did}: ${e}`);
              console.error(`[GROUP] Welcome failed for ${did}:`, e);
            }
          }
        } else {
          log('[GROUP] No welcome in bulk result!');
          console.warn('[GROUP] addMembersBulk returned no welcome for own devices');
        }

        // Save MLS state after the merged commit (crash-safety).
        await persistMlsStateAfterMutation(mlsService, userId, pin, log);
      } catch (e) {
        log(`Error syncing own devices: ${e}`);
        console.error('[GROUP] Sync own devices failed:', e);
      } finally {
        if (lockAcquired) await mlsService.releaseAddLock(groupId).catch(() => {});
      }
    } else {
      // No other devices: still save state after createGroup.
      await persistMlsStateAfterMutation(mlsService, userId, pin, log);
    }

    conversations.set(conversationKey, {
      id: groupId,
      contactName: groupDisplayName,
      name: groupDisplayName, // preserve original casing for display
      messages: [],
      lifecycle: 'active',
      mlsStateHex: null,
      conversationType: 'group',
    });
    selectConversation(conversationKey);
    await saveConversation(conversationKey);
    log(`[OK] Group "${groupDisplayName}" created.`);
    console.log(`[GROUP] Group "${groupDisplayName}" created successfully (id=${groupId})`);
    // MLS commits from group setup can leave the catch-up overlay stuck on mobile if begin/end desync.
    queueMicrotask(() => {
      if (globalMessaging.isMessageCatchupActive) {
        globalMessaging.resetMessageCatchupState();
      }
    });
  } catch (e) {
    log(`Group creation error: ${toUiDiscussionError(e)}`);
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

  log(`Inviting ${targetUsers.length} member(s): ${targetUsers.join(', ')}...`);

  try {
    await mlsService.registerMember(conversation.id, userId);

    // Collect devices for ALL users
    const allDevices: any[] = [];
    const userMap = new Map<string, string>(); // deviceId -> userId

    for (const targetUser of targetUsers) {
      const devices = await fetchDevicesWithRetry(mlsService, targetUser, log);
      if (devices.length === 0) {
        log(`[WARN] Skipped: no devices found for ${targetUser}.`);
        console.warn(`[SYNC] No devices found for ${targetUser}, skipping`);
        continue;
      }
      devices.forEach((d: any) => {
        allDevices.push(d);
        userMap.set(d.deviceId, targetUser);
      });
    }

    if (allDevices.length === 0) {
      log('[ERROR] No devices found for any of the requested users.');
      console.error('[SYNC] No devices found for any requested user - aborting bulk add');
      return;
    }

    const lockAcquired = await mlsService.acquireAddLock(conversation.id).catch(() => false);
    if (!lockAcquired) {
      log(
        `[WARN] Add-lock busy for ${conversation.id} - invite cancelled (another device is in progress).`
      );
      console.warn(
        `[SYNC] Add-lock busy for ${conversation.id}, aborting to avoid concurrent commits`
      );
      return;
    }

    // Track delivery success per user. We only register server membership when a
    // Welcome has been successfully accepted by delivery service for that device.
    const deliveredUsers = new Set<string>();

    try {
      // Add all devices in one staged MLS commit (C7-A): exclude every candidate device from the
      // commit broadcast (the added subset receives the Welcome instead; skipped devices are not in
      // the group anyway). The stage -> validate -> merge -> broadcast runs inside addMembersBulk.
      const excludeIds = allDevices
        .map((d) => {
          const uid = userMap.get(d.deviceId);
          return uid ? `${uid}:${d.deviceId}` : null;
        })
        .filter((s): s is string => s !== null);
      const bulk = await mlsService.addMembersBulk(conversation.id, allDevices, excludeIds);
      warnSkippedKeyPackages(bulk.skippedDeviceIds, conversation.id, '[SYNC]', log);

      await persistMlsStateAfterMutation(mlsService, userId, pin, log);

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
            log(`[SYNC] Sending Welcome to ${tUser}:${did} for group ${conversation.id}...`);
            await mlsService.sendWelcome(
              bulk.welcome,
              tUser,
              conversation.id,
              did,
              bulk.ratchetTree
            );
            await mlsService.registerMember(conversation.id, tUser);
            deliveredUsers.add(tUser);
            log(`[SYNC] Welcome sent successfully to ${tUser}:${did}`);
          } catch (err) {
            log(
              `[WARN] Welcome not delivered to ${tUser}:${did} - ${
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

      log(
        `[OK] Added: ${targetUsers.join(', ')} (${bulk.addedDeviceIds.length} device(s)). (${deliveredUsers.size} user(s) delivered)`
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
        await persistMlsStateAfterMutation(mlsService, userId, pin, log);
      } catch (e) {
        console.warn('Failed to broadcast member addition:', e);
      }
    } else {
      log(
        '[WARN] No Welcome delivered: no member addition will be announced until delivery succeeds.'
      );
      console.warn('[SYNC] No Welcome delivered - member addition notification skipped');
    }
  } catch (e: any) {
    log(`Bulk invite error: ${toUiDiscussionError(e)}`);
    console.error('[SYNC] processBulkAddition failed:', e);
  }
}

/**
 * Core direct-conversation setup: acquires the add-lock, calls addMembersBulk,
 * delivers Welcomes and registers memberships per-device, saves state, then sends the commit.
 *
 * `contactDeviceIds` identifies which devices belong to the contact vs. the current user,
 * so that registerMember uses the correct owner for each device.
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
    // Staged transaction (C7-A): exclude every candidate device from the commit broadcast (the
    // added subset receives the Welcome instead). stage -> validate -> merge -> broadcast is
    // handled inside addMembersBulk.
    const excludeIds = allDevices.map((d) => {
      const owner = contactDeviceIds.has(d.deviceId) ? contact : userId;
      return `${owner}:${d.deviceId}`;
    });
    const bulk = await mlsService.addMembersBulk(groupId, allDevices, excludeIds);
    log(`[ADD] ${bulk.addedDeviceIds.length} device(s), welcome=${!!bulk.welcome}`);
    warnSkippedKeyPackages(bulk.skippedDeviceIds, groupId, '[ADD]', log);

    // registerMember is user-level (upsert GroupMember): one call per userId is enough.
    // Calling once per device generates N-1 redundant transactions for a multi-device user.
    const registeredOwners = new Set<string>();
    for (const did of bulk.addedDeviceIds) {
      const owner = contactDeviceIds.has(did) ? contact : userId;
      if (!registeredOwners.has(owner)) {
        registeredOwners.add(owner);
        await mlsService.registerMember(groupId, owner);
      }
    }

    if (bulk.welcome) {
      for (const did of bulk.addedDeviceIds) {
        const owner = contactDeviceIds.has(did) ? contact : userId;
        try {
          await mlsService.sendWelcome(bulk.welcome, owner, groupId, did, bulk.ratchetTree);
          log(`[ADD] Welcome → ${owner}:${did} ✓`);
        } catch (e) {
          log(
            `[ADD] Welcome failed → ${owner}:${did}: ${e instanceof Error ? e.message : String(e)}`
          );
          console.warn(
            `[ADD] sendWelcome failed for ${owner}:${did}:`,
            e instanceof Error ? e.message : e
          );
        }
      }
    } else {
      log('[ADD] addMembersBulk returned welcome=null');
      console.warn('[ADD] addMembersBulk returned no welcome');
    }

    // Save MLS state after the merged commit (crash-safety).
    await persistMlsStateAfterMutation(mlsService, userId, pin, log);
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
    const [existingKey, existingConvo] = existingDirect;
    if (existingConvo.lifecycle === 'active') {
      selectConversation(existingKey);
      return;
    }
    // Conversation exists locally but MLS state is missing (e.g. backup on another device).
    // Fall through to the server check so we attempt repair below.
  }

  // Check server-side: a direct group might exist but not be loaded locally yet
  // (e.g. after state clear, backup import, or another device created it first).
  // Names can be "alice::bob" or "bob::alice" - check both orderings.
  try {
    const serverGroups = await mlsService.getUserGroups(userId);
    const key = findActiveDirectGroupForPeer(serverGroups, userId, contact);
    if (key) {
      log(`[1v1] Existing server group found (${key}) - loading without re-creation.`);

      const ensureDirectConvo = async (convoKey: string, ready: boolean) => {
        const existing = conversations.get(convoKey);
        const base: Conversation = {
          id: convoKey,
          contactName: contact,
          name: contact,
          messages: existing?.messages ?? [],
          lifecycle: ready ? 'active' : 'pending',
          mlsStateHex: null,
          conversationType: 'direct',
          directPeerId: contact,
        };
        if (existing) {
          const fixName = isRawId(existing.name) || isRawId(existing.contactName ?? '');
          conversations.set(convoKey, {
            ...existing,
            ...base,
            name: fixName ? contact : existing.name,
            contactName: fixName ? contact : existing.contactName,
            directPeerId: contact,
            // Explicitly opening a direct conversation exits the `removed` state if the
            // group is active server-side; otherwise preserve the existing state (pending).
            lifecycle: ready || existing.lifecycle === 'active' ? 'active' : 'pending',
          });
        } else {
          conversations.set(convoKey, base);
        }
        if (saveConversation) await saveConversation(convoKey);
      };

      // If local MLS state exists for this group, just ensure the conversation is ready.
      if (mlsService.getLocalGroups().includes(key)) {
        await ensureDirectConvo(key, true);
        selectConversation(key);
        return;
      }

      // MLS state missing locally - recover via the external-join / welcome_request seam.
      log(`[1v1] MLS state missing for ${key} - triggering recovery...`);
      await ensureDirectConvo(key, false);
      try {
        await requestReAdd(key, {
          mlsService,
          storage: deps.storage,
          userId,
          pin: deps.pin,
          conversations,
          getSelectedContact: () => key,
          setSelectedContact: (id: string | null) => {
            if (id) selectConversation(id);
          },
          saveConversation,
          log,
        });
      } catch {
        if (conversations.has(key)) selectConversation(key);
      }
      return;
    }
  } catch (e) {
    // Non-blocking: continue with normal creation but log the error.
    console.warn(`[1v1] getUserGroups failed, risk of duplicate group:`, e);
  }

  // IMPORTANT: Check if contact is available BEFORE creating the group
  // This prevents orphaned groups on other devices if the contact isn't online
  log(`Checking availability of ${contact}...`);
  const contactDevices = await fetchDevicesWithRetry(mlsService, contact, log);
  if (contactDevices.length === 0) {
    log(
      `[ERROR] No devices found for ${contact}. The contact must sign in at least once to publish their KeyPackage.`
    );
    return;
  }

  const groupName = `${userId}::${contact}`;
  let groupId: string | undefined;
  try {
    groupId = await mlsService.createRemoteGroup(groupName, false); // false = 1-to-1 direct conversation
    console.log(`[DM] createRemoteGroup → groupId=${groupId}`);
    log(`[DM] Remote group created: ${groupId}`);
    const conversationKey = groupId;

    conversations.set(conversationKey, {
      id: groupId,
      contactName: contact,
      name: contact,
      messages: [],
      lifecycle: 'pending',
      mlsStateHex: null,
      conversationType: 'direct',
      directPeerId: contact,
    });
    selectConversation(conversationKey);

    await mlsService.createGroup(groupId);
    log(`[DM] Local MLS group created: ${groupId}`);
    await mlsService.registerMember(groupId, userId);
    log(`[DM] Server membership registered for ${userId}`);

    // Collect ALL devices (contact + own) for a single bulk add
    // Best-effort: a network error fetching our own device list must not abort conversation
    // creation (other devices recover via their own welcome_request). `[]` => create with
    // the current device only.
    const ownDevices = (await mlsService.fetchUserDevices(userId).catch(() => [])).filter(
      (d) => d.deviceId !== mlsService.getDeviceId()
    );
    const allDevices = [...contactDevices, ...ownDevices];
    const contactDeviceIds = new Set(contactDevices.map((d) => d.deviceId));
    log(
      `[DM] Devices to add: ${allDevices.length} (contact=${contactDevices.length}, own=${ownDevices.length})`
    );
    console.log(
      `[DM] allDevices:`,
      allDevices.map((d) => d.deviceId)
    );

    await performDirectAdd(groupId, allDevices, contactDeviceIds, contact, deps);

    const convo = conversations.get(conversationKey)!;
    conversations.set(conversationKey, { ...convo, lifecycle: 'active' });
    saveConversation(conversationKey);
    log(`[OK] Secure channel established with ${contact}.`);
    console.log(`[DM] 1v1 conversation with ${contact} ready (groupId=${groupId})`);
  } catch (_e: unknown) {
    const msg = _e instanceof Error ? _e.message : String(_e);
    log(`Creation error: ${toUiDiscussionError(msg)}`);
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
