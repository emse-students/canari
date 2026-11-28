/**
 * THE JOIN OF A CALL ANSWERED ON THE NATIVE RING WAITS FOR ITS OWN GROUP, NEVER FOR EVERY GROUP.
 *
 * The media keys of a call are its conversation's MLS `exportSecret` at the current epoch
 * (`utils/callKeys.ts`), and the "answered" notice is sent in that group. Nothing else the session
 * catches up on changes them. Until 1.8.4 the join waited for `ConnectionDeps.onCaughtUp` - the
 * catch-up of EVERY conversation - and on the owner's phone (1.8.2, 2026-11-27) that was 10.7 s of
 * a resume's 180 frames of other conversations between the tap and the join.
 *
 * WHAT PROVES THE GROUP CURRENT - three facts, each an EVENT, none a clock; the first one wins:
 *
 * - `epoch-reached`: this device holds the group at the epoch the delivery service holds for it
 *   (`GET /api/mls/groups/:id`, `activeEpoch`, read once MLS is up). The server's epoch is where
 *   every accepted commit lands, so a local epoch at or past it has no commit left to apply, and
 *   the keys exported now are the keys every member at that epoch exports. Re-read after each frame
 *   of the group the scheduler applies (`whenGroupFrameApplied`), never on a timer.
 * - `group-drained`: the mailbox was listed whole on this link and the scheduler holds nothing of
 *   the group (`IMlsService.whenGroupDrained`); a listing that ended incomplete defers it to the
 *   next complete one (`untilListedWhole`).
 * - `session-caught-up`: the connection's whole catch-up ended (`whenSessionCaughtUp`) - the gate
 *   every build before 1.8.4 used, which every complete catch-up reaches AFTER `group-drained`. It
 *   wins alone only when the listing ended incomplete (the mailbox is then unknown, and no group can
 *   be proven drained): the join then goes ahead as it always did, said at WARN, because a group not
 *   proven current is a signal, never a path to keep quiet about.
 *
 * A GROUP BEHIND IS SERVED FIRST: while the wait runs the group leads the drain
 * (`IMlsService.leadGroup`), so its commits are applied ahead of the other conversations' frames
 * instead of one turn in N of the round-robin. The lead ends with the wait, whichever way it ends.
 */
import { untilListedWhole, type IMlsService } from '$lib/mls-client';
import { CallSetupAbandonedError } from '$lib/utils/callFailure';

/** Which fact proved the call's group current. */
export type CallGroupProof = 'epoch-reached' | 'group-drained' | 'session-caught-up';

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
  whenMlsReady(): Promise<void>;
  /** Resolves once the connection's catch-up has ended (`pendingCallAccept.ts`). */
  whenSessionCaughtUp(): Promise<void>;
  log(line: string): void;
}

/** A wait in progress: the proof, and the stop a call that ended before it calls. */
export interface CallGroupWait {
  /**
   * Resolves with the first proof. Rejects with {@link CallSetupAbandonedError} when {@link stop}
   * came first (the call ended during the wait), and with the client's own error when the MLS client
   * ended under it.
   */
  readonly proof: Promise<CallGroupProof>;
  /** Ends the wait - its lead on the drain, its epoch reads, its proof. Idempotent. */
  stop(): void;
}

/** A branch that has nothing to prove: it never settles, and the race is decided by the others. */
function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
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
  log(`[Call] join of call=${callId} waits for its group ${short} to be current`);
  const releaseLead = mls.leadGroup(groupId);
  let stopped = false;
  let abandon!: (e: Error) => void;
  /** The branch {@link stop} settles: a call that ended does not leave its setup awaiting for ever. */
  const stoppedFirst = new Promise<never>((_, reject) => (abandon = reject));
  const stop = () => {
    if (stopped) return;
    stopped = true;
    releaseLead();
    abandon(new CallSetupAbandonedError(`waiting for group ${short}`));
  };

  const epochReached = (async (): Promise<CallGroupProof> => {
    await deps.whenMlsReady();
    if (stopped) return never();
    const status = await mls.getGroupServerStatus(groupId);
    if (stopped) return never();
    const target = status === 'absent' || status === 'error' ? undefined : status.activeEpoch;
    if (target === undefined) {
      // NOT A FAILURE OF THE JOIN: this proof is unavailable, and the two drained proofs decide.
      log(
        `[Call] group ${short}: the server's epoch is unknown (${typeof status === 'string' ? status : 'no activeEpoch'}) - the drain proves it current`
      );
      return never();
    }
    for (;;) {
      if (stopped) return never();
      const held = mls.getLocalGroups().includes(groupId);
      const local = held ? mls.getEpoch(groupId) : null;
      if (local !== null && local >= target) {
        log(`[Call] group ${short} at epoch ${local}, the server's is ${target}`);
        return 'epoch-reached';
      }
      log(
        `[Call] group ${short} ${held ? `at epoch ${local}` : 'not held here'}, the server's is ${target} - its next frame is read first`
      );
      await mls.whenGroupFrameApplied(groupId);
    }
  })();

  const drained = untilListedWhole(
    () => mls.whenGroupDrained(groupId),
    `the join of call ${callId}`
  ).then((): CallGroupProof => 'group-drained');

  const caughtUp = deps.whenSessionCaughtUp().then((): CallGroupProof => {
    if (!stopped && !mls.isGroupDrained(groupId)) {
      log(
        `[Call] WARN group ${short} NOT proven current - the catch-up ended without listing the mailbox whole; the call joins at the epoch this device holds`
      );
    }
    return 'session-caught-up';
  });

  const proof = Promise.race([epochReached, drained, caughtUp, stoppedFirst]).then(
    (how) => {
      stop();
      log(`[Call] timing: group ${short} current (${how}) after ${since()} ms`);
      return how;
    },
    (e: unknown) => {
      const ended = e instanceof CallSetupAbandonedError;
      stop();
      log(
        ended
          ? `[Call] the wait for group ${short} stopped after ${since()} ms - the call ended`
          : `[Call] ERROR the wait for group ${short} ended after ${since()} ms: ${String(e)}`
      );
      throw e;
    }
  );
  return { proof, stop };
}
