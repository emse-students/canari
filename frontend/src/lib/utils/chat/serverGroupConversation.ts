import type { IMlsService } from '$lib/mls-client/IMlsService';
import type { Conversation } from '$lib/types';
import {
  buildConversationRow,
  findDirectConversationByPeer,
  resolveDirectPeerId,
} from './conversations';
import { holdsGroupState } from './groupUsability';
import { isGroupInCreation } from './groupsInCreation';
import { Log } from '$lib/utils/Log';
import {
  GROUP_NAME_SKIP_TEXT,
  ownRenameOutcome,
  pendingRenameVerdict,
  withNameSync,
  type NameSync,
  type PendingRename,
} from './groupName';
import { BUNDLE_SERVER_TIME_SKEW_MS } from './messageTime';
import type { SentNotice } from './visibleNotices';

/**
 * THE CONVERSATION ROW FOR A GROUP THE SERVER LISTS - written in ONE place, by every path that
 * needs one to exist.
 *
 * IT IS AN INVARIANT AND NOT A HELPER, AND THE INVARIANT IS AN ORDER. A device becomes REACHABLE
 * for a group the instant its leaf is in that group's tree; it becomes able to ROUTE what arrives
 * only once a conversation row exists for it. The inbound handler is explicit about the gap between
 * the two - a frame for a group with no row is answered `false`, left in the server queue and noted
 * `absent-conversation` - which is the only honest thing to do with a frame nothing can hold, and
 * is not a state to pass through on purpose.
 *
 * The Welcome path never had the gap: `setupMessageHandler` writes the row inside the same MLS lock
 * that installs the group, so joining and being able to route are one step. The self-service
 * external-commit join had no such step: it took its row from a different sweep entirely
 * (`discoverMissingGroups`, fire-and-forget, on its own cadence). Both read the SAME server list and
 * each did half the job, so the order between them was decided by whichever finished first.
 *
 * MEASURED 2026-09-06 (HEAL-REVOKE-4). A re-admitted device external-joined at 02:00:37; the
 * member's answer to that device's own history solicitation arrived in the same second and was
 * buffered `absent-conversation`; the row appeared at 02:00:42. Five seconds of window, and the one
 * exchange that repairs a rejoining device's whole history fell inside it.
 *
 * SO THE JOIN WAITS FOR THIS, and this is what discovery already did - EXTRACTED rather than
 * re-written. Two functions building a conversation row is two conventions for its key, its display
 * name and its duplicate check, and those three had already diverged once between the Welcome path
 * and this one.
 */

/**
 * The subset of a server group row this seam needs.
 *
 * `isGroup` IS REQUIRED, AND THAT IS THE POINT OF THE TYPE. It decides whether the row is a DM -
 * which decides its display name, its `directPeerId` and the duplicate check - so an absent value
 * is not a default, it is a question nobody answered. `GroupMeta` declares it optional because the
 * parser cannot promise what a response contains, and a caller holding one must therefore say what
 * it does about `undefined` rather than let it fall through as "DM".
 */
export type ServerGroupRow = {
  groupId: string;
  name?: string | null;
  isGroup: boolean;
  imageMediaId?: string | null;
  /** ISO-8601 instant the group was created server-side - see {@link UserGroupRow.createdAt}. */
  createdAt?: string | null;
};

/**
 * Reads a group's creation instant out of a server row, or `undefined` for anything unusable.
 *
 * ONE PLACE, because every caller must reach the same verdict about a missing or malformed value:
 * `undefined` means UNKNOWN, and unknown asks for the past rather than declaring there is none.
 * A server that does not send the field and one that sends nonsense are the same situation here.
 */
export function groupStartInstant(group: Pick<ServerGroupRow, 'createdAt'>): number | undefined {
  if (!group.createdAt) return undefined;
  const at = Date.parse(group.createdAt);
  return Number.isFinite(at) && at > 0 ? at : undefined;
}

/** What building the row needs, in the shape both callers already hold. */
export type EnsureConversationDeps = {
  mlsService: IMlsService;
  userId: string;
  conversations: Map<string, Conversation>;
  saveConversation?: (key: string) => Promise<void>;
  /**
   * The groups this device owes the server an exit for, READ BY THE CALLER.
   *
   * Passed in rather than read here because discovery asks the question once for a whole sweep and
   * recovery asks it for one group: the guard belongs in one place, the round trip does not.
   */
  owedExits: ReadonlySet<string>;
  log: (msg: string) => void;
  /**
   * What settles a rename this device still owes (`Conversation.nameSync`) - passed by the
   * connection sweep only. ABSENT ON THE RECOVERY PATH, deliberately: a re-join runs before this
   * device has drained what arrived while it was out, so it would compare an owed copy with a list
   * whose later rename it has not read. A row that owes something is then neither settled nor
   * relabelled - the next sweep does both, in order.
   */
  nameSync?: NameSyncSettler;
};

/** How the connection sweep re-sends a pending rename, and the instant it reads its bound against. */
export interface NameSyncSettler {
  /** `resendPendingRename`, bound to this device's key and notice writer. */
  resend: (
    pending: PendingRename,
    groupId: string,
    contactName: string
  ) => Promise<SentNotice | 'unanswered'>;
  /** The clock `PendingRename.sentAt` was minted on - this device's, the same one. */
  now: () => number;
}

/**
 * Why no row was created, when none was - each one a DIFFERENT next move for the caller.
 *
 * `existed` and `created` both mean the device may now route for the group. The other four mean it
 * may not, and a caller about to make this device a member has to treat them as such rather than
 * joining anyway: `peer-unresolved` and `duplicate` clear by themselves on a later pass,
 * `exit-owed` clears when the exit is answered, `in-creation` when this device's own creation
 * writes the row (`groupsInCreation.ts`).
 */
export type EnsureConversationOutcome =
  | 'existed'
  | 'created'
  | 'peer-unresolved'
  | 'duplicate'
  | 'exit-owed'
  | 'in-creation';

/** The (group, server name) pairs already reported by {@link noteServerNameDisagreement}. */
const reportedServerNames = new Set<string>();

/**
 * Says, ONCE per group and server name for the life of the page, that the server's list names a
 * group differently from the name an MLS frame dated on this device. A line repeated by every sweep
 * is one its reader learns to skip; a new server name is a new fact and is said again.
 */
function noteServerNameDisagreement(
  groupId: string,
  serverName: string,
  nameAt: number,
  log: (msg: string) => void
): void {
  const key = `${groupId}|${serverName}`;
  if (reportedServerNames.has(key)) return;
  reportedServerNames.add(key);
  log(
    `[DISCOVERY] ${groupIdShort(groupId)} - the server's list names it differently (${serverName.length} chars) from the name a frame dated ${new Date(nameAt).toISOString()}; the dated name stands until a later frame`
  );
}

/**
 * Brings a KNOWN group row's label back in line with the server's, for as long as no MLS frame has
 * dated the row's name (`Conversation.nameAt`, `groupName.ts`) - once one has, the members' frames
 * are the authority and the server's undated list is not.
 *
 * **THIS SEAM WAS THE ONLY ONE THAT COULD, AND IT WAS THE ONE THAT RETURNED EARLY.** A group's name
 * reaches a device by exactly two routes: the `groupRenamed` system message, which a device offline
 * at the time never sees, and this list. Everything else that writes a conversation row either
 * creates it or repairs a DM's peer. So a row that acquired a wrong label - a push placeholder named
 * after its sender, a rename missed while the app was closed - kept it for the life of the install,
 * and a two-person group ended up sitting in the sidebar under the other member's name, directly
 * above the real DM with that same person and indistinguishable from it (measured 2026-09-08).
 *
 * **GROUPS ONLY, AND THAT IS NOT CAUTION - IT IS WHAT `isGroup` MEANS.** For a DM the server's name
 * is the canonical `self::peer` KEY and the row's name is the peer's resolved display name: they are
 * two different facts and overwriting one with the other would put a uuid pair in the sidebar. The
 * server's name is the group's name only when the server says the row is a group.
 *
 * Silent when there is nothing to do, loud when there is: a label changing under a user who is
 * looking at it is exactly the kind of thing a reader must be able to find afterwards.
 */
async function repairGroupLabel(
  key: string,
  convo: Conversation,
  group: ServerGroupRow,
  conversations: Map<string, Conversation>,
  saveConversation: ((key: string) => Promise<void>) | undefined,
  log: (msg: string) => void
): Promise<void> {
  if (!group.isGroup) return;
  const serverName = (group.name ?? '').trim();
  if (!serverName || serverName === convo.name) return;
  if (convo.nameSync?.serverCopy?.name === convo.name) {
    // THE MEMBERS HOLD THIS NAME AND THE SERVER'S COPY OF IT IS OWED (`settleNameSync`): the list
    // is behind by exactly that write, so it is no correction - relabelling here put the old name
    // back on the device that renamed (an undated rename, its answer carrying no server time).
    Log.d(
      'Discovery',
      `${groupIdShort(group.groupId)} label kept - the server's copy of it is owed, not wrong`
    );
    return;
  }
  if (convo.nameAt !== undefined) {
    // A NAME AN MLS FRAME DATED IS THE MEMBERS' WORD, AND THE SERVER'S LIST NO LONGER OVERRIDES IT
    // (`groupName.ts`): the list carries no date, so it cannot say it is newer. A disagreement is a
    // rename whose frame this device has not read yet - or one an older build sent without one - and
    // it is said once per name, never on every sweep.
    noteServerNameDisagreement(group.groupId, serverName, convo.nameAt, log);
    return;
  }
  conversations.set(key, { ...convo, name: serverName, contactName: serverName });
  log(
    `[DISCOVERY] ${groupIdShort(group.groupId)} relabelled "${convo.name}" -> "${serverName}" (no frame has dated this name, so the server's list still corrects it)`
  );
  // AWAITED, NOT FIRE-AND-FORGET. The block this replaced in `discoverMissingGroups` awaited its
  // save, and a repair whose write may not have landed re-runs on the next sweep and logs again -
  // a line that repeats is a line its reader learns to skip.
  await saveConversation?.(key).catch(() => {});
}

/**
 * Writes the group's creation instant onto a row that does not carry one yet.
 *
 * WHY IT IS A REPAIR AND NOT ONLY A FIELD ON CREATION. Every conversation that existed before this
 * shipped was stored without it, and a device does not re-create rows it already has - so writing
 * it only on the `created` path would leave every EXISTING conversation asking peers for a past
 * that cannot exist, for ever. This sweep already visits every active group on every connection
 * ({@link discoverMissingGroups}), which makes it the one pass that reaches them all.
 *
 * It is write-once and never an update: the value is a fixed fact about the group's row, so a row
 * that already carries one is left alone and nothing is logged - a line that fires on every group
 * on every connection is a line its reader learns to skip.
 *
 * IT READS THE ROW OUT OF THE MAP RATHER THAN BEING HANDED ONE. {@link repairGroupLabel} runs first
 * and REPLACES the row when the server renamed the group; a second repair spreading the copy it was
 * given at the top of the pass would put the old name straight back. Two repairs over one row is a
 * shape, not an accident - the next one added would meet the same trap - so the row is fetched at
 * the moment it is written.
 */
async function recordGroupStart(
  key: string,
  group: ServerGroupRow,
  conversations: Map<string, Conversation>,
  saveConversation: ((key: string) => Promise<void>) | undefined
): Promise<void> {
  const convo = conversations.get(key);
  if (!convo || convo.startedAt !== undefined) return;
  const startedAt = groupStartInstant(group);
  if (startedAt === undefined) return;
  conversations.set(key, { ...convo, startedAt });
  await saveConversation?.(key).catch(() => {});
}

/**
 * Settles what this device still owes about a rename it made (`Conversation.nameSync`,
 * `groupName.ts`), first the frame then the server's copy. Run by the sweep every connection makes,
 * which visits every active group - so what is owed is settled at the next start or reconnect, and
 * never on a clock.
 *
 * THE PENDING FRAME (its first send got no answer). Read off the row first
 * (`pendingRenameVerdict`): a row that moved on to a later statement drops it - re-sending would put
 * the older rename back on top at a later server time; a row that holds the name, dated, saw its own
 * frame come back from the archive, so it landed and only the server's copy is owed. Otherwise the
 * SAME frame is re-sent (`NameSyncSettler.resend`). A frame minted more than the receivers' bound ago
 * would be refused by every one of them, so it is dropped unsent - its first copy, if it landed, was
 * taken by the members, and this device reads it back from the archive replay or the next rename.
 * Another send without an answer keeps it pending; an ANSWER that refuses it drops it.
 *
 * THE SERVER'S COPY, COMPARE-AND-SET. The copy is written only while the row still holds the owed
 * name AND the server still holds the name the rename was made over (`OwedServerCopy.from`): a
 * server that names anything else was written by a later rename - this device's sweep may well run
 * before it has read that rename's frame - and an owed copy is never written over it. Such a copy is
 * DROPPED, said once, never retried. The residual race is one round trip wide: a member's write
 * landing between the list this sweep read and the write it makes.
 *
 * @returns true when this pass wrote the server's copy (the list in hand is then stale for this group).
 */
async function settleNameSync(
  key: string,
  group: ServerGroupRow,
  settler: NameSyncSettler,
  mlsService: IMlsService,
  conversations: Map<string, Conversation>,
  saveConversation: ((key: string) => Promise<void>) | undefined,
  log: (msg: string) => void
): Promise<boolean> {
  const start = conversations.get(key);
  if (!start?.nameSync) return false;
  const save = async () => {
    await saveConversation?.(key).catch((e) => {
      console.error(
        `[GROUP_NAME] ${groupIdShort(group.groupId)} name sync settled but not saved - it runs again next connection: ${String(e).slice(0, 120)}`
      );
    });
  };
  const pending = start.nameSync.pending;
  if (pending) {
    await settlePendingRename(key, group, pending, settler, conversations, save, log);
  }
  const convo = conversations.get(key);
  const owed = convo?.nameSync?.serverCopy;
  if (!convo || !owed) return false;
  const serverName = (group.name ?? '').trim();
  const drop = async (line: string, level: 'log' | 'warn') => {
    conversations.set(key, withNameSync(convo, { ...convo.nameSync, serverCopy: undefined }));
    await save();
    if (level === 'warn') console.warn(line);
    else log(line);
  };
  if (convo.name !== owed.name) {
    await drop(
      `[GROUP_NAME] ${groupIdShort(group.groupId)} server copy owed dropped - the row moved on to a later name, whose own rename writes the copy`,
      'log'
    );
    return false;
  }
  if (serverName === owed.name) {
    await drop(
      `[GROUP_NAME] ${groupIdShort(group.groupId)} server copy owed already held by the server - nothing owed`,
      'log'
    );
    return false;
  }
  if (serverName !== owed.from) {
    await drop(
      `[GROUP_NAME] ${groupIdShort(group.groupId)} server copy owed DROPPED, not written - the server no longer holds the name the rename was made over, so a later rename wrote it and an owed copy never goes over that`,
      'warn'
    );
    return false;
  }
  try {
    await mlsService.renameGroup(convo.id, convo.name);
  } catch (e) {
    console.warn(
      `[GROUP_NAME] ${groupIdShort(group.groupId)} server copy still owed - the write failed again: ${String(e).slice(0, 120)}`
    );
    return false;
  }
  const after = conversations.get(key) ?? convo;
  conversations.set(key, withNameSync(after, { ...after.nameSync, serverCopy: undefined }));
  await save();
  log(`[GROUP_NAME] ${groupIdShort(group.groupId)} server copy owed written - nothing owed`);
  return true;
}

/** The pending half of {@link settleNameSync}: leaves the row's `nameSync` saying what is still owed. */
async function settlePendingRename(
  key: string,
  group: ServerGroupRow,
  pending: PendingRename,
  settler: NameSyncSettler,
  conversations: Map<string, Conversation>,
  save: () => Promise<void>,
  log: (msg: string) => void
): Promise<void> {
  const id = `${groupIdShort(group.groupId)} rename ${pending.messageId.slice(0, 8)}`;
  const replace = async (sync: NameSync, row?: Conversation) => {
    const base = row ?? conversations.get(key);
    if (!base) return;
    conversations.set(key, withNameSync(base, sync));
    await save();
  };
  const current = conversations.get(key);
  if (!current) return;
  const verdict = pendingRenameVerdict(current, pending);
  if (verdict === 'superseded') {
    await replace({ serverCopy: current.nameSync?.serverCopy });
    log(`[GROUP_NAME] ${id} pending frame dropped - a later name superseded it`);
    return;
  }
  if (verdict === 'landed') {
    await replace({ serverCopy: { name: pending.name, from: pending.over.name } });
    log(`[GROUP_NAME] ${id} pending frame came back from the archive - only the server copy owed`);
    return;
  }
  if (settler.now() - pending.sentAt > BUNDLE_SERVER_TIME_SKEW_MS) {
    await replace({ serverCopy: current.nameSync?.serverCopy });
    console.error(
      `[GROUP_NAME] ${id} pending frame DROPPED unsent - minted more than the receivers' bound ago, so every member would refuse it`
    );
    return;
  }
  let sent: SentNotice | 'unanswered';
  try {
    sent = await settler.resend(pending, group.groupId, key);
  } catch (e) {
    await replace({ serverCopy: current.nameSync?.serverCopy });
    console.error(
      `[GROUP_NAME] ${id} pending frame DROPPED - the re-send was answered with a refusal: ${String(e).slice(0, 120)}`
    );
    return;
  }
  if (sent === 'unanswered') {
    log(`[GROUP_NAME] ${id} re-sent, no answer again - still pending`);
    return;
  }
  // Re-read: the re-send wrote this device's own notice row meanwhile.
  const after = conversations.get(key);
  if (!after) return;
  const outcome = ownRenameOutcome(after, pending.name, sent.receivedAt, true, pending.over);
  if ('row' in outcome) {
    await replace({ serverCopy: outcome.row.nameSync?.serverCopy }, outcome.row);
    log(`[GROUP_NAME] ${id} re-sent and delivered - the server copy follows`);
  } else {
    await replace({ serverCopy: after.nameSync?.serverCopy });
    log(
      `[GROUP_NAME] ${id} re-sent and delivered, row kept: ${GROUP_NAME_SKIP_TEXT[outcome.skipped]}`
    );
  }
}

/** The 8-character prefix every line in this file names a group by. */
const groupIdShort = (groupId: string) => `${groupId.slice(0, 8)}...`;

/**
 * Ensure a conversation row exists for `group`, creating the placeholder if it does not.
 *
 * @returns Whether the device can now route for this group - see {@link EnsureConversationOutcome}.
 */
export async function ensureConversationForServerGroup(
  group: ServerGroupRow,
  deps: EnsureConversationDeps
): Promise<EnsureConversationOutcome> {
  const { mlsService, userId, conversations, saveConversation, owedExits, log } = deps;
  const groupId = group.groupId;

  // BY `id`, NEVER BY THE MAP KEY. A direct conversation learnt from a Welcome is keyed by the
  // PEER'S USER ID, so `conversations.has(groupId)` answers "no" for a group this device already
  // holds a perfectly good row for - and creating a second one is the duplicate-DM defect that
  // `mergeDirectConversationDuplicates` exists to clean up afterwards.
  const known = [...conversations.entries()].find(([, c]) => c.id === groupId);
  if (known) {
    // What a rename still owes first: once the server's copy is written, the list in hand is the
    // one stale fact, and the label repair would report a disagreement the write has just ended.
    if (!deps.nameSync && known[1].nameSync) {
      Log.d(
        'Discovery',
        `${groupIdShort(groupId)} owes a rename's frame or server copy - left to the connection sweep, label not repaired here`
      );
      await recordGroupStart(known[0], group, conversations, saveConversation);
      return 'existed';
    }
    if (
      deps.nameSync &&
      (await settleNameSync(
        known[0],
        group,
        deps.nameSync,
        mlsService,
        conversations,
        saveConversation,
        log
      ))
    ) {
      await recordGroupStart(known[0], group, conversations, saveConversation);
      return 'existed';
    }
    const row = conversations.get(known[0]) ?? known[1];
    await repairGroupLabel(known[0], row, group, conversations, saveConversation, log);
    await recordGroupStart(known[0], group, conversations, saveConversation);
    return 'existed';
  }

  // A GROUP THIS DEVICE IS CREATING IS NOT "MISSING LOCALLY", IT IS ON ITS WAY IN. The server lists
  // it from `registerMember` on, and the creation writes its row only once the group is reachable,
  // at the end - so a sweep in between saw a listed group with no row and wrote a placeholder for
  // it (LEAF-REFRESH-1, 2026-11-16). The creation's own mark answers, never a delay: it is set
  // before the server can list the group and released after the row exists (`groupsInCreation.ts`).
  if (isGroupInCreation(groupId)) {
    Log.d(
      'Discovery',
      `${groupIdShort(groupId)} is being created by this device - its row is the creation's to write`
    );
    return 'in-creation';
  }

  // A GROUP THIS DEVICE HAS ALREADY DECIDED TO LEAVE IS NOT "MISSING LOCALLY", IT IS ON ITS WAY OUT.
  // Without this, DEL-10's group came back: the delete met no server, the local state was purged,
  // and the very next sweep saw a server group with no local row and helpfully re-created it as a
  // placeholder - so the user's deletion was undone by the reconciler that is supposed to serve it.
  // The owed-exit row is the only thing that can tell the two apart, because on the wire they are
  // identical: a server group this client does not have.
  if (owedExits.has(groupId)) {
    // Never silent: this is the branch that makes a server group invisible, and the reader who
    // wonders where a group went must find the reason rather than deduce it.
    log(
      `[DISCOVERY] ${groupIdShort(groupId)} not re-created - this device owes the server an exit for it`
    );
    return 'exit-owed';
  }

  // Resolve the DM peer authoritatively: the group name is only a hint and may be malformed
  // (legacy groups can carry a self-only name -> a bogus "conversation with yourself").
  // When it is unusable, fall back to the server roster. A DM whose peer cannot be resolved yet
  // (transport error, or roster transiently self-only mid re-add) is skipped, not shown as self.
  const directPeer = group.isGroup
    ? null
    : await resolveDirectPeerId(mlsService, groupId, group.name || '', userId, log);
  if (!group.isGroup && !directPeer) {
    log(`[DISCOVERY] DM "${groupIdShort(groupId)}" peer unresolved - skip (retry next sync)`);
    return 'peer-unresolved';
  }
  const displayName = directPeer || group.name || groupId;

  // Local dedup: if a direct conv with this same peer already exists under a different groupId
  // (server-side duplicate), do not create a second placeholder.
  //
  // A TOMBSTONE IS NOT A CANDIDATE - `canRepresentThePeer`, applied by the finder, and this is the
  // user's own report of 2026-08-23: a 1v1 pending local deletion blocked the arrival of the NEW
  // conversation with that same peer. A record that exists only to be removed must not refuse its
  // own replacement.
  if (directPeer) {
    const alreadyLoaded = findDirectConversationByPeer(conversations, directPeer)?.[1];
    if (alreadyLoaded) {
      log(`[DISCOVERY] Duplicate ignored for "${directPeer}" (existing: ${alreadyLoaded.id})`);
      return 'duplicate';
    }
  }

  const key = groupId; // map key = groupId
  // A group already present in the local WASM (joined via an external commit before this ran) is
  // live: mark it active so the UI leaves the "syncing" placeholder state without a reload.
  // Otherwise it stays pending until the Welcome is processed.
  const joinedLocally = holdsGroupState(mlsService, groupId);
  // The server's own `isGroup` is the identity here: this row is built FROM the roster entry, so
  // there is nothing to parse out of a name.
  conversations.set(
    key,
    buildConversationRow({
      id: groupId,
      lifecycle: joinedLocally ? 'active' : 'pending',
      identity: {
        conversationType: group.isGroup ? 'group' : 'direct',
        contactName: displayName,
        displayName,
        ...(directPeer ? { directPeerId: directPeer } : {}),
      },
      imageMediaId: group.imageMediaId ?? null,
      startedAt: groupStartInstant(group),
    })
  );
  if (saveConversation) {
    try {
      await saveConversation(key);
    } catch (e) {
      log(`[WARN] Placeholder persistence failed for ${groupId}: ${String(e)}`);
    }
  }
  log(`[DISCOVERY] Placeholder ${groupId} created.`);
  // A FRAME MAY ALREADY BE WAITING ON THIS EXACT CONVERSATION EXISTING. The inbound handler returns
  // `false` for a group whose conversation row is missing, leaving the frame in the server queue -
  // and the only global trigger that collects those is the boot restore, which cannot produce a
  // conversation the local store has never held. This is that conversation appearing, which is
  // precisely when the frame became readable.
  //
  // IT IS THE NET AND NO LONGER THE MECHANISM. Every path that makes this device a member now
  // writes the row first, so nothing should be waiting here; a line from this call is a window
  // somebody re-opened, not a routine catch-up.
  mlsService.notifyConversationAvailable(groupId);
  return 'created';
}
