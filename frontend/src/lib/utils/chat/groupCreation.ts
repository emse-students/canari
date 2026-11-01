import type { IMlsService } from '$lib/mlsService';
import type { IStorage } from '$lib/db';
import type { Conversation } from '$lib/types';
import {
  deliverWelcomes,
  persistMlsStateAfterMutation,
  warnSkippedKeyPackages,
} from '$lib/utils/chat/groupActions';
import { globalMessaging } from '$lib/stores/globalChatSingleton.svelte';
import type { SvelteMap } from 'svelte/reactivity';
import { sendVisibleNotice, type NoticeWriter } from './visibleNotices';
import { requestReAdd } from '$lib/utils/chat/recovery';
import { captureGroupReadyAnnouncer } from './groupReadyAnnouncer';
import { findActiveDirectGroupForPeer } from '$lib/utils/chat/groupSyncEligibility';
import { buildConversationRow, isRawId } from '$lib/utils/chat/conversations';
import { isBlockedWith } from '$lib/users/blocks';
import { dropGroupState } from './dropGroupState';
import { logBestEffortGroupDeleteFailure } from './pendingGroupExits';
import { holdsGroupState } from './groupUsability';
import {
  CommitOutcomeUnknownError,
  FollowerTabCommitError,
  PreviousCommitUnresolvedError,
} from '$lib/mls-client/commitSubmission';
import type { OwedInvitation } from '$lib/mls-client/owedInvitations';
import { isCommitRaceRefusal } from '$lib/mls-client/CommitRefusedError';
import { AddAbortedError, addDevicesRebuildingOnRace } from './commitRace';
import {
  MemberNotAdmittedError,
  type GroupRosterAtGeneration,
} from '$lib/mls-client/mlsDeliveryApi';

/** Dependencies injected into all group-creation and conversation-management helpers. */
interface GroupCreationDeps {
  mlsService: IMlsService;
  storage: IStorage | null;
  userId: string;
  deviceKeyB64: string;
  historyBaseUrl: string;
  /** Reactive map of all loaded conversations, keyed by MLS group ID. */
  conversations: SvelteMap<string, Conversation>;
  /** Callback to select a conversation in the UI. */
  selectConversation: (name: string) => void;
  /** Callback to persist a conversation to the local DB. */
  saveConversation: (contactName: string) => Promise<void>;
  log: (msg: string) => void;
  /** When true, skip UI selection (e.g. background key distribution via DM). */
  silent?: boolean;
}

/** What an invitation needs beyond creation: where the inviter's own `memberAdded` notice goes. */
type InviteDeps = GroupCreationDeps & { addMessageToChat: NoticeWriter };

/**
 * WHY A CONVERSATION WAS NOT CREATED - A TYPE, DECIDED WHERE THE REFUSAL HAPPENS.
 *
 * Both creation paths used to end their failures in a `log()` line and return `void`, so the only
 * caller that could act on them - the creation modal - had nothing to act on: it closed on a
 * conversation that did not exist and left the member to work out why. The fix is not a message but
 * a discriminator: the screen that renders a refusal and the developer line that records it are two
 * different readers, and prose cannot serve both without one call site learning to parse the other's
 * sentences.
 *
 * Each member is a distinct thing the member can DO something about, which is the bar for adding
 * one. Anything the creation threw is `creation-failed` deliberately: the exception is already
 * logged with its detail, and splitting it further here would be inventing distinctions the screen
 * cannot act on.
 */
export type ConversationRefusal =
  /** A group of that name is already open on this device - the existing one is where to go. */
  | 'duplicate-group-name'
  /** A block stands between the two accounts, in one direction or the other. */
  | 'blocked'
  /** core-service could not be asked about blocks, so nothing may be concluded and nothing is. */
  | 'block-check-unavailable'
  /** The peer has never signed in, so there is no KeyPackage to add and no group to build. */
  | 'peer-has-no-device'
  /**
   * This tab is not the one that runs the device's MLS state, so it cannot commit
   * (`FollowerTabCommitError`): the member must do it in the main tab.
   */
  | 'follower-tab'
  /** Anything the creation threw. The log carries the detail; the screen cannot use it. */
  | 'creation-failed';

/**
 * The refusal a creation's failure is reported as - read from the error's TYPE, never its text.
 */
function creationRefusal(e: unknown): ConversationRefusal {
  return e instanceof FollowerTabCommitError ? 'follower-tab' : 'creation-failed';
}

/**
 * What a creation path answers.
 *
 * `key` is the conversation to open, and `null` means there was nothing to do at all - an empty
 * name, or the caller's own id. That is a success rather than a refusal: nothing failed and there is
 * nothing to tell anybody. Both are already unreachable from the modal, which refuses empty input
 * and excludes the current user; `null` exists so a programmatic caller cannot be handed a key that
 * is not there.
 */
export type ConversationOutcome =
  | { ok: true; key: string | null }
  | { ok: false; reason: ConversationRefusal };

/**
 * Fetches the list of registered devices for a user, retrying up to `attempts` times
 * before giving up. Returns an empty array if no devices are found after all retries.
 * Targets are always picked from the user autocomplete (they exist and have signed in),
 * so the retry only covers a transient network blip - keep it short: a long retry loop
 * here blocks the whole invite flow.
 */
async function fetchDevicesWithRetry(
  mlsService: IMlsService,
  userId: string,
  log: (msg: string) => void,
  attempts = 2,
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
 * conversation is removed from the reactive map, and the caller is told WHICH failure it was so the
 * creation modal can stay open and say so - see `ConversationOutcome`.
 */
export async function createNewGroup(
  name: string,
  deps: GroupCreationDeps
): Promise<ConversationOutcome> {
  const {
    mlsService,
    userId,
    deviceKeyB64,
    conversations,
    selectConversation,
    saveConversation,
    log,
  } = deps;

  if (!name.trim()) return { ok: true, key: null };
  const groupDisplayName = name.trim();
  const duplicateGroup = Array.from(conversations.values()).find(
    (c) =>
      (c.conversationType ?? 'group') === 'group' &&
      c.name.toLowerCase() === groupDisplayName.toLowerCase()
  );
  if (duplicateGroup) {
    log(`Group not created: one with this name already exists.`);
    return { ok: false, reason: 'duplicate-group-name' };
  }

  let groupId: string | undefined;
  let conversationKey: string | undefined;

  try {
    groupId = await mlsService.createRemoteGroup(groupDisplayName, true); // true = multi-user group
    conversationKey = groupId;

    // THE MEMBERSHIP IS REGISTERED BEFORE THE LOCAL GROUP EXISTS, AND THE ORDER IS AN INVARIANT.
    //
    // `registerMember` is what puts this user into `dm_group_members`, and that table is what
    // `GET /api/mls/users/:id/groups` answers from - the one list every sweep uses to decide
    // whether a local group still has anything to belong to. Creating the local MLS group first
    // opened a window in which the group EXISTS locally and CANNOT be named by the server list, so
    // a concurrent sweep saw precisely the shape a dead group has and destroyed it (see the note
    // in `initializeConnection`, and the P1 measured on 2026-08-30).
    //
    // Registering first makes the implication hold in one direction for ever: if a group is in
    // `getLocalGroups()`, the server already names it. There is no interval to get right and no
    // clock involved - the window is gone rather than narrowed.
    //
    // The reverse failure is strictly better and already handled: a membership whose local group
    // never got created leaves a server-side orphan, which the outer catch deletes.
    await mlsService.registerMember(groupId, userId);
    await mlsService.createGroup(groupId);

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
        // Staged transaction (C7-A), rebuilt on a lost race (`commitRace.ts`): exclude every
        // candidate device from the commit broadcast (the added subset receives the Welcome
        // instead; skipped devices are not in the group anyway). Own devices that joined by their
        // own external commit meanwhile already hold a leaf, and are not added twice.
        const raced = await addDevicesRebuildingOnRace(
          mlsService,
          groupId,
          userId,
          ownDevices.map((d) => ({ ...d, userId })),
          log
        );
        if (raced.kind === 'added') {
          const bulk = raced;
          log(
            `[GROUP] addMembersBulk result: welcome=${!!bulk.welcome} (${bulk.welcome?.length ?? 0} bytes), added=${bulk.addedDeviceIds.length} (${bulk.addedDeviceIds.join(', ')})`
          );
          warnSkippedKeyPackages(bulk.skipped, groupId, '[GROUP]', log);

          // All added devices belong to the current user; deliveries run in parallel.
          await deliverWelcomes({
            mlsService,
            groupId,
            bulk,
            ownerOf: () => userId,
            tag: '[GROUP]',
            log,
          });
        }

        // Save MLS state after the merged commit (crash-safety).
        await persistMlsStateAfterMutation(mlsService, userId, deviceKeyB64, log);
      } catch (e) {
        // A follower tab can commit nothing, so the group cannot be completed here at all.
        if (e instanceof FollowerTabCommitError) throw e;
        log(`Error syncing own devices: ${e}`);
        console.error('[GROUP] Sync own devices failed:', e);
      } finally {
        if (lockAcquired) await mlsService.releaseAddLock(groupId).catch(() => {});
      }
    } else {
      // No other devices: still save state after createGroup.
      await persistMlsStateAfterMutation(mlsService, userId, deviceKeyB64, log);
    }

    // A GROUP WITH NO LOCAL MLS STATE IS NOT A CREATED GROUP, AND MUST NEVER BE ANNOUNCED AS ONE.
    //
    // The member-sync block above catches deliberately: one device's Welcome failing is not a
    // reason to abort a group, and those devices recover through their own `welcome_request`. But
    // the same catch also swallowed the case where the group itself had ceased to exist locally,
    // and execution walked straight on to `[OK] Group created.` - 68 ms after the state was gone,
    // measured 2026-08-30. The user was shown a working conversation whose every member, the
    // creator included, was locked out for ever.
    //
    // THE CHECK IS A FACT, NOT AN ERROR MESSAGE. Classifying by the text of a caught exception
    // would make this the one call site that understands that prose; `getLocalGroups()` answers
    // the only question that matters here - does this device hold the state - and it answers false
    // exactly when something forgot the group. Failing here hands the outer catch a group to clean
    // up server-side, which is the correct outcome: no group at all beats an unusable one.
    if (!holdsGroupState(mlsService, groupId)) {
      throw new Error(
        `Local MLS state for ${groupId} disappeared during creation - refusing to present the group`
      );
    }

    conversations.set(
      conversationKey,
      buildConversationRow({
        id: groupId,
        lifecycle: 'active',
        identity: {
          conversationType: 'group',
          contactName: groupDisplayName,
          displayName: groupDisplayName, // preserve original casing for display
        },
        // The creation moment seeds the ordering of a conversation that holds only notices; the
        // first real message replaces it (conversationRecency). Not `startedAt`: that is the
        // server's write-once fact and a local clock would pre-empt it.
        lastMessageAt: Date.now(),
      })
    );
    selectConversation(conversationKey);
    await saveConversation(conversationKey);
    log(`[OK] Group ${groupId} created.`);
    console.log(`[GROUP] Group created successfully (id=${groupId})`);
    // MLS commits from group setup can leave the catch-up overlay stuck on mobile if begin/end desync.
    queueMicrotask(() => {
      if (globalMessaging.isMessageCatchupActive) {
        globalMessaging.resetMessageCatchupState();
      }
    });
    return { ok: true, key: conversationKey };
  } catch (e) {
    log(`Group creation error: ${String(e)}`);
    console.error('[GROUP] createNewGroup failed:', e);
    globalMessaging.resetMessageCatchupState();
    if (conversationKey) conversations.delete(conversationKey);

    // Best-effort: clean up the orphan remote group
    if (groupId) {
      try {
        await mlsService.deleteGroupOnServer(groupId);
      } catch (cleanupError) {
        // Non-blocking
        logBestEffortGroupDeleteFailure(groupId, cleanupError, 'failed group creation');
      }
    }
    return { ok: false, reason: creationRefusal(e) };
  }
}

/** Why an invitation added nobody - see {@link BulkAdditionOutcome}. */
export type BulkAdditionRefusal =
  /** No user id was named. */
  | 'nobody-named'
  /** A block stands between the inviter and every named user, or it could not be checked. */
  | 'nobody-reachable'
  /** No named user has a device to add. */
  | 'no-devices'
  /** Another device holds the group's add lock: nothing was staged, the invite can be retried. */
  | 'add-lock-busy'
  /** The add-lock request got no answer (transport error, non-2xx): nothing is known of another device. */
  | 'add-lock-unanswered'
  /** The commit added no device - every key package was skipped (logged per device). */
  | 'no-device-added'
  /**
   * The Add commit lost a race (`epoch_mismatch` / `concurrent_commit`) and no progress was proven,
   * so it was not rebuilt: nothing was added, the invite can be retried.
   */
  | 'commit-race-lost'
  /**
   * A person on the roster when the invitation began was taken off it by a concurrent Remove while
   * the Add was being rebuilt: the invitation stopped rather than undo that removal. Nothing added.
   */
  | 'removed-meanwhile'
  /**
   * The tree could not be confirmed at the server's epoch, so which invited devices already hold a
   * leaf is unknown: nothing was staged, the invite can be retried.
   */
  | 'tree-unconfirmed'
  /**
   * The Add commit got NO ANSWER: it is kept, with the invitation in its intent, and settled at the
   * next connection - merged if it landed, re-planned if it did not (`owedInvitations.ts`). Nothing
   * added YET, and nothing for the member to retry.
   */
  | 'outcome-unknown'
  /**
   * An EARLIER commit of the conversation is still unanswered, so this invitation staged nothing
   * (`PreviousCommitUnresolvedError`): nothing kept of it, the member retries once back online.
   */
  | 'previous-commit-unresolved'
  /** Something threw before the commit merged (logged). */
  | 'failed';

/**
 * What an invitation did, read by a caller that must not report success it did not have - the
 * answer to a join ask (`approveJoinRequest`) keeps the ask on screen unless its person was added.
 *
 * `added` means the Add COMMIT MERGED with at least one device of each user in `addedUsers`: they
 * are in the tree. A Welcome lost after that is the joiner's own recovery (`welcome_request`, now a
 * member's device), so it does not unmake the Add.
 */
export type BulkAdditionOutcome =
  | { kind: 'added'; addedUsers: string[] }
  | { kind: 'not-added'; reason: BulkAdditionRefusal };

/**
 * Core helper that collects all devices for the given user IDs, adds them to
 * the MLS group in a single bulk commit, delivers Welcome messages per-device,
 * and broadcasts a `memberAdded` system event to all existing members - writing the inviter's own
 * notice under the frame's id, since MLS never hands this device its own frame.
 *
 * Users whose devices cannot be fetched are skipped with a warning rather than
 * aborting the entire operation.
 *
 * NEVER THROWS, AND SAYS WHAT HAPPENED INSTEAD ({@link BulkAdditionOutcome}): every early return
 * and the catch-all name their reason, so a caller can tell an Add from a refusal.
 *
 * `resumed` is set only by {@link replanLostInvitation}: the same invitation, made again after its
 * kept commit did not land. `answering` only by a member's answer to a join ask: the ask it answers.
 *
 * A PERSON THE GATE REFUSED TO ADMIT (`admit_refused` - a Decline or a departure recorded after the
 * Add was decided, a block) is never given a leaf: the commit is rebuilt without them
 * (`addDevicesRebuildingOnRace`) and they are absent from `addedUsers`; when nobody is left, the
 * invite is `removed-meanwhile`. A member-add call that answers `MemberNotAdmittedError` after the
 * commit merged means the person departed since the commit: no Welcome, not announced, and the
 * departure's own Remove takes their leaf.
 */
async function processBulkAddition(
  memberIds: string[],
  conversation: Conversation,
  deps: InviteDeps,
  resumed?: ResumedInvitation,
  answering?: AnsweredJoinAsk
): Promise<BulkAdditionOutcome> {
  const { mlsService, userId, deviceKeyB64, log } = deps;
  const notAdded = (reason: BulkAdditionRefusal): BulkAdditionOutcome => ({
    kind: 'not-added',
    reason,
  });
  if (memberIds.length === 0) return notAdded('nobody-named');

  let targetUsers = memberIds.map((m) => m.trim().toLowerCase()).filter(Boolean);
  if (targetUsers.length === 0) return notAdded('nobody-named');

  log(`Inviting ${targetUsers.length} member(s): ${targetUsers.join(', ')}...`);

  // Whether this Add went out WITH a seat generation (see `rosterPremise`). Without one the server
  // cannot date the departures it checks, so its refusal is a client-side read failure and not a race.
  let seatGenerationCarried = false;

  // Same reason as the 1-to-1 path: the server's refusal at `addGroupMember` is authoritative, but
  // it lands after the Welcomes have gone out. Anyone a block stands between is dropped from the
  // batch here, and the rest of the invitation proceeds - one blocked person must not cancel an
  // invitation naming four others.
  const reachable: string[] = [];
  for (const target of targetUsers) {
    try {
      if (await isBlockedWith(target)) {
        log(`[INVITE] Skipped ${target}: a block stands between them and you.`);
        continue;
      }
      reachable.push(target);
    } catch (e) {
      log(`[ERROR] Could not check whether ${target} can be added, skipping: ${String(e)}`);
    }
  }
  if (reachable.length === 0) return notAdded('nobody-reachable');
  targetUsers = reachable;

  // Set once the Add commit has MERGED: from then on the users are in the tree whatever fails next.
  let addedUsers: Set<string> | null = null;
  // Refused by the gate (left out of the commit), or departed between the merge and the member-add
  // call: not added, whatever else the commit did.
  const notAdmitted = new Set<string>();
  try {
    await mlsService.registerMember(conversation.id, userId);

    // Collect devices for ALL users. Fetches are independent reads (no MLS constraint),
    // so they run in parallel instead of one sequential retry loop per user.
    const allDevices: any[] = [];
    const userMap = new Map<string, string>(); // deviceId -> userId

    const deviceFetches = await Promise.all(
      targetUsers.map(async (targetUser) => ({
        targetUser,
        devices: await fetchDevicesWithRetry(mlsService, targetUser, log),
      }))
    );
    for (const { targetUser, devices } of deviceFetches) {
      if (devices.length === 0) {
        log(`[WARN] Skipped: no devices found for ${targetUser}.`);
        console.warn(`[SYNC] No devices found for ${targetUser}, skipping`);
        continue;
      }
      devices.forEach((d: any) => {
        allDevices.push({ ...d, userId: targetUser });
        userMap.set(d.deviceId, targetUser);
      });
    }

    if (allDevices.length === 0) {
      log('[ERROR] No devices found for any of the requested users.');
      console.error('[SYNC] No devices found for any requested user - aborting bulk add');
      return notAdded('no-devices');
    }

    const lock = await (
      mlsService.acquireAddLockAnswer?.(conversation.id) ??
      mlsService.acquireAddLock(conversation.id).then((ok) => (ok ? 'taken' : 'held'))
    ).catch(() => 'unanswered' as const);
    if (lock !== 'taken') {
      // ONLY AN ANSWERED REFUSAL IS "ANOTHER DEVICE IS ADDING": a lock request that got no answer
      // says nothing about anyone else, and is a failure the member may retry.
      log(
        lock === 'held'
          ? `[WARN] Add-lock busy for ${conversation.id} - invite cancelled (another device is in progress).`
          : `[WARN] Add-lock request for ${conversation.id} got no answer - invite cancelled.`
      );
      console.warn(
        `[SYNC] Add-lock ${lock === 'held' ? 'busy' : 'unanswered'} for ${conversation.id}, aborting to avoid concurrent commits`
      );
      return notAdded(lock === 'held' ? 'add-lock-busy' : 'add-lock-unanswered');
    }

    // Users registered server-side AND whose Welcome was accepted: only those are announced.
    const announcedUsers = new Set<string>();

    try {
      // Add all devices in one staged MLS commit (C7-A), REBUILT ON A LOST RACE (`commitRace.ts`):
      // a refusal whose catch-up moved the epoch is staged again on the tree that won, offering only
      // the devices still without a leaf (CC-1, CC-4). Every candidate is excluded from the commit
      // broadcast (the added subset receives the Welcome instead).
      //
      // A REBUILD RE-CONFIRMS THE GESTURE'S PREMISE FIRST (`rosterPremise`): the commit that won may
      // be a Remove of the very person invited, and an invitation must never undo a removal.
      //
      // THE INVITATION RIDES IN THE COMMIT'S INTENT, with its roster baseline: a commit that is KEPT
      // (no answer) and then does not land is re-planned from it, never lost (`owedInvitations.ts`).
      //
      // A RESUMED invitation's premise reads the tree's own departures, so it is checked on the tree
      // CONFIRMED at the server's epoch (`premiseReadsTree`): the Remove that undoes it may be in the
      // very commits this device catches up on.
      const premise = await rosterPremise(
        mlsService,
        conversation.id,
        targetUsers,
        log,
        resumed,
        answering
      );
      seatGenerationCarried = premise.seatGeneration !== undefined;
      const raced = await addDevicesRebuildingOnRace(
        mlsService,
        conversation.id,
        userId,
        allDevices,
        log,
        {
          confirmPremise: premise.check,
          premiseReadsTree: resumed !== undefined,
          ...(premise.beforeStage ? { beforeStage: premise.beforeStage } : {}),
          invitation: {
            users: targetUsers,
            ...(premise.rostered ? { rostered: premise.rostered } : {}),
            ...(premise.seatGeneration !== undefined
              ? { seatGeneration: premise.seatGeneration }
              : {}),
          },
        }
      );
      for (const u of raced.notAdmitted) notAdmitted.add(u);
      if (raced.kind === 'already-in-tree') {
        // The tree, CONFIRMED at the server's epoch, holds every one of them: their Welcome and
        // registration were the winning commit's author's. The Add is done, nothing announced twice.
        addedUsers = new Set(
          allDevices.map((d) => d.userId).filter((u: string) => !notAdmitted.has(u))
        );
        if (addedUsers.size === 0) return notAdded('removed-meanwhile');
        log(`[SYNC] every invited device already holds a leaf - added by another member's commit`);
        return { kind: 'added', addedUsers: [...addedUsers] };
      }
      const bulk = raced;
      warnSkippedKeyPackages(bulk.skipped, conversation.id, '[SYNC]', log);

      await persistMlsStateAfterMutation(mlsService, userId, deviceKeyB64, log);

      // THE SERVER NAMES A JOINER BEFORE ITS WELCOME CAN ARRIVE. The commit is merged, so every
      // added device is already in the ratchet tree whether or not its Welcome is ever delivered;
      // registering only AFTER delivery left a window (an inviter dying between the two) in which a
      // member held key material and the delivery service did not know it, and nothing repaired
      // that. Registration is user-level (one upsert per user, not per device). A user whose
      // registration fails gets no Welcome from here: a Welcome to an unregistered member is the
      // broken state itself, and the joiner recovers through its own welcome_request.
      log(`[SYNC] bulk.addedDeviceIds: ${bulk.addedDeviceIds.join(', ')}`);
      const added = new Set(
        bulk.addedDeviceIds.map((did) => userMap.get(did)).filter((u): u is string => !!u)
      );
      addedUsers = added;
      const registeredUsers = new Set<string>();
      await Promise.all(
        [...added].map(async (tUser) => {
          try {
            await mlsService.registerMember(conversation.id, tUser);
            registeredUsers.add(tUser);
          } catch (err) {
            if (err instanceof MemberNotAdmittedError) {
              // The commit admitted them; the server holds no seat for them NOW - a departure since
              // the merge, whose own Remove takes the leaf. Not announced, no Welcome.
              log(
                `[SYNC] [WARN] ${tUser} holds no seat after the accepted Add of ${conversation.id.slice(0, 8)}... (a departure since) - Welcome withheld`
              );
              notAdmitted.add(tUser);
              return;
            }
            log(`[WARN] registerMember failed for ${tUser}: ${String(err)} - Welcome withheld`);
          }
        })
      );

      // Deliver welcomes per-device in parallel; one failure never aborts the others.
      const deliveredUsers = await deliverWelcomes({
        mlsService,
        groupId: conversation.id,
        bulk,
        ownerOf: (did) => {
          const owner = userMap.get(did);
          return owner && registeredUsers.has(owner) ? owner : undefined;
        },
        tag: '[SYNC]',
        log,
      });
      for (const u of deliveredUsers) announcedUsers.add(u);

      log(
        `[OK] Added: ${targetUsers.join(', ')} (${bulk.addedDeviceIds.length} device(s)). (${announcedUsers.size} user(s) delivered)`
      );
      console.log(
        `[SYNC] Members added: ${targetUsers.join(', ')} (${announcedUsers.size}/${targetUsers.length} delivered)`
      );
    } finally {
      await mlsService.releaseAddLock(conversation.id).catch(() => {});
    }

    // NOT ADMITTED IS NOT ADDED: refused by the gate (no leaf given), or departed since the merge.
    if (notAdmitted.size > 0) {
      for (const u of notAdmitted) addedUsers?.delete(u);
      log(`[SYNC] not added, the server did not admit them: ${[...notAdmitted].join(', ')}`);
      if (addedUsers === null || addedUsers.size === 0) return notAdded('removed-meanwhile');
    }

    // Broadcast member addition notification (one generic or multiple specific?)
    // Let's send one generic message listing all new users
    if (announcedUsers.size > 0) {
      try {
        // Our own notice is written under the frame's id once it is accepted: MLS never hands
        // this device its own frame, and every other device writes the row from it.
        await sendVisibleNotice(
          mlsService,
          conversation.id,
          'memberAdded',
          { newUsers: [...announcedUsers] },
          { contactName: conversation.id, actor: userId, addMessageToChat: deps.addMessageToChat }
        );
        await persistMlsStateAfterMutation(mlsService, userId, deviceKeyB64, log);
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
    // The one failure the member can act on, so it reaches them (`inviteMembersToCurrentGroup`).
    if (e instanceof FollowerTabCommitError) throw e;
    // NO ANSWER IS NOT A FAILURE. The commit is KEPT, with this invitation in its intent: accepted at
    // the next settlement it is merged, refused it is re-planned (`owedInvitations.ts`) - so the
    // member is told it will finish, never to try again (OFF-3: "the invitation failed" was false).
    // Unless the commit kept is an EARLIER one and this invitation never staged: then it is theirs.
    if (e instanceof PreviousCommitUnresolvedError) {
      log(
        `[SYNC] an earlier commit of the group is still unanswered - nothing staged, nobody added`
      );
      return notAdded('previous-commit-unresolved');
    }
    if (e instanceof CommitOutcomeUnknownError) {
      log(
        `[SYNC] the Add got no answer - kept with its invitation, settled at the next connection: ${String(e).slice(0, 120)}`
      );
      console.warn(`[SYNC] processBulkAddition: outcome unknown on ${conversation.id}`);
      return notAdded('outcome-unknown');
    }
    // ABANDONED BEFORE ANY STAGE (`AddAbortedError`): nothing was committed or registered. A premise
    // that could not be READ is a rebuild that could not be justified - retried like a lost race.
    if (e instanceof AddAbortedError) {
      log(`[SYNC] the Add was abandoned before its stage (${e.why}) - nobody added`);
      // Refused to admit everyone it named: a Decline, a departure or a block came first. With a seat
      // generation carried that is the designed outcome of a race the member lost on purpose: an info
      // line with the same facts. WITHOUT one (the roster read failed, or an old resumed entry) the
      // server's refusal of an undated departure is a client-side read failure, so it still warns.
      const designed =
        (e.why === 'removed-meanwhile' || e.why === 'not-admitted') &&
        (seatGenerationCarried || e.seatGenerationKnown);
      if (designed) console.info(`[SYNC] processBulkAddition: ${e.message}`);
      else console.warn(`[SYNC] processBulkAddition: ${e.message}`);
      if (e.why === 'removed-meanwhile' || e.why === 'not-admitted') {
        return notAdded('removed-meanwhile');
      }
      if (e.why === 'tree-unconfirmed') return notAdded('tree-unconfirmed');
      return notAdded('commit-race-lost');
    }
    // A RACE THAT PROVED NO PROGRESS (`rebuildableRefusal` declined it): another commit held or took
    // the epoch and this device could not see it land, so nothing was added and nothing may be
    // guessed. Its own reason, so the member is told to retry rather than that the Add broke.
    if (isCommitRaceRefusal(e) && (addedUsers === null || addedUsers.size === 0)) {
      log(
        `[SYNC] the Add lost a commit race without proof of progress (${e.reason}) - nobody added`
      );
      console.warn(`[SYNC] processBulkAddition: race refusal ${e.reason} on ${conversation.id}`);
      return notAdded('commit-race-lost');
    }
    log(`Bulk invite error: ${String(e)}`);
    console.error('[SYNC] processBulkAddition failed:', e);
    // A throw AFTER the commit merged does not unmake the Add: the users are in the tree.
    if (addedUsers === null || addedUsers.size === 0) return notAdded('failed');
  }
  if (addedUsers === null || addedUsers.size === 0) return notAdded('no-device-added');
  return { kind: 'added', addedUsers: [...addedUsers] };
}

/**
 * The premise of a member's invitation, re-checked before each REBUILD of its Add
 * (`addDevicesRebuildingOnRace`): every invited person who was on the roster when the invitation
 * began is still on it. A rebuild exists because another commit won, and that commit may be a Remove
 * of the very person invited (an approved join ask declined by another member, a member's device
 * re-added while an admin removes them) - re-adding them would undo it. The first pass needs no
 * check: it IS the gesture, made a moment ago.
 *
 * The roster is read once now, as the baseline. A baseline or a later read that fails proves
 * nothing, so a rebuild that needs it is abandoned (`premise-unreadable`) rather than guessed.
 *
 * WHAT IT CANNOT SEE: a person absent from the roster at the start, added AND removed by other
 * commits between two passes - the roster reads the same both times. The rebuild then re-adds them.
 *
 * **A RESUMED INVITATION (`resumed`) CHECKS ITS FIRST PASS TOO, AND SEES THAT CASE** - its gesture
 * was made before an absence, not a moment ago. Its baseline is the one recorded with the lost
 * commit (`CommitInvitation.rostered`), never a read made now, which would already lack the person
 * a Remove or a Decline took off; and a departure merged after the lost commit's base
 * (`removalEpochs`, read from the tree's own record) is a removal the invitation must not undo,
 * roster or not. That record is only complete on a tree caught up to the server, so the resumed
 * check runs AFTER the tree is confirmed (`premiseReadsTree`), never before - and again UNDER THE MLS
 * LOCK right before the stage (`beforeStage`): a Remove applied between the two would otherwise be
 * staged over.
 *
 * **THE BASELINE CARRIES WHEN THE MEMBER DECIDED** (ADM-3, 2026-10-25): the first read is made with
 * the group's seat generation (`getGroupRosterAtGeneration`), written into the intent and sent with
 * the Add, so the gate holds a Decline or a removal recorded after it against this Add and lets one
 * recorded before it pass - a re-invite after a Decline at an unchanged epoch is then a fresh invite.
 * And an ANSWER TO AN ASK (`answering`) is checked against that same read: the ask the member tapped
 * must still be on the roster, awaiting, under its identity - a Decline that settled it first is
 * gone from the read, and the Add is abandoned (`removed-meanwhile`) before anything is staged.
 *
 * @returns the check, and the baseline to write into the commit's intent - the recorded one when
 *   resumed, so a second loss is still judged against the gesture's own start.
 */
async function rosterPremise(
  mlsService: IMlsService,
  groupId: string,
  invited: readonly string[],
  log: (msg: string) => void,
  resumed?: ResumedInvitation,
  answering?: AnsweredJoinAsk
): Promise<{
  check: (attempt: number, refused: ReadonlySet<string>) => Promise<void>;
  beforeStage: ((refused: ReadonlySet<string>) => Promise<void>) | undefined;
  rostered: string[] | undefined;
  seatGeneration: number | undefined;
}> {
  const rosterOf = async (): Promise<Set<string>> =>
    new Set((await mlsService.getGroupUserMembers(groupId)).map((m) => m.userId));
  const firstRead: GroupRosterAtGeneration | null = resumed
    ? null
    : await mlsService.getGroupRosterAtGeneration(groupId).catch((e: unknown) => {
        log(
          `[SYNC] roster of ${groupId.slice(0, 8)}... unreadable at the invite: ${String(e).slice(0, 100)}`
        );
        return null;
      });
  if (answering) {
    if (!firstRead) {
      throw new AddAbortedError(
        groupId,
        'premise-unreadable',
        'the answered ask could not be read'
      );
    }
    // The ask this answer was tapped on, as the read finds it. Declined or expired, its seat is gone;
    // declined and asked again, the seat awaiting is a NEW ask (another identity) - either way the
    // tapped ask was settled, and an Add now would answer something the member never saw. A seat
    // no longer awaiting was admitted by another member's Add: the invite goes on, and finds them in
    // the tree once its own commit loses to that one (`already-in-tree`).
    const row = firstRead.members.find(
      (m) => m.userId.toLowerCase() === answering.userId.toLowerCase()
    );
    if (!row || (row.awaitingAdmission === true && row.askId !== answering.askId)) {
      throw new AddAbortedError(
        groupId,
        'removed-meanwhile',
        `the ask of ${answering.userId} was settled before the Add was built`,
        firstRead.seatGeneration !== null && firstRead.seatGeneration !== undefined
      );
    }
  }
  const atStart: Set<string> | null = resumed
    ? resumed.rostered
      ? new Set(resumed.rostered)
      : null
    : firstRead
      ? new Set(firstRead.members.map((m) => m.userId))
      : null;
  const seatGeneration = resumed
    ? resumed.seatGeneration
    : (firstRead?.seatGeneration ?? undefined);
  // The people the gate refused to admit are out of the commit: their departure is no premise of it.
  const check = async (attempt: number, refused: ReadonlySet<string>) => {
    if (attempt === 0 && !resumed) return;
    if (atStart === null) {
      throw new AddAbortedError(groupId, 'premise-unreadable', 'no roster baseline to rebuild on');
    }
    let now: Set<string>;
    try {
      now = await rosterOf();
    } catch (e) {
      throw new AddAbortedError(groupId, 'premise-unreadable', String(e).slice(0, 100));
    }
    const removed = invited.filter((u) => !refused.has(u) && atStart.has(u) && !now.has(u));
    if (resumed)
      removed.push(...(await departedSince(resumed.baseEpoch, [...removed, ...refused])));
    if (removed.length > 0) {
      throw new AddAbortedError(
        groupId,
        'removed-meanwhile',
        `${removed.join(', ')} left the roster or the tree while the Add ${resumed ? 'was kept' : 'was rebuilt'}`
      );
    }
  };
  /** The invited people the tree records a departure of after `baseEpoch` - its own record, no I/O. */
  const departedSince = async (baseEpoch: number, known: readonly string[] = []) => {
    const departed: string[] = [];
    for (const u of invited) {
      if (known.includes(u)) continue;
      let departures: number[];
      try {
        departures = await mlsService.removalEpochs(groupId, u);
      } catch (e) {
        throw new AddAbortedError(groupId, 'premise-unreadable', String(e).slice(0, 100));
      }
      if (departures.some((epoch) => epoch > baseEpoch)) departed.push(u);
    }
    return departed;
  };
  const beforeStage = resumed
    ? async (refused: ReadonlySet<string>) => {
        const departed = await departedSince(resumed.baseEpoch, [...refused]);
        if (departed.length > 0) {
          throw new AddAbortedError(
            groupId,
            'removed-meanwhile',
            `${departed.join(', ')} left the tree in a commit applied just before the stage`
          );
        }
      }
    : undefined;
  return {
    check,
    beforeStage,
    rostered: atStart ? invited.filter((u) => atStart.has(u)) : undefined,
    seatGeneration,
  };
}

/**
 * A member's invitation whose kept commit did not land, re-planned at the epoch that won
 * ({@link replanLostInvitation}): the epoch its commit was staged on, and the roster baseline and
 * seat generation its intent recorded (absent when they could not be read then).
 */
interface ResumedInvitation {
  baseEpoch: number;
  rostered: string[] | undefined;
  seatGeneration: number | undefined;
}

/**
 * The join ask a member's Add answers (`admitJoinRequest`): the person, and the ask's identity - the
 * seat its link wrote - which must still stand when the Add is built ({@link rosterPremise}).
 */
export interface AnsweredJoinAsk {
  userId: string;
  askId: string;
}

/** How a re-planned invitation ended - what the member is told, read by the caller. */
export type LostInvitationOutcome =
  /** Every invited person now holds a leaf - added by this re-plan, or already by someone else. */
  | { kind: 'completed' }
  /** Its commit is kept in turn (no answer again): its own intent carries the invitation on. */
  | { kind: 'kept' }
  /**
   * It cannot run YET - the add lock was refused, or the tree could not be confirmed at the server's
   * epoch. Nothing staged, the entry stays for the next drain - never a word to the member, the
   * invitation is not over.
   */
  | { kind: 'waiting'; on: 'add-lock' | 'tree-unconfirmed' }
  /**
   * The gate refused the lost commit for something other than a race - `reason` is its token
   * (`committer_not_member`, `welcome_target_not_member`, ...). Not re-planned: the same invitation
   * meets the same answer, so the member is told, never asked to invite again.
   */
  | { kind: 'refused'; reason: string | undefined }
  /** The conversation was retired on this device (`lifecycle: 'removed'`): nobody can be added. */
  | { kind: 'conversation-gone' }
  /** Nothing was added, for `reason` - the member is told. */
  | { kind: 'not-completed'; reason: BulkAdditionRefusal };

/**
 * RE-PLANS A MEMBER'S INVITATION WHOSE KEPT COMMIT DID NOT LAND (OFF-3, 1.4.1 campaign) - the same
 * invitation, made again at the epoch that won, under the premises a rebuilt Add answers to
 * ({@link rosterPremise} in its resumed form, then `addDevicesRebuildingOnRace`):
 * - a person removed, declined or departed meanwhile is never brought back (`removed-meanwhile`);
 * - one who already holds a leaf - another member's Add - is not added twice (`already-in-tree`);
 * - a tree that cannot be confirmed, or a roster that cannot be read, adds nobody.
 *
 * A `refused` loss (the gate refused it for anything but a race, its typed reason recorded) is not
 * re-planned: the same invitation would meet the same refusal, so the member is told. Another
 * device's add lock (`add-lock-busy`) is `waiting`: nothing was staged and the invitation is not
 * over, so the entry stays for the next drain.
 *
 * @returns how it ended; it never throws but for a follower tab's refusal, which the drain never
 *   reaches (only the leader drains).
 */
export async function replanLostInvitation(
  owed: OwedInvitation,
  conversation: Conversation,
  deps: InviteDeps
): Promise<LostInvitationOutcome> {
  const short = owed.groupId.slice(0, 8);
  if (owed.cause === 'refused') {
    deps.log(
      `[INVITE_OWED] ${short}... the invitation lost at epoch ${owed.baseEpoch} was refused by the gate (${owed.reason ?? 'no reason'}) - not re-planned, the member is told`
    );
    return { kind: 'refused', reason: owed.reason };
  }
  const outcome = await processBulkAddition(owed.invitation.users, conversation, deps, {
    baseEpoch: owed.baseEpoch,
    rostered: owed.invitation.rostered,
    seatGeneration: owed.invitation.seatGeneration,
  });
  deps.log(
    `[INVITE_OWED] ${short}... the invitation lost at epoch ${owed.baseEpoch}: ${outcome.kind === 'added' ? 'completed' : outcome.reason}`
  );
  if (outcome.kind === 'added') return { kind: 'completed' };
  if (outcome.reason === 'outcome-unknown') return { kind: 'kept' };
  // NOTHING STAGED, AND NOTHING THAT ENDS THE INVITATION: the lock was refused, or the tree could not
  // be confirmed (a log that could not be read, a replay held behind frames refused for lack of a row
  // whose pull is already asked, a catch-up that stopped short). Each lifts on an event - a commit
  // applied in the group, the next connection - so the entry waits for it.
  if (outcome.reason === 'add-lock-busy') return { kind: 'waiting', on: 'add-lock' };
  if (outcome.reason === 'tree-unconfirmed') return { kind: 'waiting', on: 'tree-unconfirmed' };
  return { kind: 'not-completed', reason: outcome.reason };
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
  deps: Pick<GroupCreationDeps, 'mlsService' | 'userId' | 'deviceKeyB64' | 'log'>
): Promise<void> {
  const { mlsService, userId, deviceKeyB64, log } = deps;

  const lockAcquired = await mlsService.acquireAddLock(groupId).catch(() => false);
  try {
    // Staged transaction (C7-A), rebuilt on a lost race (`commitRace.ts`); every candidate device
    // is excluded from the commit broadcast (the added subset receives the Welcome instead).
    const raced = await addDevicesRebuildingOnRace(
      mlsService,
      groupId,
      userId,
      allDevices.map((d) => ({
        ...d,
        userId: contactDeviceIds.has(d.deviceId) ? contact : userId,
      })),
      log,
      // A CONVERSATION WITHOUT ITS PEER IS NOT CREATED. The gate refusing to admit them (a block
      // recorded since the check above) abandons the Add before anything is staged again
      // (`AddAbortedError`), and the caller's catch drops the group on both estates.
      { mustAdmit: contact }
    );
    if (raced.kind === 'already-in-tree') {
      log(`[ADD] every device already holds a leaf in ${groupId} - nothing to add`);
      return;
    }
    const bulk = raced;
    log(`[ADD] ${bulk.addedDeviceIds.length} device(s), welcome=${!!bulk.welcome}`);
    warnSkippedKeyPackages(bulk.skipped, groupId, '[ADD]', log);

    // registerMember is user-level (upsert GroupMember): one call per userId is enough.
    // Calling once per device generates N-1 redundant transactions for a multi-device user.
    // The accepted commit already enrolled every person it admitted; a refusal here
    // (`MemberNotAdmittedError`: the peer departed since the merge) rejects the creation, and the
    // caller's catch drops the group on both estates - no conversation is presented without its peer.
    const owners = new Set(
      bulk.addedDeviceIds.map((did) => (contactDeviceIds.has(did) ? contact : userId))
    );
    await Promise.all([...owners].map((owner) => mlsService.registerMember(groupId, owner)));

    await deliverWelcomes({
      mlsService,
      groupId,
      bulk,
      ownerOf: (did) => (contactDeviceIds.has(did) ? contact : userId),
      tag: '[ADD]',
      log,
    });

    // Save MLS state after the merged commit (crash-safety).
    await persistMlsStateAfterMutation(mlsService, userId, deviceKeyB64, log);
  } finally {
    if (lockAcquired) await mlsService.releaseAddLock(groupId).catch(() => {});
  }
}

/**
 * Adds one or more users to an existing MLS group by their Canari user IDs.
 * All devices belonging to each user are added in a single bulk MLS commit.
 *
 * `opts.answering` names the join ask this invitation answers: the Add then proceeds only while that
 * very ask is still open (or already admitted by another member), never over a Decline.
 *
 * @returns what it did ({@link BulkAdditionOutcome}) - it never throws, so a caller that must know
 *   whether a person was added reads this, never the absence of an exception.
 */
export async function inviteMembersToGroup(
  memberIds: string[],
  conversation: Conversation,
  deps: InviteDeps,
  opts: { answering?: AnsweredJoinAsk } = {}
): Promise<BulkAdditionOutcome> {
  return processBulkAddition(memberIds, conversation, deps, undefined, opts.answering);
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
 *
 * Every way this can decline is named in the answer rather than left in a log line - see
 * `ConversationOutcome`.
 */
export async function startNewConversation(
  contactName: string,
  deps: GroupCreationDeps
): Promise<ConversationOutcome> {
  const { mlsService, userId, conversations, selectConversation, saveConversation, log } = deps;
  const silent = deps.silent ?? false;
  const maybeSelect = (id: string) => {
    if (!silent) selectConversation(id);
  };

  const contact = contactName.trim().toLowerCase();
  if (!contact || contact === userId) return { ok: true, key: null };

  // Check local map first
  const existingDirect = Array.from(conversations.entries()).find(([, convo]) => {
    if ((convo.conversationType ?? 'group') !== 'direct') return false;
    return (convo.directPeerId ?? convo.contactName).toLowerCase() === contact;
  });

  if (existingDirect) {
    const [existingKey, existingConvo] = existingDirect;
    if (existingConvo.lifecycle === 'active') {
      maybeSelect(existingKey);
      return { ok: true, key: existingKey };
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
        const base: Conversation = buildConversationRow({
          id: convoKey,
          lifecycle: ready ? 'active' : 'pending',
          identity: {
            conversationType: 'direct',
            contactName: contact,
            displayName: contact,
            directPeerId: contact,
          },
          existing,
        });
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
      if (holdsGroupState(mlsService, key)) {
        await ensureDirectConvo(key, true);
        maybeSelect(key);
        return { ok: true, key };
      }

      // MLS state missing locally - recover via the external-join / welcome_request seam.
      log(`[1v1] MLS state missing for ${key} - triggering recovery...`);
      await ensureDirectConvo(key, false);
      try {
        await requestReAdd(key, {
          mlsService,
          storage: deps.storage,
          userId,
          deviceKey: () => deps.deviceKeyB64,
          conversations,
          getSelectedContact: () => key,
          setSelectedContact: (id: string | null) => {
            if (id) maybeSelect(id);
          },
          saveConversation,
          onGroupReady: captureGroupReadyAnnouncer(),
          log,
        });
      } catch {
        if (conversations.has(key)) maybeSelect(key);
      }
      // The row exists either way - recovery having been REQUESTED is the outcome here, and the
      // conversation opens `pending` while it runs. A refusal would close a modal over a
      // conversation the sidebar is about to show.
      return { ok: true, key };
    }
  } catch (e) {
    // Non-blocking: continue with normal creation but log the error.
    console.warn(`[1v1] getUserGroups failed, risk of duplicate group:`, e);
  }

  // A BLOCK IS ASKED ABOUT HERE, NOT DISCOVERED LATER. Every existing-conversation path above has
  // already returned by now, which is what keeps a block off conversations that predate it: only
  // the CREATION of a new one is closed. The authoritative refusal is the server's, at
  // `addGroupMember` - but meeting it here would mean the group had already been minted and the
  // Welcomes already sent, leaving a conversation half built on both sides.
  //
  // A failure to ask is not an answer, so this is not swallowed: if core-service cannot be reached
  // the creation stops and says so, rather than proceeding as though nobody had blocked anybody.
  try {
    if (await isBlockedWith(contact)) {
      log(`[1v1] Refused: a block stands between ${userId} and ${contact}.`);
      return { ok: false, reason: 'blocked' };
    }
  } catch (e) {
    log(`[ERROR] Could not check whether ${contact} can be contacted: ${String(e)}`);
    return { ok: false, reason: 'block-check-unavailable' };
  }

  // IMPORTANT: Check if contact is available BEFORE creating the group
  // This prevents orphaned groups on other devices if the contact isn't online
  log(`Checking availability of ${contact}...`);
  const contactDevices = await fetchDevicesWithRetry(mlsService, contact, log);
  if (contactDevices.length === 0) {
    log(
      `[ERROR] No devices found for ${contact}. The contact must sign in at least once to publish their KeyPackage.`
    );
    return { ok: false, reason: 'peer-has-no-device' };
  }

  const groupName = `${userId}::${contact}`;
  let groupId: string | undefined;
  try {
    groupId = await mlsService.createRemoteGroup(groupName, false); // false = 1-to-1 direct conversation
    console.log(`[DM] createRemoteGroup → groupId=${groupId}`);
    log(`[DM] Remote group created: ${groupId}`);
    const conversationKey = groupId;

    // THE ROW IS NOT PUBLISHED UNTIL THE GROUP IS REACHABLE, AND THAT IS THE WHOLE INVARIANT.
    //
    // The SYNC_WATCHDOG enumerates `conversations` BY KEY and treats every key as a groupId
    // (`sessionWatchdogs.ts`), every 5 s. A direct conversation is keyed by its groupId, so the
    // instant this row exists the group is a recovery candidate - and until `registerMember`
    // lands, `GET /api/mls/groups/:id/*` answers 403 to its own creator, because the roster it
    // checks is still empty. `requestReAdd` reads that refusal as `NotAGroupMemberError`, which
    // is a TERMINATING answer: `stopRecovering` retires the conversation, and the creator is
    // shown "this conversation has been deleted" over a group they created seconds earlier.
    //
    // Reported from production on 2026-09-01 (group `ab47add3`): the banner appeared on the
    // creator's phone while the message he had just typed was delivered normally to the peer -
    // the two writers of `lifecycle` were racing, and the retire simply landed last.
    //
    // Publishing the row only once `getLocalGroups()` holds the group DELETES the overlap rather
    // than narrowing it: the watchdog's first branch (`localGroups.has(id)` -> healthy, skip)
    // then covers every poll there has ever been. This mirrors `createNewGroup`, which presents
    // its conversation once, at the end, for the same reason and after the same check.
    await mlsService.registerMember(groupId, userId);
    log(`[DM] Server membership registered for ${userId}`);
    await mlsService.createGroup(groupId);
    log(`[DM] Local MLS group created: ${groupId}`);

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

    // The same fact the group path checks, for the same reason: `pending` is an honest placeholder,
    // `active` is a claim that this device can decrypt the conversation. Never promote on state
    // that is gone - the outer catch then cleans both estates.
    if (!holdsGroupState(mlsService, groupId)) {
      throw new Error(
        `Local MLS state for ${groupId} disappeared during creation - refusing to activate the conversation`
      );
    }

    // Published `active` in one write, never `pending` first: there is no reader left that could
    // see the intermediate state, and a row that is only ever written once cannot lose a race
    // against a concurrent writer of the same field.
    conversations.set(
      conversationKey,
      buildConversationRow({
        id: groupId,
        lifecycle: 'active',
        identity: {
          conversationType: 'direct',
          contactName: contact,
          displayName: contact,
          directPeerId: contact,
        },
        // The creation moment seeds the ordering of a conversation that holds only notices; the
        // first real message replaces it (conversationRecency). Not `startedAt`: that is the
        // server's write-once fact and a local clock would pre-empt it.
        lastMessageAt: Date.now(),
      })
    );
    maybeSelect(conversationKey);
    saveConversation(conversationKey);
    log(`[OK] Secure channel established with ${contact}.`);
    console.log(`[DM] 1v1 conversation with ${contact} ready (groupId=${groupId})`);
    return { ok: true, key: conversationKey };
  } catch (_e: unknown) {
    log(`Creation error: ${String(_e)}`);
    if (groupId) conversations.delete(groupId);

    // Clean up local MLS state (epoch may have advanced after addMembersBulk)
    if (groupId) {
      await dropGroupState(mlsService, groupId, {
        reason: 'the conversation could not be created',
        checkpoint: 'awaited',
        log,
      });
    }

    // Best-effort: clean up the orphan remote group to avoid server-side litter
    if (groupId) {
      try {
        await mlsService.deleteGroupOnServer(groupId);
      } catch {
        // Non-blocking: orphan will be cleaned up on next server-side GC
      }
    }
    return { ok: false, reason: creationRefusal(_e) };
  }
}
