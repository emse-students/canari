/**
 * THE KEYS OF A CALL ANSWERED ON THE NATIVE RING WAIT FOR ITS OWN GROUP, NEVER FOR EVERY GROUP.
 *
 * The media keys of a call are its conversation's MLS `exportSecret` at the current epoch
 * (`utils/callKeys.ts`), and the "answered" notice is sent in that group. Nothing else the session
 * catches up on changes them. Until 1.8.4 the join waited for `ConnectionDeps.onCaughtUp` - the
 * catch-up of EVERY conversation - and on the owner's phone (1.8.2, 2026-11-27) that was 10.7 s of
 * a resume's 180 frames of other conversations between the tap and the join.
 *
 * THE ONE PROOF: this device holds the group at EXACTLY the epoch the delivery service holds for
 * it (`GET /api/mls/groups/:id`, `activeEpoch`). Every accepted commit advances the server's epoch
 * under its lock (`baseEpoch == activeEpoch`), so a local epoch equal to it has no commit left to
 * apply, and `exportSecret` there is what every member at that epoch derives. The call's invite and
 * its ring carry no epoch, so the server's row is the only statement of "current" there is.
 *
 * - "Drained" is NOT a proof - applied is not current. The one exception is a server that answers
 *   WITHOUT an epoch (a build predating the field): then a held group drained on this link is the
 *   only fact there is, and it is accepted, said.
 * - AN OWN COMMIT OF THE GROUP STAGED, IN FLIGHT OR UNRESOLVED (`ownCommitPending`) means
 *   "something is coming": its settlement moves the epochs and wakes the wait. While it stands the
 *   wait asks no pull and gives no verdict. A staged commit leaves the local epoch BELOW the
 *   server's once the server accepted it, until `mergeAccepted`; a local epoch ABOVE the server's
 *   is a commit of ours not accepted yet, or an external rejoin in flight. Neither proves anything.
 *
 * WHEN THE FACTS DISAGREE AND NOTHING IS COMING, THE WAIT ASKS: the server's epoch unreadable, the
 * group drained at an epoch other than the server's, or not held at all, ISSUES a pull for the group
 * (`pullForGroup`) and reads everything again at its end. One ask per state of the facts. A pull
 * that could not list the mailbox (`incomplete`) is said at WARN and allows one more ask; a second
 * incomplete one ends the wait ({@link CallGroupUnlistedError}).
 *
 * A STATE THAT HELD ACROSS A COMPLETE PULL THIS WAIT ASKED FOR, WITH NOTHING OF OURS COMING, IS AN
 * ANSWER, typed ({@link CallGroupUnprovenError}): behind the server ({@link CallGroupStuckError} -
 * the group is handed to the epoch-gap ladder, NON-destructively, at the wait's settlement), ahead
 * of it, not held, or its epoch still unreadable. The call fails visibly; the call path never
 * repairs a group itself.
 *
 * THE EVENTS the facts are re-read on, each a waiter REMOVED when the wait moves on or stops: a
 * frame of the group applied or a commit of it settled (`whenGroupFrameApplied`), a pull ending
 * (`whenGroupDrained`), a connection's catch-up ending (`whenNextCatchUp`), the end of a pull the
 * wait asked for. No clock.
 *
 * THE WAYS OUT, and only these: the proof; a typed answer above; {@link CallGroupWait.stop} (the
 * user hung up, or the caller's hangup ended the call); the session ending (a sign-out, an account
 * switch, the client destroyed or not the one MLS came up on).
 *
 * NOTHING IS READ BEFORE MLS IS UP, and then on the session's CURRENT client (`deps.mls()`), which
 * must be the one MLS came up on. A group behind is served first: from then on the group LEADS the
 * drain (`IMlsService.leadGroup`); the lead ends with the wait or earlier
 * ({@link CallGroupWait.releaseLead}).
 */
import { GroupDrainAbandonedError, type IMlsService } from '$lib/mls-client';
import { MlsSessionEndedError } from '$lib/composables/session/mlsReadiness';
import { SessionCatchUpAbandonedError } from '$lib/stores/pendingCallAccept';
import { CallSetupAbandonedError } from '$lib/utils/callFailure';

/** Which fact proved the call's group current. */
export type CallGroupProof = 'epoch-reached' | 'drained-no-server-epoch';

/** What a connecting call is waiting for, as the call screen says it. */
export type CallGroupWaitingFor = 'network' | 'conversation';

/**
 * The session the wait belonged to ended under it - a sign-out, an account switch, the MLS client
 * destroyed. Not a failure of the call: nothing is told to anyone through a client that is gone.
 */
export class CallGroupSessionEndedError extends Error {
  constructor(groupId: string, cause: unknown) {
    super(`the session ended while the call waited for group ${groupId.slice(0, 8)}`, { cause });
    this.name = 'CallGroupSessionEndedError';
  }
}

/** MLS came up on another client than the session's current one: a session end for this wait. */
export class CallGroupClientReplacedError extends CallGroupSessionEndedError {
  constructor(groupId: string) {
    super(groupId, new Error('MLS is ready on another client than the session holds'));
    this.name = 'CallGroupClientReplacedError';
  }
}

/** The kinds of {@link CallGroupUnprovenError}. */
export type CallGroupUnprovenKind = 'behind' | 'ahead' | 'not-held' | 'epoch-unknown' | 'unlisted';

/**
 * THE GROUP CANNOT BE PROVEN CURRENT, AND THAT IS AN ANSWER, never a wait: the call fails, visibly.
 * One subclass per kind, each carrying the facts that made it.
 */
export abstract class CallGroupUnprovenError extends Error {
  abstract readonly kind: CallGroupUnprovenKind;
  constructor(
    readonly groupId: string,
    /** This device's epoch for the group, `null` when it does not hold it. */
    readonly localEpoch: number | null,
    /** The server's epoch, `null` when it could not be read or sent none. */
    readonly serverEpoch: number | null,
    readonly why: string
  ) {
    super(
      `group ${groupId.slice(0, 8)} cannot be proven current: ${why} (local=${localEpoch ?? 'none'} server=${serverEpoch ?? 'unread'})`
    );
  }
}

/** Held and drained BELOW the server across a complete pull, nothing of ours coming. */
export class CallGroupStuckError extends CallGroupUnprovenError {
  readonly kind = 'behind' as const;
  override readonly name = 'CallGroupStuckError';
}

/** ABOVE the server across a complete pull, with no commit of ours staged or unresolved. */
export class CallGroupAheadError extends CallGroupUnprovenError {
  readonly kind = 'ahead' as const;
  override readonly name = 'CallGroupAheadError';
}

/** Not held by this device across a complete pull. */
export class CallGroupNotHeldError extends CallGroupUnprovenError {
  readonly kind = 'not-held' as const;
  override readonly name = 'CallGroupNotHeldError';
}

/** The server's epoch still unreadable across a complete pull - never "stuck", never repaired. */
export class CallGroupEpochUnknownError extends CallGroupUnprovenError {
  readonly kind = 'epoch-unknown' as const;
  override readonly name = 'CallGroupEpochUnknownError';
}

/** Two pulls asked in a row could not list the mailbox. */
export class CallGroupUnlistedError extends CallGroupUnprovenError {
  readonly kind = 'unlisted' as const;
  override readonly name = 'CallGroupUnlistedError';
}

/** The client surface the wait reads. */
export type CallGroupMls = Pick<
  IMlsService,
  | 'getEpoch'
  | 'getLocalGroups'
  | 'getGroupServerStatus'
  | 'whenGroupFrameApplied'
  | 'whenGroupDrained'
  | 'isGroupDrained'
  | 'leadGroup'
  | 'pullForGroup'
  | 'ownCommitPending'
>;

/** What the wait reads; injected so the ordering is tested without a client. */
export interface CallGroupCurrentDeps {
  /** The session's CURRENT client - read once, when MLS is up. */
  mls(): CallGroupMls;
  /** Resolves once MLS is initialised for the session (`mlsReadiness.ts`). */
  whenMlsReady(signal?: AbortSignal): Promise<void>;
  /** Whether `client` is the one MLS is ready on. */
  isReadyClient(client: CallGroupMls): boolean;
  /** Resolves at the next end of a connection's catch-up (`pendingCallAccept.ts`). */
  whenNextCatchUp(signal?: AbortSignal): Promise<void>;
  /** What the wait now waits for, for the call screen; `null` once it ended. */
  onWaiting(reason: CallGroupWaitingFor | null): void;
  /**
   * Hands a group proven behind to the EXISTING non-destructive first rung (`markEpochGap`): the
   * watchdog's ladder decides after its own window. Called once, at the wait's settlement.
   */
  handToGapLadder(groupId: string): void;
  log(line: string): void;
}

/** A wait in progress. */
export interface CallGroupWait {
  /** Resolves once MLS is up for this session - what the steps needing no epoch wait for. */
  readonly mlsReady: Promise<void>;
  /**
   * Resolves with the proof. Rejects with {@link CallSetupAbandonedError} when {@link stop} came
   * first, a {@link CallGroupUnprovenError} when the group cannot be proven current, and
   * {@link CallGroupSessionEndedError} when the session ended under it.
   */
  readonly proof: Promise<CallGroupProof>;
  /** Whether {@link proof} has settled, either way. */
  readonly settled: boolean;
  /**
   * Gives up the group's lead on the drain and keeps waiting: what a hangup notice held behind the
   * proof does once its call ended locally - priority serves a live call only. Idempotent.
   */
  releaseLead(): void;
  /** Ends the wait - its lead on the drain, its waiters, its proof. Idempotent. */
  stop(): void;
}

/** What woke the wait. */
type WaitEvent = 'frame' | 'pull' | 'catch-up';

/** Whether `e` says the session (the MLS client, the signed-in account) ended. */
function sessionEnded(e: unknown): boolean {
  return (
    e instanceof GroupDrainAbandonedError ||
    e instanceof MlsSessionEndedError ||
    e instanceof SessionCatchUpAbandonedError
  );
}

/**
 * Starts waiting for `groupId` to be current for the call `callId`. See the module comment for
 * what counts as proof and why.
 */
export function waitForCallGroupCurrent(
  deps: CallGroupCurrentDeps,
  groupId: string,
  callId: string
): CallGroupWait {
  const { log } = deps;
  const short = groupId.slice(0, 8);
  const startedAt = performance.now();
  const since = () => Math.round(performance.now() - startedAt);
  log(`[Call] keys of call=${callId} wait for its group ${short} to be current`);
  /** The lead's release once taken; `undefined` before, `null` once given up (never taken again). */
  let releaseGroupLead: (() => void) | null | undefined;
  const releaseLead = () => {
    const release = releaseGroupLead;
    releaseGroupLead = null;
    if (!release) return;
    release();
    log(`[Call] group ${short} no longer leads the drain`);
  };
  /** Aborted by {@link stop}: every waiter of the wait is removed with it. */
  const stopped = new AbortController();
  let settled = false;
  const stop = () => {
    if (stopped.signal.aborted) return;
    releaseLead();
    stopped.abort(new CallSetupAbandonedError(`waiting for group ${short}`));
  };
  const throwIfStopped = () => {
    if (stopped.signal.aborted) throw stopped.signal.reason;
  };
  let waitingSaid: CallGroupWaitingFor | null = null;
  const sayWaiting = (reason: CallGroupWaitingFor | null) => {
    if (reason === waitingSaid) return;
    waitingSaid = reason;
    deps.onWaiting(reason);
  };

  const mlsReady = deps.whenMlsReady(stopped.signal);

  /** Waits for the next event on `mls`, every waiter registered for it removed once one fires. */
  const nextEvent = async (mls: CallGroupMls): Promise<WaitEvent> => {
    // One controller per round, aborted by the stop too - never `AbortSignal.any`, absent from the
    // WKWebView of iOS before 17.4.
    const round = new AbortController();
    const signal = round.signal;
    const onStop = () => round.abort(stopped.signal.reason);
    stopped.signal.addEventListener('abort', onStop, { once: true });
    // An incomplete listing is a pull event like a complete one: the facts are what decide. A
    // drained group waits for no pull here - the loop asks one when the facts call for it.
    const pull = mls.isGroupDrained(groupId)
      ? new Promise<never>(() => {})
      : mls.whenGroupDrained(groupId, signal).then(
          () => 'pull' as const,
          (e: unknown) => {
            if (signal.aborted || sessionEnded(e)) throw e;
            return 'pull' as const;
          }
        );
    try {
      return await Promise.race([
        mls.whenGroupFrameApplied(groupId, signal).then(() => 'frame' as const),
        pull,
        deps.whenNextCatchUp(signal).then(() => 'catch-up' as const),
      ]);
    } finally {
      stopped.signal.removeEventListener('abort', onStop);
      if (!signal.aborted) round.abort(new Error('the wait moved on'));
    }
  };

  const run = async (): Promise<CallGroupProof> => {
    await mlsReady;
    throwIfStopped();
    const mls = deps.mls();
    if (!deps.isReadyClient(mls)) throw new CallGroupClientReplacedError(groupId);
    if (releaseGroupLead === undefined) releaseGroupLead = mls.leadGroup(groupId);
    /** The server's epoch: a number, `none` (it sent none), or `unread`. */
    let target: number | 'none' | 'unread' = 'unread';
    let unreadCause = '';
    let readTarget = true;
    let unreadableSaid = false;
    let lastSaid: string | null = null;
    /** The state a pull was asked for (one ask per state), and the state a LISTED one was for. */
    let askedFor: string | null = null;
    let listedFor: string | null = null;
    /** Asked pulls in a row that could not list the mailbox. */
    let incompleteAsks = 0;
    for (;;) {
      throwIfStopped();
      if (readTarget) {
        readTarget = false;
        const status = await mls.getGroupServerStatus(groupId);
        throwIfStopped();
        if (status === 'absent' || status === 'error') {
          target = 'unread';
          unreadCause = status;
          if (!unreadableSaid) {
            unreadableSaid = true;
            log(
              `[Call] WARN group ${short}: the server's epoch could not be read (${status}) - a pull is asked, and it is read again at its end`
            );
          }
        } else if (status.activeEpoch === undefined) {
          target = 'none';
          log(`[Call] group ${short}: the server sends no epoch - a drain on this link decides`);
        } else {
          target = status.activeEpoch;
        }
      }
      const held = mls.getLocalGroups().includes(groupId);
      const local = held ? mls.getEpoch(groupId) : null;
      const drained = mls.isGroupDrained(groupId);
      const state = `${local}/${target}`;
      const server = typeof target === 'number' ? target : null;
      if (server !== null) {
        if (state !== lastSaid) {
          lastSaid = state;
          log(
            `[Call] group ${short} ${held ? `at epoch ${local}` : 'not held here'}, the server's is ${server}`
          );
          if (local !== null && local > server) {
            log(
              `[Call] WARN group ${short} is AHEAD of the server (${local} > ${server}) - a commit of ours not accepted yet proves nothing; the server's epoch is read again at the next event`
            );
          }
        }
        if (local === server) return 'epoch-reached';
      } else if (target === 'none' && held && drained) {
        return 'drained-no-server-epoch';
      }
      const ownPending = held && (await mls.ownCommitPending(groupId));
      throwIfStopped();
      if (!ownPending && listedFor === state && drained) {
        // A STATE THAT HELD ACROSS A COMPLETE PULL WITH NOTHING OF OURS COMING: AN ANSWER.
        if (target === 'unread') {
          throw new CallGroupEpochUnknownError(
            groupId,
            local,
            null,
            `the server's epoch is still unreadable (${unreadCause}) after a complete pull`
          );
        }
        if (!held) {
          throw new CallGroupNotHeldError(groupId, null, server, 'not held after a complete pull');
        }
        if (server !== null && local !== null && local < server) {
          throw new CallGroupStuckError(
            groupId,
            local,
            server,
            'drained below the server after a complete pull, no commit of ours coming'
          );
        }
        if (server !== null && local !== null && local > server) {
          throw new CallGroupAheadError(
            groupId,
            local,
            server,
            'ahead of the server after a complete pull, no commit of ours staged or unresolved'
          );
        }
      }
      const disagrees =
        target === 'unread' || (drained && (!held || (server !== null && local !== server)));
      if (!ownPending && askedFor !== state && disagrees) {
        askedFor = state;
        log(
          `[Call] group ${short} at ${local ?? 'none'} while the server holds ${target}${target === 'unread' ? ` (${unreadCause})` : ''} - a pull is asked for it, and its end read`
        );
        let outcome: 'listed' | 'incomplete';
        try {
          outcome = await mls.pullForGroup(groupId);
        } catch (e: unknown) {
          if (sessionEnded(e)) throw e;
          log(`[Call] WARN group ${short}: the pull asked for it failed: ${String(e)}`);
          outcome = 'incomplete';
        }
        throwIfStopped();
        if (outcome === 'listed') {
          listedFor = state;
          incompleteAsks = 0;
        } else {
          incompleteAsks += 1;
          log(
            `[Call] WARN group ${short}: the pull asked for it could not list the mailbox (${incompleteAsks} in a row)`
          );
          if (incompleteAsks >= 2) {
            throw new CallGroupUnlistedError(
              groupId,
              local,
              server,
              'two pulls asked in a row could not list the mailbox'
            );
          }
          // One more ask for the same state.
          askedFor = null;
        }
        readTarget = true;
        continue;
      }
      sayWaiting(incompleteAsks > 0 ? 'network' : 'conversation');
      const event = await nextEvent(mls);
      // The server's epoch moves only with a commit: re-read on what can carry one.
      if (server !== null && local !== null && local > server) readTarget = true;
      else if (target === 'unread' && (event === 'pull' || event === 'catch-up')) readTarget = true;
      else if (server !== null && event !== 'frame') readTarget = true;
    }
  };

  const proof = run().then(
    (how) => {
      settled = true;
      stop();
      sayWaiting(null);
      log(`[Call] timing: group ${short} current (${how}) after ${since()} ms`);
      return how;
    },
    (e: unknown) => {
      settled = true;
      const ended = e instanceof CallSetupAbandonedError;
      stop();
      sayWaiting(null);
      if (ended) {
        log(`[Call] the wait for group ${short} stopped after ${since()} ms - the call ended`);
        throw e;
      }
      if (e instanceof CallGroupSessionEndedError) {
        log(`[Call] WARN the wait for group ${short} ended after ${since()} ms: ${e.message}`);
        throw e;
      }
      if (sessionEnded(e)) {
        log(
          `[Call] WARN the wait for group ${short} ended after ${since()} ms - the session ended`
        );
        throw new CallGroupSessionEndedError(groupId, e);
      }
      if (e instanceof CallGroupUnprovenError) {
        const level = e.kind === 'epoch-unknown' || e.kind === 'unlisted' ? 'WARN' : 'ERROR';
        log(`[Call] ${level} call=${callId}: ${e.message}, after ${since()} ms`);
        // THE ONE DECISION ON A GROUP BEHIND, whether or not the user already hung up: handed to
        // the epoch-gap ladder, never repaired here.
        if (e instanceof CallGroupStuckError) {
          log(
            `[Call] group ${short} of call=${callId} handed to the epoch-gap ladder - its watchdog decides`
          );
          deps.handToGapLadder(groupId);
        }
        throw e;
      }
      log(`[Call] ERROR the wait for group ${short} failed after ${since()} ms: ${String(e)}`);
      throw e;
    }
  );
  // Both are awaited by the caller only on the paths that reach them: a wait stopped before MLS is
  // up rejects both, and neither may surface as an unhandled rejection.
  mlsReady.catch(() => {});
  proof.catch(() => {});
  return {
    mlsReady,
    proof,
    get settled() {
      return settled;
    },
    releaseLead,
    stop,
  };
}
