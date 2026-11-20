import type { IMlsService } from '$lib/mls-client/IMlsService';
import type { Conversation } from '$lib/types';
import {
  buildConversationRow,
  findDirectConversationByPeer,
  isRawId,
  resolveDirectPeerId,
} from './conversations';
import { holdsGroupState } from './groupUsability';
import { isGroupInCreation } from './groupsInCreation';
import { Log } from '$lib/utils/Log';
import {
  GROUP_NAME_SKIP_TEXT,
  nameStatementDue,
  ownNameStatementOutcome,
  ownRenameOutcome,
  pendingRenameVerdict,
  unconfirmedFrom,
  withNameSync,
  type NameStatementOutcome,
  type NameSync,
  type OwnNameStatement,
  type PendingRename,
} from './groupName';
import { BUNDLE_SERVER_TIME_SKEW_MS } from './messageTime';
import { noteServerTime } from './serverClock';
import type { RenameResendOutcome } from './groupActions';

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
  ) => Promise<RenameResendOutcome>;
  /** `sendNameStatement`, bound to this device's key: one silent `groupNamed` statement. */
  state: (
    statement: Omit<OwnNameStatement, 'answered'>,
    groupId: string
  ) => Promise<NameStatementOutcome>;
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
  if (isRawId(convo.name)) {
    // The row carried a RAW ID as its name while the server holds a real one: the list drew this
    // group by its members' first names (`resolveConversationListPresentation`). An EMPTY row name
    // is the ordinary state of a group unnamed at creation, so it says nothing here (the relabel
    // line below still does); a raw id is the visible end of a name that never reached us.
    console.warn(
      `[GROUP_LABEL] ${groupIdShort(group.groupId)} is named "${serverName}" server-side but its row held a raw id - it was drawn by its members until this repair`
    );
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
 * which visits every active group - never on a clock.
 *
 * ONLY ONCE THIS LINK HAS DRAINED THE GROUP (`isGroupDrained`: a pull listed the whole mailbox since
 * the socket opened, and the group's frames are all processed). Both halves compare the row with
 * what the members said since the rename; a row read before this device has read what arrived while
 * it was out answers "nothing happened since" for a group where a member renamed it - and a re-send
 * then put the older rename over the newer one, for every member, and an owed copy went over a name
 * that had come back (A -> O). A connection whose pull failed still runs this sweep, so the group is
 * asked, never assumed: not drained, the settlement waits for the next sweep, and says so.
 *
 * THE PENDING FRAME (its first send got no answer). Read off the row (`pendingRenameVerdict`): a row
 * that no longer holds the statement it was made over - another name, or the same name under another
 * date - keeps the frame `unconfirmed`, since re-sending would put it over that statement; a row that
 * holds the name, dated, saw it land, so only the server's copy is owed. Otherwise the SAME frame is
 * re-sent (`NameSyncSettler.resend`) - only within the receivers' bound, less a margin for the
 * send's own latency (`RENAME_RESEND_MARGIN_MS`), as the server's clock read in this sweep proves it:
 * past it every member would refuse the frame and still draw its notice, so it is kept `unconfirmed`,
 * unsent. No answer to that read, or an answer with no readable clock, keeps it pending; a group the
 * server holds no live row for keeps it `unconfirmed` - this device's clock decides nothing here. A
 * re-send with no answer, or not made, keeps it pending; a re-send ANSWERED with a refusal that ends
 * it keeps it `unconfirmed`. Every frame this device stops re-sending may still have reached the
 * members: a member's relayed copy of its notice settles it (`ownRenameFromRelay`).
 *
 * THE SERVER'S COPY, COMPARE-AND-SET, on the server's name READ AGAIN for this group right before the
 * write (`getGroupMeta`), never on the list the sweep read at its start, which every group before
 * this one in the sweep has aged. Written only while the row still holds the owed name AND the server
 * still holds the name the rename was made over (`OwedServerCopy.from`): a server naming anything
 * else was written by a later rename, and an owed copy never goes over it. The residual race is one
 * round trip wide: a member's write landing between that read and this write.
 *
 * @returns true when this pass wrote the server's copy (the list in hand is then stale for this group).
 */
async function settleNameSync(
  key: string,
  group: ServerGroupRow,
  settler: NameSyncSettler,
  mlsService: IMlsService,
  userId: string,
  conversations: Map<string, Conversation>,
  saveConversation: ((key: string) => Promise<void>) | undefined,
  log: (msg: string) => void
): Promise<boolean> {
  const start = conversations.get(key);
  if (!start?.nameSync) return false;
  const short = groupIdShort(group.groupId);
  if (!start.nameSync.pending && !start.nameSync.serverCopy) return false;
  if (!mlsService.isGroupDrained(group.groupId)) {
    log(
      `[GROUP_NAME] ${short} owes a rename's frame or server copy - left to the next sweep: this link has not drained the group yet, so the row may not hold what the members said since`
    );
    return false;
  }
  const save = async () => {
    await saveConversation?.(key).catch((e) => {
      console.error(
        `[GROUP_NAME] ${short} name sync settled but not saved - it runs again next connection: ${String(e).slice(0, 120)}`
      );
    });
  };
  const replace = async (sync: NameSync, row?: Conversation) => {
    const base = row ?? conversations.get(key);
    if (!base) return;
    conversations.set(key, withNameSync(base, sync));
    await save();
  };
  const pending = start.nameSync.pending;
  if (pending) {
    await settlePendingRename(
      key,
      group,
      pending,
      settler,
      mlsService,
      userId,
      conversations,
      replace,
      log
    );
  }

  const convo = conversations.get(key);
  const owed = convo?.nameSync?.serverCopy;
  if (!convo || !owed) return false;
  const dropCopy = () => replace({ ...convo.nameSync, serverCopy: undefined });
  if (convo.name !== owed.name) {
    await dropCopy();
    log(
      `[GROUP_NAME] ${short} server copy owed dropped - the row moved on to a later name, whose own rename writes the copy`
    );
    return false;
  }
  let serverName: string;
  try {
    const meta = await mlsService.getGroupMeta(group.groupId);
    if (!meta) throw new Error('no group row answered');
    serverName = (meta.name ?? '').trim();
  } catch (e) {
    console.warn(
      `[GROUP_NAME] ${short} server copy still owed - the server's name could not be read again before the write: ${String(e).slice(0, 120)}`
    );
    return false;
  }
  if (serverName === owed.name) {
    await dropCopy();
    log(`[GROUP_NAME] ${short} server copy owed already held by the server - nothing owed`);
    return false;
  }
  if (serverName !== owed.from) {
    await dropCopy();
    console.warn(
      `[GROUP_NAME] ${short} server copy owed DROPPED, not written - the server no longer holds the name the rename was made over, so a later rename wrote it and an owed copy never goes over that`
    );
    return false;
  }
  try {
    await mlsService.renameGroup(convo.id, convo.name);
  } catch (e) {
    console.warn(
      `[GROUP_NAME] ${short} server copy still owed - the write failed again: ${String(e).slice(0, 120)}`
    );
    return false;
  }
  const after = conversations.get(key) ?? convo;
  await replace({ ...after.nameSync, serverCopy: undefined }, after);
  log(`[GROUP_NAME] ${short} server copy owed written - nothing owed`);
  return true;
}

/** The pending half of {@link settleNameSync}: leaves the row's `nameSync` saying what is still owed. */
async function settlePendingRename(
  key: string,
  group: ServerGroupRow,
  pending: PendingRename,
  settler: NameSyncSettler,
  mlsService: IMlsService,
  userId: string,
  conversations: Map<string, Conversation>,
  replace: (sync: NameSync, row?: Conversation) => Promise<void>,
  log: (msg: string) => void
): Promise<void> {
  const id = `${groupIdShort(group.groupId)} rename ${pending.messageId.slice(0, 8)}`;
  const current = conversations.get(key);
  if (!current) return;
  const verdict = pendingRenameVerdict(current, pending);
  if (verdict === 'superseded') {
    await replace(unconfirmedFrom(current.nameSync, pending));
    log(
      `[GROUP_NAME] ${id} not re-sent - another name was stated since; kept unconfirmed, settled by a member's relayed copy if it landed`
    );
    return;
  }
  if (verdict === 'landed') {
    await replace({
      ...current.nameSync,
      pending: undefined,
      serverCopy: { name: pending.name, from: pending.over.name },
    });
    log(`[GROUP_NAME] ${id} pending frame came back - only the server copy owed`);
    return;
  }
  // RE-SENT ONLY WITHIN A BOUND THE SERVER'S OWN CLOCK PROVES. Every receiver measures its bound on
  // the server's stamp, and a re-send past it is refused by every one of them while each still
  // draws the rename's notice - a notice for a name nobody took. So the server's clock is read NOW,
  // in this sweep (`GroupMeta.serverNow`, the `Date` of its answer), never this device's clock nor
  // an older server time it holds. The group row read is answered by TYPE: no answer keeps the frame
  // pending; a group the server holds no live row for keeps it `unconfirmed` (no member is left to
  // re-send to); an answer with no clock it can read is an unknown, not a refusal, so the frame stays
  // pending until one is readable - a phone build reaches the stores before production serves the
  // exposed header, and shelving every rename swept in that window lost them for good.
  const status = await mlsService.getGroupServerStatus(group.groupId);
  if (status === 'error') {
    log(`[GROUP_NAME] ${id} still pending - the group row read got no answer this sweep`);
    return;
  }
  if (status === 'absent' || status.deletedAt) {
    await replace(unconfirmedFrom(current.nameSync, pending));
    log(
      `[GROUP_NAME] ${id} not re-sent - the server holds no live group (${status === 'absent' ? 'no row' : 'deleted'}); kept unconfirmed, settled by a member's relayed copy if its first copy landed`
    );
    return;
  }
  // A server time like any other: noted, it bounds what the next rename's base is dated by.
  noteServerTime(userId, status.serverNow);
  if (status.serverNow === undefined) {
    if (!clocklessFramesSaid.has(pending.messageId)) {
      clocklessFramesSaid.add(pending.messageId);
      console.warn(
        `[GROUP_NAME] ${id} still pending - the server's answer carried no readable clock (an estate older than this build?), so whether the receivers would take a re-send cannot be proven; re-sent once a clock is readable`
      );
    }
    return;
  }
  const lead = status.serverNow - pending.sentAt;
  if (
    lead > BUNDLE_SERVER_TIME_SKEW_MS - RENAME_RESEND_MARGIN_MS ||
    -lead > BUNDLE_SERVER_TIME_SKEW_MS
  ) {
    await replace(unconfirmedFrom(current.nameSync, pending));
    console.error(
      `[GROUP_NAME] ${id} NOT re-sent - the server's clock lies ${lead >= 0 ? 'too close to or past' : 'beyond'} the receivers' bound from its signed sentAt, so the members could refuse it; kept unconfirmed, settled by a member's relayed copy if its first copy landed`
    );
    return;
  }
  const outcome = await settler.resend(pending, group.groupId, key);
  if ('kept' in outcome) {
    log(`[GROUP_NAME] ${id} re-send ${outcome.kept} - still pending`);
    return;
  }
  // Re-read: the re-send wrote this device's own notice row meanwhile.
  const after = conversations.get(key);
  if (!after) return;
  if ('refused' in outcome) {
    await replace(unconfirmedFrom(after.nameSync, pending));
    console.error(
      `[GROUP_NAME] ${id} re-send REFUSED (${outcome.refused}) - not sent again; kept unconfirmed, settled by a member's relayed copy if its first copy landed`
    );
    return;
  }
  const sent = outcome.sent;
  const own = ownRenameOutcome(after, pending.name, sent.receivedAt, true, pending.over);
  if ('row' in own) {
    await replace(own.row.nameSync ?? {}, own.row);
    log(`[GROUP_NAME] ${id} re-sent and delivered - the server copy follows`);
  } else {
    await replace({ ...after.nameSync, pending: undefined });
    log(`[GROUP_NAME] ${id} re-sent and delivered, row kept: ${GROUP_NAME_SKIP_TEXT[own.skipped]}`);
  }
}

/**
 * How far INSIDE the receivers' late bound a re-send must be, as the server's clock reads it in the
 * sweep. The frame is stamped after that read, by the send's latency - seconds, minutes on a slow
 * link - and the `Date` it is read from is floored to the second; a re-send read at the bound's last
 * second is stamped past it, refused by every member, and each still draws its notice. Ten minutes
 * is a margin, not a proof: a send stamped later than that after the read still crosses the bound,
 * and its answer then comes back typed `clock` (`sendRenameFrame`), which ends the re-sending. The
 * early side needs none: a later stamp only moves the frame inside the bound.
 */
export const RENAME_RESEND_MARGIN_MS = 10 * 60_000;

/**
 * The pending frames whose missing server clock this tab has already said - once per frame, not once
 * per sweep: the state repeats on every connection until the estate serves the header.
 */
const clocklessFramesSaid = new Set<string>();

/**
 * THE ONE-TIME RESTATEMENT OF A GROUP'S NAME (sealed-names.md, step 2). A group that existed before
 * names were dated holds an undated name on every device, and step 3 takes the server's copy away:
 * so one member device states the name it holds, once, as a SILENT `groupNamed` frame, and every
 * member dates the name by it. Any member device of this build may be that one - the first to sweep
 * the group after the update. Two that cross are two statements of the same rank, settled by the
 * tie rule; a rename crossing one beats it whatever the dates (`groupNameSupersedes`).
 *
 * ONCE, BY STORED STATE, NEVER BY A CLOCK OR A SESSION (`nameStatementDue`): a row a statement or a
 * rename dated is never stated again - the date on the row is the proof, and it is persisted with the
 * name; a statement answered with no time is recorded as `answered`; one with no answer is recorded,
 * and re-sent as the same frame here at the next connection.
 *
 * Only once this link has DRAINED the group (`isGroupDrained`), so the row holds what the members said
 * while this device was out - a rename among them dates it, and nothing is stated. Only within the
 * receivers' bound, as the server's clock READ IN THIS PASS proves it (`getGroupServerStatus`, the
 * rename re-send's rule and margin): a statement every member refuses dates nothing. Never a notice:
 * a group being dated was not renamed.
 */
async function stateGroupNameOnce(
  key: string,
  group: ServerGroupRow,
  settler: NameSyncSettler,
  mlsService: IMlsService,
  userId: string,
  conversations: Map<string, Conversation>,
  saveConversation: ((key: string) => Promise<void>) | undefined,
  log: (msg: string) => void
): Promise<void> {
  if (!group.isGroup) return;
  const start = conversations.get(key);
  if (!start) return;
  const due = nameStatementDue(start, group.name ?? '');
  // Every `not` is the ordinary state of some row on every sweep - a dated group above all - so none
  // is a line.
  if ('not' in due) return;
  const short = groupIdShort(group.groupId);
  if (!mlsService.isGroupDrained(group.groupId)) {
    log(
      `[GROUP_NAME] ${short} name statement left to the next sweep - this link has not drained the group, so a rename among what arrived may still date it`
    );
    return;
  }
  const status = await mlsService.getGroupServerStatus(group.groupId);
  if (status === 'error') {
    log(
      `[GROUP_NAME] ${short} name statement left to the next sweep - the group row read got no answer`
    );
    return;
  }
  if (status === 'absent' || status.deletedAt) {
    log(
      `[GROUP_NAME] ${short} name not stated - the server holds no live group (${status === 'absent' ? 'no row' : 'deleted'})`
    );
    return;
  }
  noteServerTime(userId, status.serverNow);
  if (status.serverNow === undefined) {
    if (!clocklessStatementsSaid.has(group.groupId)) {
      clocklessStatementsSaid.add(group.groupId);
      console.warn(
        `[GROUP_NAME] ${short} name not stated yet - the server's answer carried no readable clock, so whether the receivers would take the statement cannot be proven; stated once a clock is readable`
      );
    }
    return;
  }
  const inBound = (sentAt: number) => {
    const lead = status.serverNow! - sentAt;
    return (
      lead <= BUNDLE_SERVER_TIME_SKEW_MS - RENAME_RESEND_MARGIN_MS &&
      -lead <= BUNDLE_SERVER_TIME_SKEW_MS
    );
  };
  let minted: Omit<OwnNameStatement, 'answered'>;
  if (due.due === 'resend' && inBound(due.statement.sentAt)) {
    minted = {
      name: due.statement.name,
      messageId: due.statement.messageId,
      sentAt: due.statement.sentAt,
    };
  } else {
    // A fresh statement, signed with this device's clock: sent only when the server's clock read in
    // this pass proves the receivers will take it. A recorded one past the bound is replaced by it.
    const sentAt = Date.now();
    if (!inBound(sentAt)) {
      if (!skewedStatementsSaid.has(group.groupId)) {
        skewedStatementsSaid.add(group.groupId);
        console.error(
          `[GROUP_NAME] ${short} name NOT stated - this device's clock lies outside the receivers' bound from the server's (${Math.round((sentAt - status.serverNow) / 60_000)} min), so every member would refuse it; stated once the clock is right`
        );
      }
      return;
    }
    minted = { name: start.name, messageId: crypto.randomUUID(), sentAt };
  }
  const outcome = await settler.state(minted, group.groupId);
  // Re-read: a frame read during the send may have dated the row already.
  const after = conversations.get(key);
  if (!after) return;
  const next = ownNameStatementOutcome(after, minted, outcome);
  if (next) {
    conversations.set(key, next);
    await saveConversation?.(key).catch((e) => {
      console.error(
        `[GROUP_NAME] ${short} name statement settled but not saved - it runs again next connection: ${String(e).slice(0, 120)}`
      );
    });
  }
  log(
    `[GROUP_NAME] ${short} name ${due.due === 'resend' && minted.messageId === due.statement.messageId ? 're-stated (same frame)' : 'stated'} ${minted.messageId.slice(0, 8)}: ${Object.keys(outcome)[0]} - the row is ${next?.nameAt !== undefined ? 'dated' : 'undated'}`
  );
}

/** The groups whose missing server clock this tab already said, for a name statement. */
const clocklessStatementsSaid = new Set<string>();

/** The groups whose statement this tab already refused to sign with a clock outside the bound. */
const skewedStatementsSaid = new Set<string>();

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
    if (!deps.nameSync && (known[1].nameSync?.pending || known[1].nameSync?.serverCopy)) {
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
        userId,
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
    // AFTER the label repair: what is restated is the name the row and the list now agree on.
    if (deps.nameSync) {
      await stateGroupNameOnce(
        known[0],
        group,
        deps.nameSync,
        mlsService,
        userId,
        conversations,
        saveConversation,
        log
      );
    }
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
