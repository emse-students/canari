import type { IMlsService } from '$lib/mlsService';
import type { IStorage } from '$lib/db';
import type { Conversation } from '$lib/types';
import { saveMlsState } from '$lib/utils/hex';
import type { SvelteMap } from 'svelte/reactivity';

/**
 * Dependencies shared by all recovery functions.
 * Mirrors the shape used by MessageHandlerDeps to allow easy reuse from connection.ts.
 */
export interface RecoveryDeps {
  mlsService: IMlsService;
  storage: IStorage | null;
  userId: string;
  pin: string;
  conversations: SvelteMap<string, Conversation>;
  /** Returns the currently selected conversation key, or null. */
  getSelectedContact: () => string | null;
  /** Sets the selected conversation key. */
  setSelectedContact: (id: string | null) => void;
  /** Persist a conversation to the local DB. */
  saveConversation: (key: string) => Promise<void>;
  /** Delete a conversation from the local DB (optional — skipped if not provided). */
  deleteConversation?: (key: string) => Promise<void>;
  log: (msg: string) => void;
}

/**
 * Orchestrates the full recovery flow for a dead MLS group.
 *
 * Algorithm:
 * 1. Check server state — if a successor is already set, skip creation and go straight to migration.
 * 2. Create a candidate successor group on the server and locally.
 * 3. Atomically claim the successor (CAS: first writer wins).
 *    - If we won: invite all old group members to the new group.
 *    - If we lost: delete our orphan candidate and use the real winner's group.
 * 4. Migrate the local conversation from the dead group to the successor.
 */
export async function recoverDeadGroup(deadGroupId: string, deps: RecoveryDeps): Promise<void> {
  const { mlsService, userId, pin, conversations, log } = deps;
  log(`[RECOVER] Lancement récupération groupe ${deadGroupId}`);

  // Step 1 — Check if another device already claimed a successor
  const meta = await mlsService.getGroupMeta(deadGroupId);
  let successorId: string | null = meta?.successorId ?? null;

  if (!successorId) {
    const deadConvo = conversations.get(deadGroupId);
    const groupName = deadConvo?.name ?? meta?.name ?? '';
    const isGroup = meta?.isGroup ?? true;

    // Step 2 — Create a candidate successor on the server
    let ourCandidateId: string | null = null;
    try {
      ourCandidateId = await mlsService.createRemoteGroup(groupName, isGroup);
      log(`[RECOVER] Candidat successeur créé : ${ourCandidateId}`);

      await mlsService.createGroup(ourCandidateId);
      await mlsService.registerMember(ourCandidateId, userId);
      const st = await mlsService.saveState(pin);
      await saveMlsState(userId, st);
    } catch (e) {
      log(`[RECOVER] Échec création candidat : ${String(e)}`);
      // Clean up partial state before re-throwing so the caller can escalate (Poison Pill).
      if (ourCandidateId) {
        await mlsService.deleteGroupOnServer(ourCandidateId).catch(() => {});
        mlsService.forgetGroup(ourCandidateId, 0);
      }
      throw e;
    }

    // Step 3 — Atomic CAS: first writer wins
    const claim = await mlsService.claimGroupSuccessor(deadGroupId, ourCandidateId);

    let weWon = false;
    if (!claim.claimed) {
      // Another device won — delete our orphan and use the real successor
      log(
        `[RECOVER] Course perdue — suppression orphelin ${ourCandidateId}, migration vers ${claim.successorId}`
      );
      await mlsService.deleteGroupOnServer(ourCandidateId).catch(() => {});
      mlsService.forgetGroup(ourCandidateId, 0);
      successorId = claim.successorId;
    } else {
      // We won — invite all members of the dead group to the successor
      weWon = true;
      successorId = ourCandidateId;
      log(`[RECOVER] Course gagnée — invitation membres dans ${successorId}`);
      await inviteOldMembers(deadGroupId, successorId, deps).catch((e) =>
        log(`[RECOVER] Erreur invitation membres : ${String(e)}`)
      );
    }

    // Step 4 — Migrate local conversation to successor
    if (successorId) {
      await migrateConversation(deadGroupId, successorId, deps);
      // The winner already has local MLS state (createGroup ran above) — mark ready immediately.
      if (weWon) {
        const newConvo = deps.conversations.get(successorId);
        if (newConvo) {
          deps.conversations.set(successorId, { ...newConvo, isReady: true });
          await deps.saveConversation(successorId).catch(() => {});
          log(`[RECOVER] Successeur "${newConvo.name}" marqué prêt.`);
        }
      }
    }
  } else {
    // Step 4 — successorId was already set server-side: just migrate locally
    await migrateConversation(deadGroupId, successorId, deps);
  }
}

/**
 * Fetches all member devices from the dead group and adds them to the successor group
 * in a single bulk MLS commit, then delivers a Welcome message to each device.
 */
async function inviteOldMembers(
  deadGroupId: string,
  successorId: string,
  deps: RecoveryDeps
): Promise<void> {
  const { mlsService, userId, pin, log } = deps;

  const members = await mlsService.getGroupMembers(deadGroupId);
  const otherUserIds = [...new Set(members.map((m) => m.userId).filter((id) => id !== userId))];

  if (otherUserIds.length === 0) {
    log('[RECOVER] Aucun autre membre à inviter.');
    return;
  }

  // Récupérer les appareils de tous les membres en parallèle puis construire
  // le mapping deviceId → userId en une passe.
  const devicesByUser = await Promise.all(
    otherUserIds.map((id) => mlsService.fetchUserDevices(id))
  );
  const allDevices: Array<{ keyPackage: Uint8Array; deviceId: string }> = [];
  const deviceToUser = new Map<string, string>();
  for (const [i, devices] of devicesByUser.entries()) {
    for (const d of devices) {
      allDevices.push(d);
      deviceToUser.set(d.deviceId, otherUserIds[i]);
    }
  }

  if (allDevices.length === 0) {
    log(
      '[RECOVER] Aucun appareil disponible pour les membres — ils recevront une invitation plus tard.'
    );
    return;
  }

  const lockAcquired = await mlsService.acquireAddLock(successorId).catch(() => false);
  if (!lockAcquired) {
    log(
      "[RECOVER] Impossible d'acquérir le verrou add-lock — abandon invitation (un autre appareil s'en charge)"
    );
    return;
  }
  try {
    const bulk = await mlsService.addMembersBulk(successorId, allDevices);
    log(`[RECOVER] addMembersBulk : ${bulk.addedDeviceIds.length} appareils ajoutés`);

    if (bulk.welcome) {
      for (const did of bulk.addedDeviceIds) {
        const memberId = deviceToUser.get(did);
        if (!memberId) continue;
        try {
          await mlsService.sendWelcome(bulk.welcome, memberId, successorId, did, bulk.ratchetTree);
          log(`[RECOVER] Welcome envoyé à ${memberId}:${did}`);
        } catch (e) {
          log(`[RECOVER] Erreur Welcome ${did} : ${String(e)}`);
        }
      }
    }

    const st = await mlsService.saveState(pin);
    await saveMlsState(userId, st);

    if (bulk.commit) {
      await mlsService.sendCommit(bulk.commit, successorId);
    }
  } finally {
    if (lockAcquired) await mlsService.releaseAddLock(successorId).catch(() => {});
  }
}

/**
 * Migrates a local conversation from a dead group to its successor:
 * - Copies all decrypted messages to the new groupId in local storage
 * - Remaps the conversation metadata to the successor
 * - Selects the successor if the dead group was the active conversation
 * - Deletes the dead group's local state
 *
 * NOTE: The message copy happens BEFORE deleting the old conversation
 * so the user retains history even if deletion fails.
 */
export async function migrateConversation(
  fromGroupId: string,
  toGroupId: string,
  deps: RecoveryDeps
): Promise<void> {
  const {
    mlsService,
    storage,
    pin,
    conversations,
    getSelectedContact,
    setSelectedContact,
    saveConversation,
    deleteConversation,
    log,
  } = deps;

  const oldConvo = conversations.get(fromGroupId);
  if (!oldConvo) {
    log(`[MIGRATE] Conversation source ${fromGroupId} introuvable — skip`);
    return;
  }

  // Court-circuit : si le groupe source a été purgé via drop_group (Poison Pill),
  // getEpoch lève une exception car le groupe n'est plus dans l'état WASM.
  // Dans ce cas la migration n'a plus de sens — on abandonne sans erreur.
  try {
    mlsService.getEpoch(fromGroupId);
  } catch {
    log(`[MIGRATE] Court-circuit : état MLS ${fromGroupId} purgé (drop_group) — migration annulée`);
    return;
  }

  log(`[MIGRATE] ${fromGroupId} → ${toGroupId} ("${oldConvo.name}")`);

  // If the target conversation already has local MLS state loaded (e.g. a re-invite
  // that assigned bc6bb12f as the successor of e304fcd8, while bc6bb12f was already
  // a ready local conversation), preserve its readiness rather than overwriting it.
  const existingToConvo = conversations.get(toGroupId);
  const localGroups = mlsService.getLocalGroups();
  const targetAlreadyReady = existingToConvo?.isReady === true || localGroups.includes(toGroupId);

  if (targetAlreadyReady) {
    log(`[MIGRATE] Cible ${toGroupId} déjà prête en local — isReady préservé`);
  }

  if (storage) {
    // Copy decrypted messages to the new conversationId
    try {
      const msgs = await storage.getMessages(fromGroupId, pin);
      if (msgs.length > 0) {
        const rekeyed = msgs.map((m) => ({ ...m, conversationId: toGroupId }));
        await storage.saveMessages(rekeyed, pin);
        log(`[MIGRATE] ${msgs.length} messages copiés vers ${toGroupId}`);
      }
    } catch (e) {
      log(`[MIGRATE] Erreur copie messages : ${String(e)}`);
    }

    // Persist the new conversation metadata before deleting the old one
    await storage
      .saveConversation({
        id: toGroupId,
        name: oldConvo.name,
        isReady: targetAlreadyReady,
        updatedAt: Date.now(),
      })
      .catch((e) => log(`[MIGRATE] Erreur sauvegarde conversation : ${String(e)}`));
  }

  // Update reactive map — merge with existing target state when it was already ready,
  // otherwise mark as not-ready until a Welcome arrives.
  const mergedConvo: Conversation = existingToConvo
    ? { ...existingToConvo, name: oldConvo.name, isReady: targetAlreadyReady }
    : { ...oldConvo, id: toGroupId, isReady: targetAlreadyReady };
  conversations.set(toGroupId, mergedConvo);

  // Keep the UI on the same conversation
  if (getSelectedContact() === fromGroupId) {
    setSelectedContact(toGroupId);
  }

  // Remove old entries AFTER the new ones are written
  conversations.delete(fromGroupId);
  if (deleteConversation) {
    await deleteConversation(fromGroupId).catch(() => {});
  }

  // Wipe the dead group's local MLS state
  try {
    mlsService.forgetGroup(fromGroupId, 0);
  } catch {
    // non-blocking
  }

  await saveConversation(toGroupId);
  log(`[MIGRATE] Terminé — "${oldConvo.name}" vit maintenant dans ${toGroupId}`);
}

/**
 * Periodic health check: queries the server for all groups the user belongs to and,
 * for any group that has a successor set, triggers a local migration.
 *
 * Also handles crash recovery: if this device owns local MLS state for a successor
 * at epoch 0, it won the CAS but crashed before inviteOldMembers completed.
 * The invite is retried so other members receive their Welcome.
 *
 * Called on WebSocket connect and every 5 minutes (leader tab only).
 */
export async function checkGroupSuccessors(deps: RecoveryDeps): Promise<void> {
  const { mlsService, userId, conversations, log } = deps;

  let serverGroups: {
    groupId: string;
    name: string;
    isGroup: boolean;
    successorId?: string | null;
  }[];
  try {
    serverGroups = await mlsService.getUserGroups(userId);
  } catch {
    return; // server unreachable — skip silently
  }

  for (const g of serverGroups) {
    if (!g.successorId) continue;
    const successorId = g.successorId;

    // ── Migration ────────────────────────────────────────────────────────────
    if (conversations.has(g.groupId) && !conversations.has(successorId)) {
      // Not yet migrated on this device
      log(`[HEALTH] Successeur détecté ${g.groupId} → ${successorId} — migration`);
      await migrateConversation(g.groupId, successorId, deps).catch((e) =>
        log(`[HEALTH] Erreur migration : ${String(e)}`)
      );
    } else if (conversations.has(g.groupId)) {
      // Already migrated — remove the stale old entry
      log(`[HEALTH] ${g.groupId} déjà migré vers ${successorId} — nettoyage`);
      conversations.delete(g.groupId);
      if (deps.deleteConversation) await deps.deleteConversation(g.groupId).catch(() => {});
    }

    // ── Crash recovery ───────────────────────────────────────────────────────
    // If this device owns local MLS state for the successor at epoch 0, it won the
    // CAS but crashed before inviteOldMembers ran (createGroup advances to epoch 0,
    // addMembersBulk advances to epoch ≥ 1). Retry the invite.
    const localGroups = mlsService.getLocalGroups();
    if (localGroups.includes(successorId) && mlsService.getEpoch(successorId) === 0) {
      log(
        `[HEALTH] Successeur ${successorId} epoch=0 — ré-invitation post-crash depuis ${g.groupId}`
      );
      await inviteOldMembers(g.groupId, successorId, deps).catch((e) =>
        log(`[HEALTH] Erreur ré-invitation : ${String(e)}`)
      );
      // Mark ready: this device is the creator and now has a valid group state
      const convo = conversations.get(successorId);
      if (convo && !convo.isReady) {
        conversations.set(successorId, { ...convo, isReady: true });
        await deps.saveConversation(successorId).catch(() => {});
      }
    }
  }
}
