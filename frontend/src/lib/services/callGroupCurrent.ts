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
 * - AN OWN COMMIT OF THE GROUP (`ownCommitState`) means "something is coming", and no pull and no
 *   verdict while it stands. One IN FLIGHT (holding the MLS mutex) settles by itself and wakes the
 *   wait. One UNRESOLVED (kept, its outcome unknown) is settled by nothing until the next send or
 *   reconnect, so the wait asks its settlement (`settleUnresolvedCommits([group])`) once per state of
 *   the facts; still unresolved after it, the wait ends ({@link CallGroupCommitUnresolvedError}).
 *
 * OFFLINE IS A WAIT, NEVER A FAILURE. While the gateway socket is down the wait asks nothing - no
 * pull, no settlement - says `network` to the call screen, and waits for the reconnect's catch-up.
 * A step the link dropped under - a pull, a settlement, a commit-log read - is no answer either: it
 * is asked again once the reconnect's event comes, whatever that listing changed.
 *
 * WHEN THE FACTS DISAGREE AND NOTHING IS COMING, THE WAIT ASKS: the server's epoch unreadable, or
 * the group at an epoch other than the server's (or not held) with NOTHING MORE COMING FROM THE
 * MAILBOX - drained on this link, or never listed on it with no pull running or owed
 * (`mailboxListing`: the boot pull refused, a 502) - ISSUES a pull for the group (`pullForGroup`)
 * and reads everything again at its end. One ask per state of the facts. A pull that could not list
 * the mailbox while the link stayed up (`incomplete`) is said at WARN and asked again - after the
 * end of a pull still running or owed, at once when none is; a second such one in a row ends the
 * wait ({@link CallGroupUnlistedError}).
 *
 * A GROUP DRAINED BELOW THE SERVER AFTER A COMPLETE PULL IS CAUGHT UP FROM THE COMMIT LOG FIRST -
 * the same first, non-destructive rung a refused commit takes (`catchUpFromCommitLog`: rung 1, its
 * own books marking and un-marking the epoch gap). The post-commit fan-out to this device is best
 * effort, and the server's row can read N+1 before the fan-out row exists: the log has the commit
 * the mailbox lacks. Only a replay the log ANSWERED and could not heal ends the wait
 * ({@link CallGroupStuckError}); a log that could not be read is a wait offline and
 * {@link CallGroupLogUnreachableError} online, its mark taken back - never `behind`. The call path
 * itself marks nothing and repairs nothing destructively.
 *
 * ANY OTHER STATE THAT HELD ACROSS A COMPLETE PULL THIS WAIT ASKED FOR, WITH NOTHING OF OURS COMING,
 * IS AN ANSWER, typed ({@link CallGroupUnprovenError}): ahead of the server, not held, or its epoch
 * still unreadable. The call fails visibly.
 *
 * ARM, THEN CHECK. Each round registers its waiters first - a frame of the group applied or a commit
 * of it settled (`whenGroupFrameApplied`), a pull ending (`whenGroupDrained`), a connection's
 * catch-up ending (`whenNextCatchUp`) - THEN reads the facts, every one after the round's last
 * await: an event landing while the round reads is never missed, and no verdict stands on a fact
 * read before an await. Every waiter is REMOVED when the round moves on or the wait stops. No clock.
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
export type CallGroupUnprovenKind =
  | 'behind'
  | 'ahead'
  | 'not-held'
  | 'epoch-unknown'
  | 'unlisted'
  | 'commit-unresolved'
  | 'log-unreachable';

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

/**
 * Held and drained BELOW the server across a complete pull, nothing of ours coming, and the commit
 * log could not close the gap (rung 1 left it to the sync watchdog).
 */
export class CallGroupStuckError extends CallGroupUnprovenError {
  readonly kind = 'behind' as const;
  override readonly name = 'CallGroupStuckError';
}

/** ABOVE the server across a complete pull, with no commit of ours in flight or unresolved. */
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

/** Two pulls asked in a row, the link up, could not list the mailbox. */
export class CallGroupUnlistedError extends CallGroupUnprovenError {
  readonly kind = 'unlisted' as const;
  override readonly name = 'CallGroupUnlistedError';
}

/** A kept commit of ours is still unresolved after the settlement the wait asked for. */
export class CallGroupCommitUnresolvedError extends CallGroupUnprovenError {
  readonly kind = 'commit-unresolved' as const;
  override readonly name = 'CallGroupCommitUnresolvedError';
}

/**
 * The commit log could not be read, the link up, for a group behind: nothing is known about the
 * gap, so it is never `behind` - and the mark the catch-up set was taken back.
 */
export class CallGroupLogUnreachableError extends CallGroupUnprovenError {
  readonly kind = 'log-unreachable' as const;
  override readonly name = 'CallGroupLogUnreachableError';
}

/** The kinds that say the network or the server could not answer, rather than the group's state. */
export function callGroupUnreachable(kind: CallGroupUnprovenKind): boolean {
  return (
    kind === 'epoch-unknown' ||
    kind === 'unlisted' ||
    kind === 'commit-unresolved' ||
    kind === 'log-unreachable'
  );
}

/** The client surface the wait reads. */
export type CallGroupMls = Pick<
  IMlsService,
  | 'getEpoch'
  | 'getLocalGroups'
  | 'getGroupServerStatus'
  | 'whenGroupFrameApplied'
  | 'whenGroupDrained'
  | 'groupDrainedNow'
  | 'mailboxListing'
  | 'isWsOpen'
  | 'leadGroup'
  | 'pullForGroup'
  | 'ownCommitState'
  | 'settleUnresolvedCommits'
  | 'catchUpFromCommitLog'
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

/** One round's waiters, registered BEFORE its facts are read. */
interface ArmedRound {
  /** The first event of the round. */
  readonly next: Promise<WaitEvent>;
  /** Removes every waiter of the round. Idempotent. */
  disarm(): void;
}

/** Whether `e` says the session (the MLS client, the signed-in account) ended. */
function sessionEnded(e: unknown): boolean {
  return (
    e instanceof GroupDrainAbandonedError ||
    e instanceof MlsSessionEndedError ||
    e instanceof SessionCatchUpAbandonedError
  );
}

/** A promise that never settles: a waiter the round does not need. */
const NEVER = new Promise<never>(() => {});

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

  /**
   * Registers this round's waiters on `mls` - BEFORE the round reads anything, so an event landing
   * while it reads is the round's first event, never lost. One controller per round, aborted by the
   * stop too - never `AbortSignal.any`, absent from the WKWebView of iOS before 17.4.
   */
  const arm = (mls: CallGroupMls): ArmedRound => {
    const round = new AbortController();
    const signal = round.signal;
    const onStop = () => round.abort(stopped.signal.reason);
    stopped.signal.addEventListener('abort', onStop, { once: true });
    // An incomplete listing is a pull event like a complete one: the facts are what decide. A
    // group drained now waits for no pull - `whenGroupDrained` would resolve at once, for ever;
    // whatever undrains it is a frame of it, and the frame waiter hears that. Read silently: this
    // runs on every round.
    const pull = mls.groupDrainedNow(groupId)
      ? NEVER
      : mls.whenGroupDrained(groupId, signal).then(
          () => 'pull' as const,
          (e: unknown) => {
            if (signal.aborted || sessionEnded(e)) throw e;
            return 'pull' as const;
          }
        );
    const next = Promise.race([
      mls.whenGroupFrameApplied(groupId, signal).then(() => 'frame' as const),
      pull,
      deps.whenNextCatchUp(signal).then(() => 'catch-up' as const),
    ]);
    // A round disarmed before anyone awaited it rejects with the move-on: not an unhandled one.
    next.catch(() => {});
    return {
      next,
      disarm: () => {
        stopped.signal.removeEventListener('abort', onStop);
        if (!signal.aborted) round.abort(new Error('the wait moved on'));
      },
    };
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
    let offlineSaid = false;
    /** The state a pull was asked for (one ask per state), and the state a LISTED one was for. */
    let askedFor: string | null = null;
    let listedFor: string | null = null;
    /** Pulls asked in a row, the link up, that could not list the mailbox. */
    let incompleteAsks = 0;
    /** An incomplete pull may be asked again - after the next event, never at once. */
    let reaskAfterEvent = false;
    /** The state an unresolved commit's settlement was asked for (one ask per state). */
    let settleAskedFor: string | null = null;
    /** The state the commit log was replayed for, and how many replays were held for it. */
    let replayedFor: string | null = null;
    let replaysHeld = 0;
    for (;;) {
      throwIfStopped();
      // ARM, THEN CHECK: every fact below is read after this round's waiters exist.
      const round = arm(mls);
      let event: WaitEvent;
      try {
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
                `[Call] WARN group ${short}: the server's epoch could not be read (${status}) - read again at the next pull or catch-up`
              );
            }
          } else if (status.activeEpoch === undefined) {
            target = 'none';
            log(`[Call] group ${short}: the server sends no epoch - a drain on this link decides`);
          } else {
            target = status.activeEpoch;
          }
        }
        const heldBefore = mls.getLocalGroups().includes(groupId);
        const own = heldBefore ? await mls.ownCommitState(groupId) : 'none';
        throwIfStopped();
        // An unresolved commit gone, the next one is a new question: its settlement may be asked.
        if (own !== 'unresolved') settleAskedFor = null;
        // THE FACTS, read after the round's last await.
        const linkUp = mls.isWsOpen();
        const held = mls.getLocalGroups().includes(groupId);
        const local = held ? mls.getEpoch(groupId) : null;
        const drained = mls.groupDrainedNow(groupId);
        // NOTHING MORE COMES FROM THE MAILBOX: drained on this link, or never listed on it with no
        // pull running or owed (the boot pull refused, a 502) - carried as a fact, never inferred
        // from "not drained".
        const mailboxQuiet = drained || mls.mailboxListing() === 'unlisted';
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

        if (!linkUp) {
          // OFFLINE IS A WAIT: nothing is asked, the reconnect's catch-up is what comes next.
          if (!offlineSaid) {
            offlineSaid = true;
            log(
              `[Call] group ${short} at ${local ?? 'none'} while the server holds ${target}: the link is down - waiting for the reconnect`
            );
          }
        } else if (own === 'unresolved' && settleAskedFor !== state) {
          // A KEPT COMMIT NOBODY SETTLES until the next send or reconnect: the wait asks it.
          settleAskedFor = state;
          round.disarm();
          log(
            `[Call] group ${short}: a commit of ours is unresolved - its settlement is asked, and the group read again at its end`
          );
          try {
            await mls.settleUnresolvedCommits([groupId]);
          } catch (e: unknown) {
            if (sessionEnded(e)) throw e;
            log(`[Call] WARN group ${short}: the settlement asked for it failed: ${String(e)}`);
          }
          throwIfStopped();
          if (!mls.isWsOpen()) {
            // The link dropped under the settlement: offline, a wait - the reconnect asks again.
            log(
              `[Call] group ${short}: the link dropped during the settlement - waiting for the reconnect`
            );
            settleAskedFor = null;
            continue;
          }
          if ((await mls.ownCommitState(groupId)) === 'unresolved') {
            throw new CallGroupCommitUnresolvedError(
              groupId,
              local,
              server,
              'a commit of ours is still unresolved after the settlement the wait asked for'
            );
          }
          readTarget = true;
          continue;
        } else if (own === 'none' && listedFor === state && drained) {
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
            throw new CallGroupNotHeldError(
              groupId,
              null,
              server,
              'not held after a complete pull'
            );
          }
          if (server !== null && local !== null && local < server) {
            // BEHIND WITH THE MAILBOX LISTED: the commit log may hold what the mailbox lacks.
            if (replayedFor !== state) {
              replayedFor = state;
              replaysHeld = 0;
            }
            round.disarm();
            log(
              `[Call] group ${short} drained at ${local} below the server's ${server} - caught up from the commit log (rung 1)`
            );
            const outcome = await mls.catchUpFromCommitLog(groupId);
            throwIfStopped();
            if (outcome === 'unreachable') {
              if (!mls.isWsOpen()) {
                // Offline: a wait. The new link lists the mailbox again before anything is judged.
                log(
                  `[Call] group ${short}: the commit log could not be read, the link down - waiting for the reconnect`
                );
                askedFor = null;
                listedFor = null;
                readTarget = true;
                continue;
              }
              throw new CallGroupLogUnreachableError(
                groupId,
                local,
                server,
                'the commit log could not be read, the link up - nothing is known about the gap'
              );
            }
            if (outcome === 'still-behind') {
              throw new CallGroupStuckError(
                groupId,
                local,
                server,
                'drained below the server after a complete pull, and the commit log could not close the gap'
              );
            }
            if (outcome === 'held') {
              replaysHeld += 1;
              if (replaysHeld >= 2) {
                throw new CallGroupStuckError(
                  groupId,
                  local,
                  server,
                  'the commit log is held behind refused frames a complete pull did not bring'
                );
              }
              // The frames that hold it are pulled: a pull of the wait's own lists them, then the
              // state is judged again.
              askedFor = null;
              listedFor = null;
            }
            readTarget = true;
            continue;
          }
          if (server !== null && local !== null && local > server) {
            throw new CallGroupAheadError(
              groupId,
              local,
              server,
              'ahead of the server after a complete pull, no commit of ours in flight or unresolved'
            );
          }
        }

        const disagrees =
          target === 'unread' || (mailboxQuiet && (!held || (server !== null && local !== server)));
        if (linkUp && own === 'none' && askedFor !== state && disagrees) {
          askedFor = state;
          round.disarm();
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
          } else if (!mls.isWsOpen()) {
            // The link went down under it: offline, a wait - nothing counted, and the reconnect's
            // event allows a new ask, whatever its listing changed.
            log(
              `[Call] group ${short}: the pull asked for it could not list the mailbox - the link is down, waiting for the reconnect`
            );
            reaskAfterEvent = true;
          } else {
            incompleteAsks += 1;
            log(
              `[Call] WARN group ${short}: the pull asked for it could not list the mailbox, the link up (${incompleteAsks} in a row)`
            );
            if (incompleteAsks >= 2) {
              throw new CallGroupUnlistedError(
                groupId,
                local,
                server,
                'two pulls asked in a row, the link up, could not list the mailbox'
              );
            }
            // A pull still running or owed will end with an event: the ask waits for it. With none,
            // nothing will come - asked again now, and counted.
            if (mls.mailboxListing() === 'pending') reaskAfterEvent = true;
            else askedFor = null;
          }
          readTarget = true;
          continue;
        }

        if (linkUp) offlineSaid = false;
        sayWaiting(linkUp ? 'conversation' : 'network');
        event = await round.next;
        // The server's epoch moves only with a commit: re-read on what can carry one.
        if (own !== 'none') readTarget = true;
        else if (server !== null && local !== null && local > server) readTarget = true;
        else if (target === 'unread' && (event === 'pull' || event === 'catch-up')) {
          readTarget = true;
        } else if (server !== null && event !== 'frame') readTarget = true;
      } finally {
        round.disarm();
      }
      if (reaskAfterEvent) {
        reaskAfterEvent = false;
        askedFor = null;
      }
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
        const level = callGroupUnreachable(e.kind) ? 'WARN' : 'ERROR';
        log(`[Call] ${level} call=${callId}: ${e.message}, after ${since()} ms`);
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
