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
 * - A local epoch ABOVE the server's proves nothing (a commit of ours staged and not accepted, an
 *   external rejoin whose commit is still in flight): said at WARN, and the server's epoch is read
 *   again on the next event.
 * - "Drained" is NOT a proof - applied is not current. The one exception is a server that answers
 *   WITHOUT an epoch (a build predating the field): then a held group drained on this link is the
 *   only fact there is, and it is accepted, said.
 *
 * WHEN THE FACTS DISAGREE AND NOTHING IS COMING, THE WAIT ASKS: the server's epoch unreadable, or
 * the group drained at an epoch other than the server's, ISSUES a pull for the group
 * (`fetchPendingMessages`) and reads everything again at its end. One pull per state of the facts:
 * a state that held across a complete pull this wait asked for is an ANSWER, not a wait -
 * {@link CallGroupStuckError}, below the server (or not held at all), or the server's epoch still
 * unreadable. A state ahead of the server waits for its commit to settle, which wakes the wait.
 *
 * THE EVENTS the facts are re-read on, each a waiter REMOVED when the wait moves on or stops: a
 * frame of the group applied or a commit of it settled (`whenGroupFrameApplied`), a pull ending
 * (`whenGroupDrained`, which resolves or ends incomplete), a connection's catch-up ending
 * (`whenNextCatchUp`), and the end of a pull the wait issued. No clock.
 *
 * THE WAYS OUT, and only these: the proof; {@link CallGroupStuckError} (the call fails, visibly);
 * {@link CallGroupWait.stop} (the user hung up, or the caller's hangup ended the call); the session
 * ending (a sign-out, an account switch, the client destroyed or replaced).
 *
 * NOTHING IS READ BEFORE MLS IS UP, and then on the client MLS is up ON: a wait whose client is not
 * the session's (`clientIsCurrent`) ends as {@link CallGroupClientReplacedError}. A group behind is
 * served first: from then on the group LEADS the drain (`IMlsService.leadGroup`); the lead ends with
 * the wait, whichever way it ends, or earlier ({@link CallGroupWait.releaseLead}).
 */
import { GroupDrainAbandonedError, type IMlsService } from '$lib/mls-client';
import { MlsSessionEndedError } from '$lib/composables/session/mlsReadiness';
import { SessionCatchUpAbandonedError } from '$lib/stores/pendingCallAccept';
import { CallSetupAbandonedError } from '$lib/utils/callFailure';

/** Which fact proved the call's group current. */
export type CallGroupProof = 'epoch-reached' | 'drained-no-server-epoch';

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

/**
 * The wait was built on a client the session no longer uses: MLS came up on ANOTHER client (a
 * login replaced the one captured at mount). A session end for this wait; its answer belongs to the
 * session's own call service.
 */
export class CallGroupClientReplacedError extends CallGroupSessionEndedError {
  constructor(groupId: string) {
    super(
      groupId,
      new Error('MLS is ready on another client than the one the call was answered on')
    );
    this.name = 'CallGroupClientReplacedError';
  }
}

/**
 * THE GROUP CANNOT BE PROVEN CURRENT, AND THAT IS AN ANSWER: a complete pull this wait asked for
 * ended and the facts did not move - the group drained below the server's epoch (or not held at
 * all), or the server's epoch still unreadable. The call fails, visibly, and the group's repair is
 * asked for.
 */
export class CallGroupStuckError extends Error {
  constructor(
    readonly groupId: string,
    /** This device's epoch for the group, `null` when it does not hold it. */
    readonly localEpoch: number | null,
    /** The server's epoch, `null` when it could not be read. */
    readonly serverEpoch: number | null,
    readonly why: string
  ) {
    super(
      `group ${groupId.slice(0, 8)} cannot be proven current: ${why} (local=${localEpoch ?? 'none'} server=${serverEpoch ?? 'unread'})`
    );
    this.name = 'CallGroupStuckError';
  }
}

/** What the wait reads; injected so the ordering is tested without a client. */
export interface CallGroupCurrentDeps {
  mls: Pick<
    IMlsService,
    | 'getEpoch'
    | 'getLocalGroups'
    | 'getGroupServerStatus'
    | 'whenGroupFrameApplied'
    | 'whenGroupDrained'
    | 'isGroupDrained'
    | 'leadGroup'
    | 'fetchPendingMessages'
  >;
  /** Resolves once MLS is initialised for the session (`mlsReadiness.ts`). */
  whenMlsReady(signal?: AbortSignal): Promise<void>;
  /** Whether {@link mls} is the client MLS is ready on - read once, when it is. */
  clientIsCurrent(): boolean;
  /** Resolves at the next end of a connection's catch-up (`pendingCallAccept.ts`). */
  whenNextCatchUp(signal?: AbortSignal): Promise<void>;
  log(line: string): void;
}

/** A wait in progress. */
export interface CallGroupWait {
  /** Resolves once MLS is up for this session - what the steps needing no epoch wait for. */
  readonly mlsReady: Promise<void>;
  /**
   * Resolves with the proof. Rejects with {@link CallSetupAbandonedError} when {@link stop} came
   * first, {@link CallGroupStuckError} when the group cannot be proven current, and
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
  const { mls, log } = deps;
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

  const mlsReady = deps.whenMlsReady(stopped.signal);

  /** Waits for the next event, every waiter registered for it removed once one fires. */
  const nextEvent = async (): Promise<WaitEvent> => {
    // One controller per round, aborted by the stop too - never `AbortSignal.any`, absent from the
    // WKWebView of iOS before 17.4.
    const round = new AbortController();
    const signal = round.signal;
    const onStop = () => round.abort(stopped.signal.reason);
    stopped.signal.addEventListener('abort', onStop, { once: true });
    // An incomplete listing is a pull event like a complete one: the facts are what decide. A
    // drained group waits for no pull here - the loop issues one when the facts call for it.
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

  /** Issues a pull for the group and waits for ITS end - the one event a stuck state lacks. */
  const pullAndWait = async (why: string): Promise<void> => {
    log(`[Call] group ${short}: ${why} - a pull is asked for it, and its end read`);
    try {
      await mls.fetchPendingMessages([groupId]);
    } catch (e: unknown) {
      if (sessionEnded(e)) throw e;
      log(`[Call] WARN group ${short}: the pull asked for it failed: ${String(e)}`);
    }
    throwIfStopped();
  };

  const run = async (): Promise<CallGroupProof> => {
    await mlsReady;
    throwIfStopped();
    if (!deps.clientIsCurrent()) throw new CallGroupClientReplacedError(groupId);
    if (releaseGroupLead === undefined) releaseGroupLead = mls.leadGroup(groupId);
    /** The server's epoch: a number, `none` (it sent none), or `unread` (to read on a pull/connection). */
    let target: number | 'none' | 'unread' = 'unread';
    let unreadCause = '';
    let readTarget = true;
    let unreadableSaid = false;
    let lastSaid: string | null = null;
    /** The state of the facts a pull THIS WAIT issued was asked for: one pull per state. */
    let pulledFor: string | null = null;
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
              `[Call] WARN group ${short}: the server's epoch could not be read (${status}) - read again at the next pull or connection; the keys wait`
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
      if (typeof target === 'number') {
        if (state !== lastSaid) {
          lastSaid = state;
          log(
            `[Call] group ${short} ${held ? `at epoch ${local}` : 'not held here'}, the server's is ${target}`
          );
          if (local !== null && local > target) {
            log(
              `[Call] WARN group ${short} is AHEAD of the server (${local} > ${target}) - a commit of ours not accepted yet proves nothing; the server's epoch is read again at the next event`
            );
          }
        }
        if (local === target) return 'epoch-reached';
      } else if (target === 'none' && held && drained) {
        return 'drained-no-server-epoch';
      }
      const below = typeof target === 'number' && (local === null || local < target);
      // A STATE THAT HELD ACROSS A COMPLETE PULL THIS WAIT ASKED FOR IS AN ANSWER.
      if (pulledFor === state && drained) {
        if (target === 'unread') {
          throw new CallGroupStuckError(
            groupId,
            local,
            null,
            `the server's epoch is still unreadable (${unreadCause}) after a complete pull`
          );
        }
        if (below) {
          throw new CallGroupStuckError(
            groupId,
            local,
            target as number,
            held
              ? 'drained below the server after a complete pull'
              : 'not held after a complete pull'
          );
        }
      }
      if (
        pulledFor !== state &&
        (target === 'unread' || (typeof target === 'number' && drained && local !== target))
      ) {
        pulledFor = state;
        await pullAndWait(
          target === 'unread'
            ? `the server's epoch is unread (${unreadCause})`
            : `drained at epoch ${local ?? 'none'} while the server holds ${target}`
        );
        readTarget = true;
        continue;
      }
      const event = await nextEvent();
      // The server's epoch moves only with a commit: re-read on what can carry one - any event when
      // ahead (our commit settling), a pull or a connection when it could not be read.
      if (typeof target === 'number' && local !== null && local > target) readTarget = true;
      else if (target === 'unread' && (event === 'pull' || event === 'catch-up')) readTarget = true;
      else if (typeof target === 'number' && event !== 'frame') readTarget = true;
    }
  };

  const proof = run().then(
    (how) => {
      settled = true;
      stop();
      log(`[Call] timing: group ${short} current (${how}) after ${since()} ms`);
      return how;
    },
    (e: unknown) => {
      settled = true;
      const ended = e instanceof CallSetupAbandonedError;
      stop();
      if (ended) {
        log(`[Call] the wait for group ${short} stopped after ${since()} ms - the call ended`);
        throw e;
      }
      if (e instanceof CallGroupSessionEndedError) {
        log(`[Call] the wait for group ${short} ended after ${since()} ms: ${e.message}`);
        throw e;
      }
      if (sessionEnded(e)) {
        log(`[Call] the wait for group ${short} ended after ${since()} ms - the session ended`);
        throw new CallGroupSessionEndedError(groupId, e);
      }
      if (e instanceof CallGroupStuckError) {
        log(`[Call] ERROR ${e.message}, after ${since()} ms`);
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
