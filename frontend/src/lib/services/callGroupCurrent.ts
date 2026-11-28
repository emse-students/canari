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
 * - "Drained" is NOT a proof - applied is not current: it is an EVENT on which the epoch is read
 *   again. A drained group still below the server is a contradiction, said at WARN, and waited on.
 *   The one exception is a server that answers WITHOUT an epoch (a build predating the field): then
 *   a held group drained on this link is the only fact there is, and it is accepted, said.
 * - A server epoch that cannot be READ (no answer, an error) is said ONCE at WARN with its cause, and
 *   read again on the next pull or connection event - never on a timer. The wait goes on until the
 *   epoch is reached or the call ends (the user hangs up; the room token's `410` ends it once the
 *   ring window has closed).
 *
 * THE EVENTS the facts are re-read on, each a waiter REMOVED when the wait moves on or stops: a
 * frame of the group applied (`whenGroupFrameApplied`), a pull ending (`whenGroupDrained`, which
 * resolves or ends incomplete), a connection's catch-up ending (`whenNextCatchUp`). No clock.
 *
 * A GROUP BEHIND IS SERVED FIRST: while the wait runs the group leads the drain
 * (`IMlsService.leadGroup`). The lead ends with the wait, whichever way it ends.
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
  >;
  /** Resolves once MLS is initialised for the session (`mlsReadiness.ts`). */
  whenMlsReady(signal?: AbortSignal): Promise<void>;
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
   * first, and with {@link CallGroupSessionEndedError} when the session ended under it.
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
  const releaseGroupLead = mls.leadGroup(groupId);
  let leading = true;
  const releaseLead = () => {
    if (!leading) return;
    leading = false;
    releaseGroupLead();
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

  const mlsReady = deps.whenMlsReady(stopped.signal);

  /** Waits for the next event, every waiter registered for it removed once one fires. */
  const nextEvent = async (): Promise<WaitEvent> => {
    // One controller per round, aborted by the stop too - never `AbortSignal.any`, absent from the
    // WKWebView of iOS before 17.4.
    const round = new AbortController();
    const signal = round.signal;
    const onStop = () => round.abort(stopped.signal.reason);
    stopped.signal.addEventListener('abort', onStop, { once: true });
    // An incomplete listing is a pull event like a complete one: the epoch is what decides.
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
    /** The server's epoch: a number, `none` (it sent none), or `unread` (to read on a pull/connection). */
    let target: number | 'none' | 'unread' = 'unread';
    let readTarget = true;
    let unreadableSaid = false;
    let lastSaid: string | null = null;
    let event: WaitEvent | null = null;
    for (;;) {
      if (stopped.signal.aborted) throw stopped.signal.reason;
      if (readTarget) {
        readTarget = false;
        const status = await mls.getGroupServerStatus(groupId);
        if (stopped.signal.aborted) throw stopped.signal.reason;
        if (status === 'absent' || status === 'error') {
          target = 'unread';
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
      if (typeof target === 'number') {
        const local = held ? mls.getEpoch(groupId) : null;
        const said = `${local}/${target}`;
        if (said !== lastSaid) {
          lastSaid = said;
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
        if (local !== null && local > target) readTarget = true;
        else if (event !== 'frame' && event !== 'catch-up' && mls.isGroupDrained(groupId)) {
          log(
            `[Call] WARN group ${short} drained at epoch ${local ?? 'none'} while the server holds ${target} - waiting for the commits that close the gap`
          );
        }
      } else if (target === 'none' && held && mls.isGroupDrained(groupId)) {
        return 'drained-no-server-epoch';
      }
      event = await nextEvent();
      if (target === 'unread' && (event === 'pull' || event === 'catch-up')) readTarget = true;
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
      if (sessionEnded(e)) {
        log(`[Call] the wait for group ${short} ended after ${since()} ms - the session ended`);
        throw new CallGroupSessionEndedError(groupId, e);
      }
      log(`[Call] ERROR the wait for group ${short} failed after ${since()} ms: ${String(e)}`);
      throw e;
    }
  );
  // The proof is awaited by the caller; `mlsReady` too, but only on paths that reach it.
  mlsReady.catch(() => {});
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
