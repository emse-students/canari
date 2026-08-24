/**
 * THE EXIT THIS DEVICE DECIDED AND THE SERVER HAS NOT ANSWERED YET.
 *
 * WHAT WAS WRONG, MEASURED. DEL-10 deletes a group with the link cut and reconnects. It recorded, on
 * `c6eb7b20`: one DELETE attempted while offline, zero on the first reconnect, zero on the second,
 * the group still listed on the server, and the deleter's own log carrying `[MLS] Message for absent
 * conversation ... - retry after restore`. The deletion had been LOST, and lost silently: the local
 * MLS state and the conversation row were destroyed anyway, so the server kept a group the client
 * could no longer open, and `discoverMissingGroups` handed it straight back as a placeholder.
 *
 * The seam was one `try/catch` in `exitGroupAndCleanup` that treated "the server said 404" and "there
 * was no server" as the same outcome, and then purged either way - a fallback used as a PATH. The two
 * are not the same fact and the difference is the whole defect: a status is an ANSWER, a transport
 * failure is the absence of one.
 *
 * WHAT REPLACES IT, AND WHY NOTHING HERE IS TIMED. The decision is written down BEFORE the call, in
 * durable storage. The row is removed only when the server ANSWERS - success, or a status saying the
 * group is already gone. A transport failure leaves it exactly where it is, logged at a level that
 * accuses, and the reconnect that follows replays it. So:
 *
 *  - IDEMPOTENCE comes from the row: one per `groupId`, so deciding twice cannot queue two calls, and
 *    a drain that runs twice over one row makes one call.
 *  - TERMINATION comes from a PROOF - the server's answer - never from an attempt count or a clock.
 *    An exit owed to a server that is down stays owed, which is the only honest state.
 *  - The TRIGGER is {@link ConnectivityStore.onReconnect}, an event, plus one pass at chat start for
 *    the app that was killed while offline and will never see an `online` event for that link.
 *
 * WHY IT IS NOT THE MESSAGE OUTBOX. `OutboxEntry`'s flusher sends THROUGH the MLS group, and the
 * purge this path performs is what destroys that group's state. The two calls replayed here are plain
 * authenticated HTTP and need no MLS tree at all, which is precisely why they can still be completed
 * after the local state is gone.
 *
 * WHAT IS DELIBERATELY NOT RECOVERED: the MLS broadcast that would have told the other members
 * immediately. It cannot be replayed - the group state it needed is gone - and it does not have to
 * be: the members learn of a deleted group from the server on their next pull, which is the same path
 * every offline member already uses.
 */
import type { IStorage, PendingGroupExit } from '$lib/db/types';
import type { IMlsService } from '$lib/mls-client/IMlsService';
import { GroupExitRefusedError } from '$lib/mls-client/mlsDeliveryApi';
import { connectivity, isTransportFailure } from '$lib/stores/connectivity.svelte';

/** Logger shape shared with the rest of `utils/chat` - the caller owns where the line goes. */
type Log = (message: string) => void;

/**
 * Statuses that mean THE EXIT ALREADY HAPPENED, so the row has done its job and goes.
 *
 * 404: the server holds no such group - the end state a delete asks for. 403: the caller is not a
 * member of it - the end state a leave asks for, and the one status these endpoints return to state
 * exactly that (`NotAGroupMemberError` documents the same reading next door).
 *
 * Every other status is the server being reachable and refusing, which is a defect somewhere and NOT
 * a reason to forget the decision.
 */
const ALREADY_GONE_STATUSES = new Set([403, 404]);

/**
 * What happened to an exit call that did not simply succeed. Three outcomes, two behaviours:
 *
 *  - `already-gone` - the server answered that the end state is reached. Nothing is owed.
 *  - `refused`      - the server is reachable and said no. The exit is KEPT: a server that is up and
 *                     refusing is a defect to find, never a decision to forget.
 *  - `unreachable`  - no answer at all. The exit is KEPT and the next reconnect replays it.
 */
export type ExitFailure = 'already-gone' | 'refused' | 'unreachable';

/**
 * Classify a failed exit call, ONCE, where both callers can ask.
 *
 * `exitGroupAndCleanup` and {@link drainPendingGroupExits} face the same three outcomes and must
 * agree about them: one deciding a 403 means "gone" while the other reads it as "refused" is a group
 * that is purged locally and never released server-side, which is DEL-10 all over again with the two
 * halves swapped. A shared classifier is the only way that disagreement cannot arise.
 */
export function classifyExitFailure(error: unknown): ExitFailure {
  if (error instanceof GroupExitRefusedError) {
    return ALREADY_GONE_STATUSES.has(error.status) ? 'already-gone' : 'refused';
  }
  // NOT "everything else is unreachable": a bug in this path throws too, and calling that a network
  // problem would keep a row for ever while blaming the link. `isTransportFailure` is the same
  // predicate `apiFetch` uses to decide the server is unreachable, so the two cannot drift.
  return isTransportFailure(error) ? 'unreachable' : 'refused';
}

/**
 * Write down that this device owes the server an exit for `groupId`, before attempting it.
 *
 * Best-effort by necessity - a storage that refuses must not stop the user leaving a group - but
 * never silent: without this row the exit is exactly as recoverable as it was before DEL-10, so the
 * failure is the one thing a reader needs to see if the deletion later comes back.
 */
export async function recordPendingGroupExit(
  storage: IStorage | null | undefined,
  groupId: string,
  kind: PendingGroupExit['kind'],
  log: Log
): Promise<void> {
  if (!storage) {
    log(
      `[EXIT] ${groupId.slice(0, 8)}... ${kind} NOT recorded durably - no storage; a transport ` +
        'failure now would lose it'
    );
    return;
  }
  try {
    await storage.savePendingGroupExit({ groupId, kind, requestedAt: Date.now() });
    log(`[EXIT] ${groupId.slice(0, 8)}... ${kind} recorded as owed to the server`);
  } catch (e) {
    log(
      `[EXIT] ${groupId.slice(0, 8)}... ${kind} could NOT be recorded (${String(e)}) - a transport ` +
        'failure now would lose it'
    );
  }
}

/** Forget the exit owed for `groupId`. Called only where the server has answered. */
export async function clearPendingGroupExit(
  storage: IStorage | null | undefined,
  groupId: string,
  log: Log
): Promise<void> {
  if (!storage) return;
  try {
    await storage.deletePendingGroupExit(groupId);
  } catch (e) {
    // The call SUCCEEDED and only the bookkeeping failed, so the exit is done; the row that stayed
    // will be replayed once more on the next reconnect and answered with a 404, which clears it.
    // Logged because a row that will not clear is how a drain becomes a loop.
    log(`[EXIT] ${groupId.slice(0, 8)}... could not clear its pending row (${String(e)})`);
  }
}

/**
 * The groupIds this device owes an exit for - what discovery must refuse to re-create.
 *
 * Returns an EMPTY set when storage is absent or unreadable, and that is the safe direction here: an
 * empty set only means discovery re-creates a placeholder the drain will delete a moment later,
 * whereas inventing ids would hide real groups from a user who never asked to leave them.
 */
export async function pendingGroupExitIds(
  storage: IStorage | null | undefined
): Promise<Set<string>> {
  if (!storage) return new Set();
  try {
    return new Set((await storage.getPendingGroupExits()).map((e) => e.groupId));
  } catch {
    return new Set();
  }
}

/** One replayed exit, as the drain reports it. */
export type DrainOutcome = {
  groupId: string;
  kind: PendingGroupExit['kind'];
  /** `answered` - the server responded and the row is gone. `kept` - no answer, still owed. */
  result: 'answered' | 'kept';
};

/**
 * Replay every exit still owed, once each, and clear the ones the server answers.
 *
 * SAFE TO RE-ENTER, which {@link ConnectivityStore.onReconnect} requires of its listeners: a flapping
 * link fires it repeatedly, and a second pass over a row whose call already landed asks the server to
 * delete a group that is already gone - answered with a 404, which clears the row. The re-entrancy
 * guard is there so a flap during a slow call cannot make two in-flight copies of it.
 *
 * A ROW IS NEVER DROPPED FOR FAILING. There is no attempt counter and no expiry: a delete the server
 * has not answered is still owed a week later, and a row deleted "after N tries" would be this
 * defect wearing a budget. The one thing that removes a row is an answer.
 */
let draining = false;

export async function drainPendingGroupExits(params: {
  storage: IStorage | null | undefined;
  mlsService: IMlsService;
  userId: string;
  log: Log;
}): Promise<DrainOutcome[]> {
  const { storage, mlsService, userId, log } = params;
  if (!storage || draining) return [];
  draining = true;
  try {
    let owed: PendingGroupExit[];
    try {
      owed = await storage.getPendingGroupExits();
    } catch (e) {
      log(`[EXIT] pending exits unreadable (${String(e)}) - nothing replayed`);
      return [];
    }
    if (owed.length === 0) return [];
    log(`[EXIT] replaying ${owed.length} exit(s) the server never answered`);

    const outcomes: DrainOutcome[] = [];
    for (const entry of owed) {
      const short = entry.groupId.slice(0, 8);
      try {
        if (entry.kind === 'delete') {
          const deleted = await mlsService.deleteGroupOnServer(entry.groupId);
          // `false` is the 404: the group is not there, which is the end state asked for.
          log(
            `[EXIT] ${short}... delete replayed - server ${deleted ? 'deleted it' : 'had no such group'}`
          );
        } else {
          await mlsService.removeMemberFromServer(entry.groupId, userId);
          log(`[EXIT] ${short}... leave replayed - server removed this user`);
        }
        // The per-user dismiss is what stops the OTHER devices of this account showing the group
        // again (rules 3 & 5). It was lost with the exit, so it is replayed with it - and its own
        // failure may not keep the row, because the exit itself has been answered.
        await mlsService.dismissGroup(entry.groupId).catch((e: unknown) => {
          log(`[EXIT] ${short}... dismiss not recorded on the server (${String(e)})`);
        });
        await clearPendingGroupExit(storage, entry.groupId, log);
        outcomes.push({ groupId: entry.groupId, kind: entry.kind, result: 'answered' });
      } catch (e) {
        const failure = classifyExitFailure(e);
        if (failure === 'already-gone') {
          log(`[EXIT] ${short}... ${entry.kind} already done server-side - clearing`);
          await clearPendingGroupExit(storage, entry.groupId, log);
          outcomes.push({ groupId: entry.groupId, kind: entry.kind, result: 'answered' });
          continue;
        }
        // KEPT, AND THE TWO REASONS ARE LOGGED SEPARATELY, because they call for different actions:
        // no answer means try again when the link is back, while a refusal with a status means the
        // server is up and something is wrong with the request or with it.
        if (failure === 'unreachable') {
          log(`[EXIT] ${short}... ${entry.kind} still unreachable - kept, will retry on reconnect`);
        } else {
          log(
            `[EXIT] ${short}... ${entry.kind} REFUSED by a reachable server (${String(e)}) - kept`
          );
        }
        outcomes.push({ groupId: entry.groupId, kind: entry.kind, result: 'kept' });
      }
    }
    return outcomes;
  } finally {
    draining = false;
  }
}

/** What the registered drain needs, read lazily - storage and MLS both arrive after login. */
type DrainDeps = {
  getStorage: () => IStorage | null | undefined;
  ensureMls: () => IMlsService;
  getUserId: () => string;
  log: Log;
};

let registered: DrainDeps | null = null;
let unsubscribeReconnect: (() => void) | null = null;

/**
 * Bind the drain to connectivity returning, for one session.
 *
 * ONE LIFECYCLE, like the outbox next door: login registers, logout unregisters, and no flag decides
 * whether a listener exists. The teardown matters as much as the install - a listener left behind
 * would replay the previous user's exits with the next user's token.
 *
 * `connectivity.onReconnect` and not `window.online`, for the reason WP-OUTBOX-1 measured: offline is
 * `!isOnline || !serverReachable`, two facts restored by two different events, and only this seam
 * means "the condition that blocked you has cleared".
 */
export function registerPendingGroupExitDrain(deps: DrainDeps): void {
  unregisterPendingGroupExitDrain();
  registered = deps;
  unsubscribeReconnect = connectivity.onReconnect(() => {
    void flushPendingGroupExits();
  });
}

/** Detach the reconnect listener and forget the session it closed over. */
export function unregisterPendingGroupExitDrain(): void {
  unsubscribeReconnect?.();
  unsubscribeReconnect = null;
  registered = null;
  draining = false;
}

/**
 * Replay the owed exits of the registered session, now.
 *
 * Called on reconnect AND once from startup, and the second call is not redundant: an app KILLED
 * while offline comes back with the link already up, so no `online` edge ever fires for it and the
 * event alone would leave the row owed until the next flap. One pass at startup is what makes the
 * recovery independent of how the app came back.
 */
export async function flushPendingGroupExits(): Promise<DrainOutcome[]> {
  if (!registered) return [];
  const { getStorage, ensureMls, getUserId, log } = registered;
  const userId = getUserId();
  if (!userId) return [];
  return drainPendingGroupExits({ storage: getStorage(), mlsService: ensureMls(), userId, log });
}

/**
 * Reset the re-entrancy guard. Tests only - a module-level flag left set by a rejected drain would
 * silence every later one in the same process, and a test file is the only place that can happen.
 */
export function resetDrainGuardForTests(): void {
  draining = false;
}
