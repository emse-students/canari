/**
 * Counts the frames the inbound handler deliberately leaves UNACKNOWLEDGED, so a drain that
 * acknowledges nothing says so.
 *
 * WHY THIS EXISTS. A handler that returns `false` keeps its row in `queued_message`: the frame is
 * meant to be replayed once the group or the conversation is back, which is right. What is wrong is
 * that it is SILENT in aggregate. A device whose groups never come back re-fetches the same rows on
 * every reconnect, for the 90 days of the retention window, and the only externally visible symptom
 * is a backlog that grows and never shrinks - which reads identically to "the pull never runs", to
 * "the pull runs and everything fails", and to a device that simply has nothing to do. Those three
 * call for opposite fixes, and no count taken from the server can separate them.
 *
 * So the report is taken HERE, where the reason is known, and emitted once per drain rather than
 * once per frame - a backlog is exactly the case where per-frame logging is hundreds of lines and
 * still does not say how many there were.
 *
 * It is a tally, not a queue: it holds counts and a bounded sample of group ids, never frames.
 */

/** Why a frame reached the handler and left it unacknowledged. Each calls for a different fix. */
export type UnackedReason =
  /** The group is not in local WASM: buffered pending a Welcome, which recovery is asking for. */
  | 'unknown-group'
  /** The group is held but the conversation row is missing: waiting on the local store restore. */
  | 'absent-conversation'
  /**
   * A Graine key-distribution group the server has named as one, whose ROSTER this session cannot
   * name yet (a salon's group before its community loaded): a seed cannot be filed without it.
   * Discharged by the registration that names the scope - see `registerDistributionGroup`.
   */
  | 'unscoped-distribution-group'
  /**
   * A LIVE frame ahead of the group's epoch, for a group whose earlier frames were refused
   * `absent-conversation` and have not been redelivered yet: they are in the server queue, in order,
   * so the frame waits behind them instead of the gap healer jumping the epochs they live in. Taken
   * with `absent-conversation`, by the conversation existing - see {@link refusedBacklogIsQueued}.
   */
  | 'behind-refused-backlog';

/** How many distinct groups a report names before it stops listing them. */
const SAMPLE_LIMIT = 5;

const tally = new Map<UnackedReason, { count: number; groups: Set<string> }>();

/**
 * The same frames, kept a second way: full group ids per reason, so the EVENT that discharges a
 * reason can ask for them again.
 *
 * Separate from `tally` on purpose. The tally is a report - truncated ids, cleared by the reporter -
 * and this is a work list, cleared only by whoever acts on it. Sharing one structure would mean a
 * log line silently cancelling a retry.
 *
 * Bounded by the number of groups this device is in, and every entry is discharged by an event
 * rather than a clock: a Welcome for the group, or the conversation becoming available.
 *
 * THE SECOND EVENT USED TO BE "THE CONVERSATION STORE FINISHED ITS RESTORE", WHICH IS A BOOT EDGE -
 * a GLOBAL trigger for a PER-GROUP condition, and therefore wrong exactly when the condition is new.
 * The restore reads the LOCAL store, so it cannot produce a conversation this device has never had;
 * one appearing later has nothing scheduled to collect what is waiting on it. It is discharged per
 * group now, at the moment that group's conversation exists, which is when the frame actually
 * became readable. See {@link takeGroupAwaiting}.
 *
 * THAT IS THE NET AND NOT THE MECHANISM, and the distinction matters for what a line from it means.
 * The case that exposed it - HEAL-REVOKE-4, 2026-09-06 - was a device made REACHABLE for a group
 * five seconds before it could route for it, and that window is deleted at its source: every path
 * that makes this device a member now writes the conversation row first
 * ({@link ensureConversationForServerGroup}). So an `absent-conversation` frame is no longer an
 * expected step in joining, and a discharge here is a window somebody re-opened.
 */
const awaiting = new Map<UnackedReason, Set<string>>();

/** Records one frame left in the queue. Cheap enough to call on every such frame. */
export function noteUnackedFrame(groupId: string, reason: UnackedReason): void {
  let entry = tally.get(reason);
  if (!entry) {
    entry = { count: 0, groups: new Set() };
    tally.set(reason, entry);
  }
  entry.count++;
  if (entry.groups.size < SAMPLE_LIMIT) entry.groups.add(groupId.slice(0, 8));

  let waiting = awaiting.get(reason);
  if (!waiting) {
    waiting = new Set();
    awaiting.set(reason, waiting);
  }
  waiting.add(groupId);
  if (reason === 'absent-conversation') refusedBacklog.set(groupId, ++refusalSeq);
}

/**
 * Groups whose server queue holds frames this device refused `absent-conversation` and has not been
 * handed again since. A THIRD record, and neither of the other two can answer its question:
 * `tally` is cleared by the reporter and `awaiting` by the re-fetch that is TAKEN for it - while
 * the frames that re-fetch asked for are still on the wire. What this answers is "are there earlier
 * frames of this group still to come", which is what the gap healer must ask before it replays
 * commits past the epochs those frames were sent in (47 frames lost that way on a Pixel 6a,
 * 2026-10-14).
 *
 * Discharged by an EVENT, never a clock: a pull that listed the WHOLE mailbox and whose rows the
 * queue has then HANDLED ({@link dischargeRefusedBacklog}). A refused frame is never acknowledged, so
 * a pull started after the refusal lists it, and once the queue is idle again it has been read - or
 * refused once more, which marks the group again under a later sequence number. Not the first pulled
 * frame of the group: a 500-row page can deliver that while the rest of the backlog is still on the
 * next page. Not the end of the listing either: a live frame already in the queue AHEAD of the
 * listed rows would then reach the healer with the mark gone and its predecessors still behind it.
 *
 * Each mark carries the sequence number it was written under, so a pull discharges only the marks
 * that were already written when it STARTED - the refusals it is certain to have listed.
 */
const refusedBacklog = new Map<string, number>();
let refusalSeq = 0;

/** Whether frames refused `absent-conversation` for `groupId` are still waiting in the server queue. */
export function refusedBacklogIsQueued(groupId: string): boolean {
  return refusedBacklog.has(groupId);
}

/** The sequence number a pull starting now is certain to cover - pass it to the discharge. */
export function refusedBacklogMark(): number {
  return refusalSeq;
}

/**
 * A pull that started at `upTo` listed the whole mailbox, and the queue has handled what it listed:
 * every refusal marked at or before `upTo` has been delivered again. Later marks are kept.
 */
export function dischargeRefusedBacklog(upTo: number): void {
  for (const [groupId, seq] of refusedBacklog) {
    if (seq <= upTo) refusedBacklog.delete(groupId);
  }
}

/**
 * A pull that started at `upTo` DIED HALF-WAY: every group it was meant to re-fetch for the refused
 * backlog is owed a pull again, so each one still marked at or before `upTo` goes back on the work
 * list as `absent-conversation`.
 *
 * WHY THE WORK LIST AND THE MARK CAN DISAGREE: the event that starts a pull TAKES its groups off the
 * work list ({@link takeGroupAwaiting}), and only a pull that lists the whole mailbox discharges the
 * mark ({@link dischargeRefusedBacklog}). A pull that dies between the two left the mark standing
 * with nothing on the list - and the next event asking for this group's backlog (a held replay, a
 * held live frame) then took nothing and started no pull, so the hold lasted until a reconnect.
 * Re-armed by the failure itself, the next such event pulls again: no timer, one pull per event.
 * Rows the dead pull did list and that were refused again are already back on the list; re-adding
 * them is idempotent (a set), and the tally is left alone - nothing new was refused.
 */
export function rearmRefusedBacklog(upTo: number): void {
  for (const [groupId, seq] of refusedBacklog) {
    if (seq > upTo) continue;
    let waiting = awaiting.get('absent-conversation');
    if (!waiting) {
      waiting = new Set();
      awaiting.set('absent-conversation', waiting);
    }
    waiting.add(groupId);
  }
}

/**
 * Discharges ONE group, for the events that are per-group rather than global. True if it was owed.
 *
 * The whole-reason {@link takeGroupsAwaiting} answers a global edge - a reconnect, a boot restore.
 * This answers "THIS conversation now exists", which is the only fact that makes a frame buffered
 * as `absent-conversation` readable, and the only one a device joining a group it has never had can
 * ever produce.
 */
export function takeGroupAwaiting(reason: UnackedReason, groupId: string): boolean {
  const waiting = awaiting.get(reason);
  if (!waiting?.delete(groupId)) return false;
  if (waiting.size === 0) awaiting.delete(reason);
  return true;
}

/**
 * Returns the groups left behind for `reason` and forgets them, so the caller owns the retry.
 *
 * TAKE, not read: the point of asking is to act, and an entry that survived the action would make
 * the next event re-ask for a frame already re-fetched. A frame the retry cannot process is noted
 * again by the handler on the way through, so nothing is lost by clearing - the work list is
 * rebuilt from what actually failed rather than from what once did.
 */
export function takeGroupsAwaiting(reason: UnackedReason): string[] {
  const waiting = awaiting.get(reason);
  if (!waiting || waiting.size === 0) return [];
  awaiting.delete(reason);
  return [...waiting];
}

/**
 * Emits what has been left behind since the last report, and resets the tally.
 *
 * SINCE THE LAST REPORT, not "by this drain": the same handler serves live WebSocket frames, so a
 * report taken after a pull also covers whatever arrived over the socket meanwhile. Attributing all
 * of it to the drain would be a claim the tally cannot support, and the number is the point either
 * way.
 *
 * Silent when nothing was left behind: a report on every idle queue would be noise, and the fact
 * worth surfacing is the non-zero one.
 */
export function reportUnackedFrames(log: (msg: string) => void): void {
  if (tally.size === 0) return;
  const parts: string[] = [];
  let total = 0;
  for (const [reason, { count, groups }] of tally) {
    total += count;
    const shown = [...groups].join(', ');
    parts.push(`${reason}: ${count} [${shown}${groups.size >= SAMPLE_LIMIT ? ', …' : ''}]`);
  }
  tally.clear();
  log(
    `[PENDING] ${total} frame(s) left unacknowledged since the last report - they stay queued and will be re-fetched on every reconnect until the group is recovered. ${parts.join('; ')}`
  );
}

/** Test seam: drops the tally and the work list without reporting either. */
export function resetUnackedFrames(): void {
  tally.clear();
  awaiting.clear();
  refusedBacklog.clear();
  refusalSeq = 0;
}
