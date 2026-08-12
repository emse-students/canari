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
  | 'absent-conversation';

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
 * rather than a clock: a Welcome for the group, or the conversation store finishing its restore.
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
}
