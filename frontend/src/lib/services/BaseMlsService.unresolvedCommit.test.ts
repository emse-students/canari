// @vitest-environment happy-dom
// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/TauriMlsService', () => ({ TauriMlsService: class {} }));
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));
const persistMlsStructuralCheckpoint = vi.hoisted(() => vi.fn());
const scheduleOutboundMlsPersist = vi.hoisted(() => vi.fn());
vi.mock('$lib/mls-client/mlsStatePersisterRegistry', () => ({
  persistMlsStructuralCheckpoint: (...a: unknown[]) => persistMlsStructuralCheckpoint(...a),
  scheduleOutboundMlsPersist: () => scheduleOutboundMlsPersist(),
}));

import 'fake-indexeddb/auto';
import { BaseMlsService } from './BaseMlsService';
import {
  COMMIT_LOCK_BUDGET_SPENT_REASON,
  CommitRefusedError,
} from '$lib/mls-client/CommitRefusedError';
import {
  CommitOutcomeUnknownError,
  CommitStageNotSavedError,
  FollowerTabCommitError,
  StagedCommitPendingError,
  encodeIntent,
  type CommitIntent,
  type OwedWelcome,
  type PendingSubmissionRead,
  type StagedRecord,
} from '$lib/mls-client/commitSubmission';
import { readLeafRefreshLedger } from '$lib/mls-client/leafRefresh';
import backgroundWelcomeIntent from '$lib/mls-client/test/fixtures/background-welcome-intent.json';
import { sealedFrame } from '$lib/mls-client/test/sealedFrame';
import type { AuthoredFrame } from '$lib/mls-client/mlsDeliveryApi';
import { ApiRefusalError } from '$lib/utils/apiRefusalError';
import { MlsCheckpointNotWrittenError, MlsStateWriteRefusedError } from '$lib/utils/hex';
import { clearEpochGap, isInEpochGap } from '$lib/utils/chat/epochGapRegistry';
import { TransportFailureError, isTransportFailure } from '$lib/utils/transportFailure';
import {
  ADD_LOCK_WAIT_BOUND_MS,
  MlsDeliveryApi,
  WelcomeTargetNotMemberError,
  WelcomeTargetUnknownError,
  type RefusedAdmit,
} from '$lib/mls-client/mlsDeliveryApi';
import { MlsPerGroupScheduler } from '$lib/mls-client/mlsPerGroupScheduler';
import {
  listOwedInvitations,
  type OwedInvitation,
  type ReplanVerdict,
} from '$lib/mls-client/owedInvitations';
import { DEADLINE_MS, RequestDeadlineError } from '$lib/utils/requestDeadline';
import { plainCommitLock } from '$lib/mls-client/test/fixtures/plainCommitLock';

/**
 * A SUBMISSION WHOSE ANSWER WAS LOST IS RESUBMITTED, NEVER GUESSED - AND IT IS KEPT IN THE MLS STATE.
 *
 * Reading the server's log after a lost answer cannot tell "not landed yet" from "never landed": a
 * clear decided from an empty log races the request still in flight. So the SAME bytes are sent
 * again, the gate answers a duplicate of an accepted commit as accepted, and an outcome that stays
 * unknown is KEPT - beside the staged commit, in the same state, written by the same platform call
 * that staged it, so no checkpoint can hold one without the other. A staged commit with no record
 * was therefore never sent. These cases pin each verdict and each place a resubmission is owed.
 *
 * The platform's staged commit and its record are modelled by `state`, with the crate's rules
 * (`mls-core/tests/pending_submission.rs` pins them): a stage starts a commit WITH its record, a
 * merge or a clear ends both.
 */

const U = 'user-a';
const D = 'web-a';
const G = 'g-1';
const OURS = 'AQ=='; // base64 of the staged commit [1]
const BASE = 'Ag=='; // base64 of the staged groupInfo [2]

const proto = BaseMlsService.prototype as unknown as Record<string, unknown>;

type Answer = {
  accepted: boolean;
  reason?: string;
  currentEpoch?: number;
  duplicate?: boolean;
  refusedAdmits?: RefusedAdmit[];
  userIds?: string[];
};
type Step = Answer | Error;

/** A delivery whose `submitCommit` answers (or throws) each step in turn. */
function submitting(...steps: Step[]) {
  const fn = vi.fn();
  for (const s of steps) {
    if (s instanceof Error) fn.mockRejectedValueOnce(s);
    else fn.mockResolvedValueOnce(s);
  }
  return fn;
}

const lost = () => new TransportFailureError(new TypeError('Failed to fetch'));

/** group id -> what its state says of its staged commit's record (`none`: staged, never submitted). */
type PendingState = Map<string, PendingSubmissionRead>;

/** A record as the crate writes it: this client's intent, and the stage's own output. */
function recordOf(
  intent: Partial<CommitIntent> = {},
  out: { welcome?: Uint8Array; addedIndices?: number[] } = {}
): StagedRecord {
  return {
    intent: encodeIntent({ groupId: G, self: `${U}:${D}`, ...intent }),
    baseEpoch: 5,
    commit: new Uint8Array([1]),
    groupInfo: new Uint8Array([2]),
    ...(out.welcome ? { welcome: out.welcome } : {}),
    addedIndices: out.addedIndices ?? [],
  };
}

/**
 * group id -> the Welcomes its Adds still owe, one entry per Add, with the crate's rules
 * (`mls-core/src/owed_welcome.rs`): a later Add supersedes a recipient an earlier entry names, and a
 * delivery clears the entry carrying the delivered bytes only.
 */
type OwedState = Map<string, OwedWelcome[]>;

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

function primitives(state: PendingState, owed: OwedState = new Map()) {
  return {
    owed,
    mergePendingCommitOwingWelcome: vi.fn(async (g: string, recipients: string[]) => {
      const read = state.get(g);
      if (read?.status !== 'recorded' || !read.record.welcome) throw new Error('InvalidData');
      const entries = (owed.get(g) ?? [])
        .map((w) => ({ ...w, recipients: w.recipients.filter((r) => !recipients.includes(r)) }))
        .filter((w) => w.recipients.length > 0);
      entries.push({
        groupId: g,
        welcome: read.record.welcome,
        ratchetTree: new Uint8Array([7]),
        recipients,
      });
      owed.set(g, entries);
      state.delete(g);
    }),
    owedWelcomes: vi.fn(async () =>
      [...owed.values()].flat().map((w) => ({ ...w, recipients: [...w.recipients] }))
    ),
    welcomeDelivered: vi.fn(async (g: string, r: string, welcome: Uint8Array) => {
      const entries = owed.get(g);
      const entry = entries?.find((w) => sameBytes(w.welcome, welcome) && w.recipients.includes(r));
      if (!entries || !entry) return;
      entry.recipients = entry.recipients.filter((x) => x !== r);
      const left = entries.filter((w) => w.recipients.length > 0);
      if (left.length === 0) owed.delete(g);
      else owed.set(g, left);
    }),
    pendingSubmission: vi.fn(async (g: string) => state.get(g) ?? { status: 'none' }),
    groupsWithPendingCommit: vi.fn(async () => [...state.keys()]),
    // The key the merged commit gives this device's leaf, which the ledger names it by.
    ownLeafKey: vi.fn(async () => 'k-leaf'),
    mergePendingCommit: vi.fn(async (g: string) => {
      state.delete(g);
    }),
    clearPendingCommit: vi.fn(async (g: string) => {
      state.delete(g);
    }),
  };
}

function ctx(
  submitCommit: ReturnType<typeof vi.fn>,
  opts: { state?: PendingState; owed?: OwedState } = {}
) {
  const state: PendingState = opts.state ?? new Map();
  const c: Record<string, unknown> = {
    userId: U,
    deviceId: D,
    state,
    delivery: {
      submitCommit,
      // The one request a Welcome is; `sendWelcome` itself is the real seam that consumes what is owed.
      sendWelcome: vi.fn().mockResolvedValue(undefined),
      acquireAddLock: vi.fn().mockResolvedValue({ acquired: true, token: 'tok' }),
      releaseAddLock: vi.fn().mockResolvedValue(true),
    },
    ...plainCommitLock,
    runUnderMlsLock: <T>(fn: () => Promise<T>) => fn(),
    freshEpoch: vi.fn().mockResolvedValue(5),
    getEpoch: vi.fn(() => 5),
    exportRatchetTree: vi.fn().mockResolvedValue(new Uint8Array([7])),
    welcomeSendsInFlight: new Map(),
    catchUpOnRefusedCommit: vi.fn().mockResolvedValue(undefined),
    unresolvedGroups: null,
    // The lost-invitation drain (`owedInvitations.ts`): no re-planner unless a case registers one.
    owedInvitationReplanner: null,
    owedInvitationDrain: null,
    owedInvitationDrainAgain: false,
    connectionSettling: false,
    connectionSettled: false,
    owedInvitationGeneration: 0,
    addLocksHeld: new Map<string, string | undefined>(),
    addLockExpiryWakes: new Map(),
    unrecordedInvitationTeller: null,
    unrecordedInvitationsUntold: [],
    isWsOpen: () => true,
    ...primitives(state, opts.owed),
  };
  // The real seams under test: what they decide from the gate's answers is what these cases are about.
  for (const name of [
    'runCommitTransaction',
    'settleUnresolvedLocked',
    'escalateUnreadableSubmission',
    'submitRecorded',
    'resubmitUnresolved',
    'awaitCommitCheckpoint',
    'checkpointStageBeforeSend',
    'mergeSettled',
    'mergeAccepted',
    'noteOwnLeafReplaced',
    'consumeOwedWelcome',
    'deliverOwedWelcomes',
    'sendWelcome',
    'sendWelcomeConsuming',
    'knownUnresolvedGroups',
    'settleUnresolvedCommits',
    'settleUnresolvedCommitFromLog',
    'oweLostInvitation',
    'setOwedInvitationReplanner',
    'replanOwedInvitations',
    'drainOwedInvitationsOnce',
    'settleEach',
    'replanOwedInvitationsIn',
    'acquireAddLock',
    'releaseAddLock',
    'wakeAtAddLockExpiry',
    'cancelAddLockExpiryWakes',
    'notifyCommitsApplied',
  ]) {
    c[name] = proto[name];
  }
  return c as unknown as Record<string, ReturnType<typeof vi.fn>> & {
    state: PendingState;
    owed: OwedState;
    delivery: {
      submitCommit: ReturnType<typeof vi.fn>;
      sendWelcome: ReturnType<typeof vi.fn>;
      acquireAddLock: (
        g: string
      ) => Promise<
        | { acquired: true; token: string | undefined }
        | { acquired: false; retryAfterMs: number | undefined }
      >;
      releaseAddLock: (g: string, token: string | undefined) => Promise<boolean>;
    };
    runCommitTransaction(
      g: string,
      stage: (intent: Uint8Array) => Promise<unknown>,
      opts?: Record<string, unknown>
    ): Promise<unknown>;
    settleUnresolvedCommits(groupIds?: string[]): Promise<void>;
    settleUnresolvedCommitFromLog(g: string, atBase: string | null): Promise<string>;
  };
}

/** A stage as the crate does it: ONE call stages the commit and records it with `intent`. */
function stagerOf(c: ReturnType<typeof ctx>, out: { welcome?: Uint8Array } = {}) {
  return vi.fn(async (intent: Uint8Array) => {
    c.state.set(G, {
      status: 'recorded',
      record: { ...recordOf({}, out), intent },
    });
    return { commit: new Uint8Array([1]), groupInfo: new Uint8Array([2]), ...out };
  });
}

const run = (c: ReturnType<typeof ctx>, stage = stagerOf(c)) =>
  c.runCommitTransaction(G, stage, { removes: [{ userId: 'user-z' }] });

/** A group whose state holds a staged commit and the record its stage wrote. */
function kept(
  intent: Partial<CommitIntent> = {},
  out: { welcome?: Uint8Array; addedIndices?: number[] } = {}
): PendingState {
  return new Map([[G, { status: 'recorded', record: recordOf(intent, out) }]]);
}

beforeEach(() => {
  localStorage.clear();
  clearEpochGap(G);
  persistMlsStructuralCheckpoint.mockReset().mockResolvedValue(true);
});

describe('runCommitTransaction - the record is written by the stage, never after it', () => {
  it('hands the stage its intent, and submits what the record holds', async () => {
    const c = ctx(submitting({ accepted: true }));
    const stage = stagerOf(c);
    await run(c, stage);
    const intent = JSON.parse(new TextDecoder().decode(stage.mock.calls[0][0])) as CommitIntent;
    expect(intent).toEqual({ groupId: G, self: `${U}:${D}`, removes: [{ userId: 'user-z' }] });
    expect(c.delivery.submitCommit).toHaveBeenCalledExactlyOnceWith(
      G,
      5,
      OURS,
      undefined,
      BASE,
      undefined,
      [{ userId: 'user-z' }],
      undefined
    );
  });

  it('never lets a checkpoint running concurrently see the staged commit without its record', async () => {
    // A checkpoint does not take the MLS lock: it exports whenever it runs. Here one runs on every
    // turn of the event loop for the whole transaction, and every snapshot it takes must hold the
    // staged commit together with its record, or neither.
    const c = ctx(submitting(lost(), lost()));
    // Every crossing to the platform or the network takes a turn of the event loop, as a real one
    // does, so the checkpointer below runs between each of them.
    const turn = () => new Promise((r) => setTimeout(r, 0));
    for (const name of ['pendingSubmission', 'groupsWithPendingCommit', 'freshEpoch'] as const) {
      const real = c[name].getMockImplementation()!;
      c[name].mockImplementation(async (...a: unknown[]) => {
        await turn();
        return (real as (...x: unknown[]) => unknown)(...a);
      });
    }
    const submit = c.delivery.submitCommit;
    c.delivery.submitCommit = vi.fn(async (...a: unknown[]) => {
      await turn();
      return (submit as (...x: unknown[]) => unknown)(...a);
    });
    const stage = stagerOf(c);
    const slowStage = vi.fn(async (intent: Uint8Array) => {
      await turn();
      const out = await stage(intent);
      await turn();
      return out;
    });
    const snapshots: PendingSubmissionRead[] = [];
    let running = true;
    const checkpointer = (async () => {
      while (running) {
        const now = c.state.get(G);
        if (now) snapshots.push(now);
        await turn();
      }
    })();
    await run(c, slowStage).catch(() => {});
    running = false;
    await checkpointer;
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots.every((s) => s.status === 'recorded')).toBe(true);
  });

  it('puts the stage and its record on disk BEFORE the first request leaves, so a crash after the send reloads them', async () => {
    // The disk is what the last checkpoint exported. The request leaves, and the device crashes
    // before any further checkpoint: the reload is whatever the disk held when it left.
    const disk: PendingState = new Map();
    persistMlsStructuralCheckpoint.mockImplementation(async () => {
      disk.clear();
      for (const [g, read] of c.state) disk.set(g, read);
      return true;
    });
    // What the disk held at the moment the first request left: all a crash right then leaves.
    let atSend: PendingState | null = null;
    const c = ctx(
      vi.fn(async () => {
        atSend ??= new Map(disk);
        throw lost();
      })
    );
    await expect(run(c)).rejects.toBeInstanceOf(CommitOutcomeUnknownError);
    expect(atSend!.get(G)).toMatchObject({ status: 'recorded', record: { baseEpoch: 5 } });

    // The reload: the state is the disk. The gate had taken the commit, and answers its
    // resubmission as a duplicate - the device merges the commit it sent, never forgets it.
    const reloaded = ctx(submitting({ accepted: true, duplicate: true }), {
      state: new Map(atSend!),
    });
    expect(reloaded.state.get(G)).toMatchObject({ status: 'recorded' });
    await reloaded.settleUnresolvedCommits();
    expect(reloaded.delivery.submitCommit.mock.calls[0].slice(0, 3)).toEqual([G, 5, OURS]);
    expect(reloaded.mergePendingCommit).toHaveBeenCalledTimes(1);
    expect(reloaded.clearPendingCommit).not.toHaveBeenCalled();
  });

  /**
   * A checkpoint can throw AFTER its write landed, so a stage whose checkpoint "failed" may be on
   * disk. Cleared and reported as failed, the next reload contradicted the report: its settle landed
   * the commit. The outcome reported and the disk now agree whatever the write did - the stage is
   * kept and reported UNKNOWN, and the settle that decides it checkpoints before its request.
   */
  it('sends nothing and KEEPS the stage, reported unknown, when that checkpoint throws', async () => {
    // The write landed, then the call threw.
    const disk: PendingState = new Map();
    persistMlsStructuralCheckpoint.mockImplementationOnce(async () => {
      for (const [g, read] of c.state) disk.set(g, read);
      throw new Error('the IPC answer was lost');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = ctx(submitting());
    await expect(run(c)).rejects.toBeInstanceOf(CommitOutcomeUnknownError);
    expect(c.delivery.submitCommit).not.toHaveBeenCalled();
    expect(c.clearPendingCommit).not.toHaveBeenCalled();
    expect(c.state.get(G)).toMatchObject({ status: 'recorded' });

    // Reloaded from that disk, the settle sends it - the outcome the caller was told is still open.
    const reloaded = ctx(submitting({ accepted: true }), { state: new Map(disk) });
    await reloaded.settleUnresolvedCommits();
    expect(reloaded.mergePendingCommit).toHaveBeenCalledTimes(1);
    vi.mocked(console.error).mockRestore();
  });

  it('a settle sends no kept commit whose checkpoint still throws - it stays unknown', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = ctx(submitting({ accepted: true }), { state: kept() });
    persistMlsStructuralCheckpoint.mockRejectedValue(new Error('disk full'));
    await c.settleUnresolvedCommits([G]);
    expect(c.delivery.submitCommit).not.toHaveBeenCalled();
    expect(c.state.get(G)).toMatchObject({ status: 'recorded' });
    vi.mocked(console.error).mockRestore();
  });

  /**
   * A checkpoint that PROVES it stored nothing (refused, or failed before its write) cannot have put
   * the stage on disk, and the commit never left: the stage is cleared and the failure is definitive.
   * Kept unknown instead, a checkpoint that keeps failing (a full quota) blocked every send in the
   * group for the rest of the session.
   */
  it.each([
    [
      'failed at its store',
      () => new MlsCheckpointNotWrittenError('store', new Error('QuotaExceeded')),
    ],
    ['failed at its export', () => new MlsCheckpointNotWrittenError('export', new Error('seal'))],
    ['was refused by an ended document', () => new MlsStateWriteRefusedError('ended')],
  ])('clears the stage, definitively, when its checkpoint %s', async (_what, failure) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    persistMlsStructuralCheckpoint.mockRejectedValueOnce(failure());
    const c = ctx(submitting({ accepted: true }));
    await expect(run(c)).rejects.toBeInstanceOf(CommitStageNotSavedError);
    expect(c.delivery.submitCommit).not.toHaveBeenCalled();
    expect(c.clearPendingCommit).toHaveBeenCalledTimes(1);
    expect(c.state.has(G)).toBe(false);

    // The group is free: the next commit is staged, saved and sent.
    await run(c);
    expect(c.delivery.submitCommit).toHaveBeenCalledTimes(1);
    expect(c.mergePendingCommit).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it('keeps the stage unknown when it stored nothing but its clear fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    persistMlsStructuralCheckpoint.mockRejectedValueOnce(
      new MlsCheckpointNotWrittenError('store', new Error('QuotaExceeded'))
    );
    const c = ctx(submitting());
    c.clearPendingCommit.mockRejectedValueOnce(new Error('platform gone'));
    await expect(run(c)).rejects.toBeInstanceOf(CommitOutcomeUnknownError);
    expect(c.delivery.submitCommit).not.toHaveBeenCalled();
    expect(c.state.get(G)).toMatchObject({ status: 'recorded' });
    vi.restoreAllMocks();
  });

  /**
   * A follower tab's state is a copy no disk and no other tab follows, and the leader cannot read a
   * commit of its own leaf back: committed from a follower, the group moved past what the leader
   * keeps. Refused from leadership, before anything is staged.
   */
  it('stages nothing on a follower tab', async () => {
    const leadership = await import('$lib/mls-client/tabLeader');
    vi.spyOn(leadership, 'getTabLeadership').mockReturnValue('follower');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const c = ctx(submitting({ accepted: true }));
    const stage = stagerOf(c);
    await expect(run(c, stage)).rejects.toBeInstanceOf(FollowerTabCommitError);
    expect(stage).not.toHaveBeenCalled();
    expect(c.delivery.submitCommit).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('sends nothing and clears when the stage left no usable record', async () => {
    const c = ctx(submitting());
    const stage = vi.fn(async () => {
      c.state.set(G, { status: 'unreadable' });
      return { commit: new Uint8Array([1]), groupInfo: new Uint8Array([2]) };
    });
    await expect(run(c, stage)).rejects.toThrow('no usable record');
    expect(c.delivery.submitCommit).not.toHaveBeenCalled();
    expect(c.clearPendingCommit).toHaveBeenCalledTimes(1);
  });
});

describe('runCommitTransaction - a submission that got no answer', () => {
  it('resubmits the SAME request, and merges when the resubmission is accepted', async () => {
    const c = ctx(submitting(lost(), { accepted: true }));
    await run(c);
    expect(c.delivery.submitCommit).toHaveBeenCalledTimes(2);
    expect(c.delivery.submitCommit.mock.calls[1]).toEqual(c.delivery.submitCommit.mock.calls[0]);
    expect(c.delivery.submitCommit.mock.calls[0].slice(0, 3)).toEqual([G, 5, OURS]);
    expect(c.mergePendingCommit).toHaveBeenCalledTimes(1);
    expect(c.clearPendingCommit).not.toHaveBeenCalled();
    expect(c.state.size).toBe(0);
    expect(readLeafRefreshLedger(U, D)[G]).toMatchObject({ epoch: 6 });
  });

  it('merges when the gate answers the resubmission as a DUPLICATE of an accepted commit', async () => {
    const c = ctx(submitting(lost(), { accepted: true, duplicate: true }));
    await run(c);
    expect(c.mergePendingCommit).toHaveBeenCalledTimes(1);
    expect(c.clearPendingCommit).not.toHaveBeenCalled();
  });

  // THE GATE ASKS ITS COMMIT LOG BEFORE EVERY EPOCH REFUSAL (`answerIfAlreadyAccepted`), so a
  // resubmission that lost the advance to our own first request - still inside its transaction past
  // the server's 5 s commit lock - is answered `duplicate`. An `epoch_mismatch` is then another
  // device's commit, whatever epoch the server has reached since.
  it.each([6, 7])(
    'clears, catches up and refuses when another commit took the epoch, the server at %i',
    async (currentEpoch) => {
      const c = ctx(
        submitting(lost(), { accepted: false, reason: 'epoch_mismatch', currentEpoch })
      );
      await expect(run(c)).rejects.toBeInstanceOf(CommitRefusedError);
      expect(c.delivery.submitCommit).toHaveBeenCalledTimes(2);
      expect(c.clearPendingCommit).toHaveBeenCalledTimes(1);
      expect(c.catchUpOnRefusedCommit).toHaveBeenCalledWith(G, 5, currentEpoch, 'epoch_mismatch');
      expect(c.mergePendingCommit).not.toHaveBeenCalled();
      expect(c.state.size).toBe(0);
    }
  );

  // The gate reads seat claims per REQUEST: the first request, which got no answer, may still land
  // with claims of its own, so the 409 refuses only the copy that got it.
  it('KEEPS the commit, and never rebuilds it, on a 409 SEAT_CLAIM_OVERTAKEN to the resubmission', async () => {
    const overtaken = new ApiRefusalError(409, 'SEAT_CLAIM_OVERTAKEN', 'not accepted');
    const c = ctx(submitting(lost(), overtaken));
    c.unresolvedGroups = new Set() as never;
    const stage = stagerOf(c);
    const err = await run(c, stage).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommitOutcomeUnknownError);
    expect(stage).toHaveBeenCalledTimes(1);
    expect(c.delivery.submitCommit).toHaveBeenCalledTimes(2);
    expect(c.clearPendingCommit).not.toHaveBeenCalled();
    expect(c.mergePendingCommit).not.toHaveBeenCalled();
    expect(c.state.get(G)).toMatchObject({ status: 'recorded', record: { baseEpoch: 5 } });
    expect((c.unresolvedGroups as unknown as Set<string>).has(G)).toBe(true);
  });

  it('notes the group unresolved when the clear of a refused first request fails', async () => {
    const refusal = new ApiRefusalError(403, null, 'Commit submission HTTP error (403)');
    const c = ctx(submitting(refusal));
    c.unresolvedGroups = new Set() as never;
    c.clearPendingCommit.mockRejectedValueOnce(new Error('state busy'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(run(c)).rejects.toBe(refusal);
    expect((c.unresolvedGroups as unknown as Set<string>).has(G)).toBe(true);
    expect(c.state.has(G)).toBe(true);
    error.mockRestore();
  });

  it('clears WITHOUT resubmitting a 4xx - the gate answered, and it refused', async () => {
    const refusal = new ApiRefusalError(403, null, 'Commit submission HTTP error (403)');
    const c = ctx(submitting(refusal));
    await expect(run(c)).rejects.toBe(refusal);
    expect(c.delivery.submitCommit).toHaveBeenCalledTimes(1);
    expect(c.clearPendingCommit).toHaveBeenCalledTimes(1);
    expect(c.state.size).toBe(0);
  });

  it.each([
    ['a second transport failure', lost()],
    [
      'a 5xx - the advance may have committed before the answer was lost',
      new ApiRefusalError(502, null, 'bad gateway'),
    ],
    // The lock it reports may be held by this device's own first request, still being validated.
    [
      '`concurrent_commit` on the resubmission',
      { accepted: false, reason: 'concurrent_commit', currentEpoch: 5 },
    ],
    // The auth guard answers before the gate: a session that expired after an accepted but
    // unanswered first request says nothing of that request.
    ['a 401 on the resubmission', new ApiRefusalError(401, null, 'Unauthorized')],
    ['a 403 on the resubmission', new ApiRefusalError(403, null, 'Forbidden')],
  ] as Array<[string, Step]>)(
    'KEEPS the staged commit and its record, and checkpoints them, after %s',
    async (_name, second) => {
      const c = ctx(submitting(lost(), second));
      const err = await run(c).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CommitOutcomeUnknownError);
      // Read by every caller as "no answer": retried when the server answers, never final.
      expect(isTransportFailure(err)).toBe(true);
      expect(c.clearPendingCommit).not.toHaveBeenCalled();
      expect(c.mergePendingCommit).not.toHaveBeenCalled();
      expect(c.state.get(G)).toMatchObject({ status: 'recorded', record: { baseEpoch: 5 } });
      expect(persistMlsStructuralCheckpoint).toHaveBeenCalledTimes(1);
    }
  );

  it('delivers nothing itself when the Add is accepted at once - its caller sends the Welcome', async () => {
    const c = ctx(submitting(lost(), { accepted: true }));
    const out = (await c.runCommitTransaction(G, stagerOf(c, { welcome: new Uint8Array([3]) }), {
      excludeDeviceIds: ['user-b:dev-b'],
    })) as { welcome?: Uint8Array };
    expect(out.welcome).toEqual(new Uint8Array([3]));
    expect(c.delivery.sendWelcome).not.toHaveBeenCalled();
    // The admits travel with the commit, derived from the intent the stage recorded.
    expect(c.delivery.submitCommit.mock.calls[0][5]).toEqual([
      { userId: 'user-b', deviceId: 'dev-b' },
    ]);
  });
});

describe('runCommitTransaction - a group whose last commit is unresolved', () => {
  it('takes NO new commit while a resubmission of the old one still gets no answer', async () => {
    const c = ctx(submitting(lost()), { state: kept() });
    const stage = stagerOf(c);
    await expect(run(c, stage)).rejects.toBeInstanceOf(CommitOutcomeUnknownError);
    expect(stage).not.toHaveBeenCalled();
    expect(c.delivery.submitCommit.mock.calls[0].slice(0, 3)).toEqual([G, 5, OURS]);
    expect(c.state.has(G)).toBe(true);
  });

  it('merges the old commit when its resubmission is accepted, then stages the new one', async () => {
    const c = ctx(submitting({ accepted: true, duplicate: true }, { accepted: true }), {
      state: kept(),
    });
    const stage = stagerOf(c);
    await run(c, stage);
    expect(c.mergePendingCommit).toHaveBeenCalledTimes(2);
    expect(stage).toHaveBeenCalledTimes(1);
  });

  it('stages nothing once the settlement spent the lock budget its first request would need', async () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    // The settlement's resubmission is answered after two deadlines: one more does not fit.
    const submit = vi.fn(async () => {
      now += 2 * DEADLINE_MS.write + 1;
      return { accepted: true, duplicate: true };
    });
    const c = ctx(submit, { state: kept() });
    const stage = stagerOf(c);
    const err = await run(c, stage).catch((e: unknown) => e);
    clock.mockRestore();
    expect(err).toBeInstanceOf(CommitRefusedError);
    expect((err as CommitRefusedError).reason).toBe(COMMIT_LOCK_BUDGET_SPENT_REASON);
    expect(c.mergePendingCommit).toHaveBeenCalledTimes(1);
    expect(stage).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('sends nothing, and clears the stage, when its checkpoint spent the lock budget', async () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    persistMlsStructuralCheckpoint.mockImplementation(async () => {
      now += 2 * DEADLINE_MS.write + 1;
      return true;
    });
    const c = ctx(submitting({ accepted: true }));
    const stage = stagerOf(c);
    const err = await run(c, stage).catch((e: unknown) => e);
    clock.mockRestore();
    expect(err).toBeInstanceOf(CommitRefusedError);
    expect((err as CommitRefusedError).reason).toBe(COMMIT_LOCK_BUDGET_SPENT_REASON);
    expect(stage).toHaveBeenCalledTimes(1);
    expect(c.delivery.submitCommit).not.toHaveBeenCalled();
    expect(c.clearPendingCommit).toHaveBeenCalledTimes(1);
    expect(c.state.size).toBe(0);
  });

  it('keeps the unsent stage UNKNOWN, and notes it, when that clear fails', async () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    persistMlsStructuralCheckpoint.mockImplementation(async () => {
      now += 2 * DEADLINE_MS.write + 1;
      return true;
    });
    const c = ctx(submitting({ accepted: true }));
    c.unresolvedGroups = new Set() as never;
    c.clearPendingCommit.mockRejectedValueOnce(new Error('state busy'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = await run(c).catch((e: unknown) => e);
    clock.mockRestore();
    error.mockRestore();
    expect(err).toBeInstanceOf(CommitOutcomeUnknownError);
    expect(c.delivery.submitCommit).not.toHaveBeenCalled();
    expect(c.state.has(G)).toBe(true);
    expect((c.unresolvedGroups as unknown as Set<string>).has(G)).toBe(true);
  });
});

describe('settleUnresolvedCommits - the resubmission at the next connection', () => {
  it('merges on a duplicate answer, from the record kept in the state, and checkpoints', async () => {
    const c = ctx(submitting({ accepted: true, duplicate: true }), {
      state: kept({ excludeDeviceIds: ['u-b:d-b'] }),
    });
    await c.settleUnresolvedCommits();
    expect(c.delivery.submitCommit).toHaveBeenCalledExactlyOnceWith(
      G,
      5,
      OURS,
      ['u-b:d-b'],
      BASE,
      [{ userId: 'u-b', deviceId: 'd-b' }],
      undefined,
      undefined
    );
    expect(c.mergePendingCommit).toHaveBeenCalledTimes(1);
    expect(c.state.size).toBe(0);
    // One before the resubmission (nothing leaves that is not on disk), one after the merge.
    expect(persistMlsStructuralCheckpoint).toHaveBeenCalledTimes(2);
    expect(persistMlsStructuralCheckpoint.mock.invocationCallOrder[0]).toBeLessThan(
      c.delivery.submitCommit.mock.invocationCallOrder[0]
    );
  });

  it("delivers an Add's Welcome to every device it admits - nobody else is left to send it", async () => {
    const c = ctx(submitting({ accepted: true, duplicate: true }), {
      state: kept({ excludeDeviceIds: ['u-b:d-b1', 'u-b:d-b2'] }, { welcome: new Uint8Array([3]) }),
    });
    await c.settleUnresolvedCommits();
    expect(c.mergePendingCommitOwingWelcome).toHaveBeenCalledExactlyOnceWith(G, [
      'u-b:d-b1',
      'u-b:d-b2',
    ]);
    expect(c.mergePendingCommit).not.toHaveBeenCalled();
    // The tree the joiner needs is the one of the epoch the Add created, captured by the merge.
    expect(c.delivery.sendWelcome.mock.calls).toEqual([
      [new Uint8Array([3]), 'u-b', G, 'd-b1', new Uint8Array([7])],
      [new Uint8Array([3]), 'u-b', G, 'd-b2', new Uint8Array([7])],
    ]);
    expect(c.owed.size).toBe(0);
  });

  it('writes the owed Welcome with the merge and checkpoints it BEFORE the first send', async () => {
    const c = ctx(submitting({ accepted: true, duplicate: true }), {
      state: kept({ excludeDeviceIds: ['u-b:d-b'] }, { welcome: new Uint8Array([3]) }),
    });
    await c.settleUnresolvedCommits();
    const merged = c.mergePendingCommitOwingWelcome.mock.invocationCallOrder[0];
    // [0] is the checkpoint before the resubmission; [1] is the one after the merge.
    const durable = persistMlsStructuralCheckpoint.mock.invocationCallOrder[1];
    const sent = c.delivery.sendWelcome.mock.invocationCallOrder[0];
    const cleared = c.welcomeDelivered.mock.invocationCallOrder[0];
    expect(merged).toBeLessThan(durable);
    expect(durable).toBeLessThan(sent);
    expect(sent).toBeLessThan(cleared);
  });

  it('after a reload mid-settlement, re-sends ONLY the Welcomes still owed and re-merges nothing', async () => {
    // The reload came after the merge's checkpoint and after d-b1's Welcome was sent and cleared.
    const owed: OwedState = new Map([
      [
        G,
        [
          {
            groupId: G,
            welcome: new Uint8Array([3]),
            ratchetTree: new Uint8Array([7]),
            recipients: ['u-b:d-b2'],
          },
        ],
      ],
    ]);
    const c = ctx(submitting(), { owed });
    await c.settleUnresolvedCommits();
    expect(c.delivery.submitCommit).not.toHaveBeenCalled();
    expect(c.mergePendingCommit).not.toHaveBeenCalled();
    expect(c.mergePendingCommitOwingWelcome).not.toHaveBeenCalled();
    expect(c.delivery.sendWelcome.mock.calls).toEqual([
      [new Uint8Array([3]), 'u-b', G, 'd-b2', new Uint8Array([7])],
    ]);
    expect(owed.size).toBe(0);
  });

  it('keeps a Welcome owed when its send fails, for the next settlement', async () => {
    const c = ctx(submitting({ accepted: true, duplicate: true }), {
      state: kept({ excludeDeviceIds: ['u-b:d-b'] }, { welcome: new Uint8Array([3]) }),
    });
    c.delivery.sendWelcome.mockRejectedValueOnce(lost());
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await c.settleUnresolvedCommits();
    expect(c.owed.get(G)?.[0].recipients).toEqual(['u-b:d-b']);
    error.mockRestore();
    await c.settleUnresolvedCommits();
    expect(c.delivery.sendWelcome).toHaveBeenCalledTimes(2);
    expect(c.owed.size).toBe(0);
  });

  it('stops owing a Welcome the server refuses WELCOME_TARGET_NOT_MEMBER - never re-sent at the next settlement', async () => {
    // The DUP/OFF rows of 2026-10-25: the refused Welcome went again at every connection, for ever.
    const c = ctx(submitting({ accepted: true, duplicate: true }), {
      state: kept({ excludeDeviceIds: ['u-b:d-b1', 'u-b:d-b2'] }, { welcome: new Uint8Array([3]) }),
    });
    c.delivery.sendWelcome
      .mockRejectedValueOnce(new WelcomeTargetNotMemberError(G, 'u-b', 'd-b1'))
      .mockRejectedValueOnce(lost());
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await c.settleUnresolvedCommits();
    // The terminal refusal is cleared; the transport failure beside it stays owed.
    expect(c.owed.get(G)?.[0].recipients).toEqual(['u-b:d-b2']);
    expect(
      error.mock.calls.some(([line]) => String(line).includes('terminal, no longer owed'))
    ).toBe(true);
    error.mockRestore();
    await c.settleUnresolvedCommits();
    expect(c.delivery.sendWelcome.mock.calls.map((call) => call[3])).toEqual([
      'd-b1',
      'd-b2',
      'd-b2',
    ]);
    expect(c.owed.size).toBe(0);
  });

  it('delivers no Welcome when the kept Add is refused', async () => {
    const c = ctx(submitting({ accepted: false, reason: 'epoch_mismatch', currentEpoch: 7 }), {
      state: kept({ excludeDeviceIds: ['u-b:d-b'] }, { welcome: new Uint8Array([3]) }),
    });
    await c.settleUnresolvedCommits();
    expect(c.clearPendingCommit).toHaveBeenCalledTimes(1);
    expect(c.catchUpOnRefusedCommit).toHaveBeenCalledWith(G, 5, 7);
    expect(c.delivery.sendWelcome).not.toHaveBeenCalled();
    expect(c.state.size).toBe(0);
  });

  it('keeps both when the resubmission gets no answer either', async () => {
    const c = ctx(submitting(lost()), { state: kept() });
    await c.settleUnresolvedCommits();
    expect(c.clearPendingCommit).not.toHaveBeenCalled();
    expect(c.mergePendingCommit).not.toHaveBeenCalled();
    expect(c.state.has(G)).toBe(true);
  });

  it('keeps the commit on a 409 to the settlement - it may be our own first request', async () => {
    const c = ctx(submitting(new ApiRefusalError(409, 'SEAT_CLAIM_OVERTAKEN', 'not accepted')), {
      state: kept(),
    });
    await c.settleUnresolvedCommits();
    expect(c.clearPendingCommit).not.toHaveBeenCalled();
    expect(c.mergePendingCommit).not.toHaveBeenCalled();
    expect(c.state.has(G)).toBe(true);
  });

  it('clears, with no request, a staged commit that has no record - it was never sent', async () => {
    const c = ctx(submitting(), { state: new Map([[G, { status: 'none' }]]) });
    await c.settleUnresolvedCommits();
    expect(c.delivery.submitCommit).not.toHaveBeenCalled();
    expect(c.clearPendingCommit).toHaveBeenCalledTimes(1);
    expect(c.state.size).toBe(0);
  });

  it.each([
    ['a record that does not decode', { status: 'unreadable' } as PendingSubmissionRead],
    [
      'a record whose intent does not decode',
      {
        status: 'recorded',
        record: { ...recordOf(), intent: new Uint8Array([0xff]) },
      } as PendingSubmissionRead,
    ],
  ])(
    'neither clears nor merges %s - the outcome is undecided, and rung 2 is owed',
    async (_n, read) => {
      const c = ctx(submitting(), { state: new Map([[G, read]]) });
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      await c.settleUnresolvedCommits();
      expect(c.delivery.submitCommit).not.toHaveBeenCalled();
      expect(c.clearPendingCommit).not.toHaveBeenCalled();
      expect(c.mergePendingCommit).not.toHaveBeenCalled();
      expect(c.state.has(G)).toBe(true);
      expect(isInEpochGap(G)).toBe(true);
      expect(error.mock.calls.some((a) => String(a[0]).includes('UNREADABLE'))).toBe(true);
      error.mockRestore();
    }
  );
});

describe('settleUnresolvedCommits - a stage a background engine wrote', () => {
  it('settles the record the Android background Welcome writes: the Add is merged and carol gets her Welcome', async () => {
    // The intent is the fixture `background.rs` asserts it writes, byte for byte.
    const gid = backgroundWelcomeIntent.groupId;
    const state: PendingState = new Map([
      [
        gid,
        {
          status: 'recorded',
          record: {
            intent: new TextEncoder().encode(JSON.stringify(backgroundWelcomeIntent)),
            baseEpoch: 1,
            commit: new Uint8Array([1]),
            groupInfo: new Uint8Array([2]),
            welcome: new Uint8Array([3]),
            addedIndices: [0],
          },
        },
      ],
    ]);
    const c = ctx(submitting({ accepted: true, duplicate: true }), { state });
    await c.settleUnresolvedCommits();
    expect(c.delivery.submitCommit).toHaveBeenCalledExactlyOnceWith(
      gid,
      1,
      OURS,
      ['carol:dev-c'],
      BASE,
      [{ userId: 'carol', deviceId: 'dev-c' }],
      undefined,
      undefined
    );
    expect(c.mergePendingCommitOwingWelcome).toHaveBeenCalledExactlyOnceWith(gid, ['carol:dev-c']);
    expect(c.delivery.sendWelcome.mock.calls).toEqual([
      [new Uint8Array([3]), 'carol', gid, 'dev-c', new Uint8Array([7])],
    ]);
    expect(state.size).toBe(0);
  });

  it('indexes the state under the MLS lock, so a settle in flight is never re-indexed from a stale read', async () => {
    let answer!: (a: Answer) => void;
    const submit = vi.fn(
      () =>
        new Promise<Answer>((r) => {
          answer = r;
        })
    );
    const c = ctx(submit, { state: kept() });
    let tail: Promise<unknown> = Promise.resolve();
    c.runUnderMlsLock = vi.fn(<T>(fn: () => Promise<T>) => {
      const run = tail.then(fn);
      tail = run.catch(() => {});
      return run;
    }) as unknown as ReturnType<typeof vi.fn>;
    // The read answers what the state held WHEN it was asked, a turn later - as a platform call does.
    c.groupsWithPendingCommit = vi.fn(() => {
      const snapshot = [...c.state.keys()];
      return new Promise<string[]>((r) => setTimeout(() => r(snapshot), 0));
    });
    const first = c.settleUnresolvedCommits();
    await vi.waitFor(() => expect(submit).toHaveBeenCalled());
    const second = c.settleUnresolvedCommits(['g-other']);
    answer({ accepted: true, duplicate: true });
    await Promise.all([first, second]);
    expect(c.state.size).toBe(0);
    expect((c as unknown as { unresolvedGroups: Set<string> }).unresolvedGroups).toEqual(new Set());
  });
});

describe('settleUnresolvedCommitFromLog - the log decided at the base epoch', () => {
  it("merges when the row at the base epoch is OUR commit, and delivers an Add's Welcome", async () => {
    const c = ctx(submitting(), {
      state: kept({ excludeDeviceIds: ['u-b:d-b'] }, { welcome: new Uint8Array([3]) }),
    });
    expect(await c.settleUnresolvedCommitFromLog(G, OURS)).toBe('merged');
    expect(c.mergePendingCommitOwingWelcome).toHaveBeenCalledTimes(1);
    expect(c.delivery.sendWelcome).toHaveBeenCalledTimes(1);
  });

  it("clears when the row at the base epoch is another device's commit", async () => {
    const c = ctx(submitting(), { state: kept() });
    expect(await c.settleUnresolvedCommitFromLog(G, 'Bw==')).toBe('cleared');
    expect(c.clearPendingCommit).toHaveBeenCalledTimes(1);
  });

  it('decides NOTHING when the log has no row at the base epoch yet', async () => {
    const c = ctx(submitting(), { state: kept() });
    expect(await c.settleUnresolvedCommitFromLog(G, null)).toBe('undecided');
    expect(c.mergePendingCommit).not.toHaveBeenCalled();
    expect(c.clearPendingCommit).not.toHaveBeenCalled();
  });

  it('decides NOTHING from an unreadable record, whatever the log holds', async () => {
    const c = ctx(submitting(), { state: new Map([[G, { status: 'unreadable' }]]) });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await c.settleUnresolvedCommitFromLog(G, 'Bw==')).toBe('undecided');
    expect(c.clearPendingCommit).not.toHaveBeenCalled();
    expect(isInEpochGap(G)).toBe(true);
    vi.mocked(console.error).mockRestore();
  });

  it('clears a staged commit that was never sent', async () => {
    const c = ctx(submitting(), { state: new Map([[G, { status: 'none' }]]) });
    expect(await c.settleUnresolvedCommitFromLog(G, null)).toBe('cleared');
  });
});

/** Only `sendMessage` and what it reaches; the two dozen other abstract members stay unstubbed. */
abstract class SendHarness extends BaseMlsService {
  readonly encrypted: string[] = [];
  private readonly pending: PendingState;
  constructor(submitCommit: ReturnType<typeof vi.fn>, state: PendingState) {
    super('web');
    this.pending = state;
    Object.assign(this as unknown as Record<string, unknown>, {
      userId: U,
      deviceId: D,
      delivery: { postApplicationMessage: async () => null, submitCommit },
      scheduleLeafRefresh: () => {},
      getEpoch: () => 5,
      ...primitives(state),
    });
  }
  /** As the platform does: the STATE refuses a group with a staged commit, whatever the index says. */
  protected async encryptForSend(groupId: string): Promise<AuthoredFrame> {
    if (this.pending.has(groupId)) throw new StagedCommitPendingError(groupId);
    this.encrypted.push(groupId);
    return { sealed: sealedFrame(5, groupId), authorProof: new Uint8Array([4]) };
  }
}
const Harness = SendHarness as unknown as new (
  s: ReturnType<typeof vi.fn>,
  state: PendingState
) => SendHarness;

describe('sendMessage - a group whose last commit is unresolved', () => {
  it('encrypts NOTHING while the resubmission still gets no answer', async () => {
    const svc = new Harness(submitting(lost()), kept());
    await expect(svc.sendMessage(G, new Uint8Array([9]))).rejects.toBeInstanceOf(
      CommitOutcomeUnknownError
    );
    expect(svc.encrypted).toEqual([]);
  });

  it('settles first, then sends at the epoch the answer decided', async () => {
    const state = kept();
    const svc = new Harness(submitting({ accepted: true, duplicate: true }), state);
    await svc.sendMessage(G, new Uint8Array([9]));
    expect(svc.encrypted).toEqual([G]);
    expect(state.size).toBe(0);
  });

  it('asks the state once, then sends without crossing to it again', async () => {
    const state: PendingState = new Map();
    const svc = new Harness(submitting(), state);
    await svc.sendMessage(G, new Uint8Array([9]));
    await svc.sendMessage(G, new Uint8Array([9]));
    const asked = (svc as unknown as { groupsWithPendingCommit: ReturnType<typeof vi.fn> })
      .groupsWithPendingCommit;
    expect(asked).toHaveBeenCalledTimes(1);
    expect(svc.encrypted).toEqual([G, G]);
  });

  it('settles and seals once more when the STATE refuses a send its index allowed (a reload swapped it)', async () => {
    const state: PendingState = new Map();
    const svc = new Harness(submitting({ accepted: true, duplicate: true }), state);
    await svc.sendMessage(G, new Uint8Array([9]));
    // A resume reload installs a state a background engine staged an Add in; the index says none.
    for (const [g, read] of kept()) state.set(g, read);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await svc.sendMessage(G, new Uint8Array([9]));
    warn.mockRestore();
    expect(svc.encrypted).toEqual([G, G]);
    expect(state.size).toBe(0);
  });

  it('answers an outcome still unknown, never a failed send, when that settle gets no answer', async () => {
    const state: PendingState = new Map();
    const svc = new Harness(submitting(lost()), state);
    await svc.sendMessage(G, new Uint8Array([9]));
    for (const [g, read] of kept()) state.set(g, read);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(svc.sendMessage(G, new Uint8Array([9]))).rejects.toBeInstanceOf(
      CommitOutcomeUnknownError
    );
    warn.mockRestore();
    expect(svc.encrypted).toEqual([G]);
    expect(state.has(G)).toBe(true);
  });
});

/**
 * A SUBMIT THAT NEVER ANSWERS MAY NOT HOLD THE MLS LOCK.
 *
 * Every commit is submitted inside the GLOBAL MLS lock, which guards every exclusive MLS section (and,
 * until DUP-6, the incoming processing of every group - the drain now borrows it while the request is
 * on the network). A POST hung on a half-open connection or a captive portal froze decryption in every
 * conversation for as long as the engine tolerated - and the periodic leaf refresh made an unasked
 * commit ordinary. The submission now lives under the `write` head deadline; its expiry is NO
 * ANSWER, so the stage is resubmitted, KEPT as unknown, and settled by a later resubmission.
 */
describe('runCommitTransaction - a commit gate that never answers', () => {
  afterEach(() => vi.useRealTimers());

  /** A `fetch` that never answers: it ends only when its signal aborts it. */
  const hanging = () =>
    vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          );
        })
    );

  it('releases the lock within two deadlines, lets another group proceed, and keeps the commit unknown for a resubmission', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = hanging();
    const api = new MlsDeliveryApi({
      historyUrl: 'https://example.test',
      getToken: async () => 'token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    api.userId = U;
    api.deviceId = D;
    const c = ctx(vi.fn());
    const scheduler = new MlsPerGroupScheduler('web');
    Object.assign(c, {
      delivery: api,
      unresolvedGroups: new Set<string>(),
      runUnderMlsLock: <T>(fn: () => Promise<T>) => scheduler.runUnderMlsLock(fn),
    });

    const commit = run(c).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // An EXCLUSIVE section waits for the whole commit - a drained frame of another group no longer
    // does, it borrows the mutex while the request is on the network
    // (`BaseMlsService.crossGroupDrain.test.ts`); what is pinned here is that the hold ENDS.
    let otherAt: number | null = null;
    const startedAt = Date.now();
    const other = scheduler.runUnderMlsLock(async () => {
      otherAt = Date.now();
    });

    // The body is far below the uplink allowance's first second, so each attempt is bounded by
    // the `write` deadline plus under one second.
    const bound = DEADLINE_MS.write + 1_000;
    await vi.advanceTimersByTimeAsync(bound);
    // The first request expired: no answer, so the SAME commit was resubmitted.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(bound);
    await other;

    const err = await commit;
    expect(err).toBeInstanceOf(CommitOutcomeUnknownError);
    // No answer, typed at the throw: the deadline's own error, which reads as a transport failure.
    expect((err as CommitOutcomeUnknownError).cause).toBeInstanceOf(RequestDeadlineError);
    expect(isTransportFailure((err as CommitOutcomeUnknownError).cause)).toBe(true);
    expect(otherAt).not.toBeNull();
    expect(otherAt! - startedAt).toBeLessThanOrEqual(2 * bound);
    // KEPT, never cleared: the gate may have accepted it.
    expect(c.clearPendingCommit).not.toHaveBeenCalled();
    expect(c.state.get(G)).toMatchObject({ status: 'recorded' });
    expect((c as unknown as { unresolvedGroups: Set<string> }).unresolvedGroups.has(G)).toBe(true);

    // The next resubmission decides it: the gate had taken it, and answers a duplicate.
    fetchImpl.mockImplementation(async () =>
      Response.json({ accepted: true, duplicate: true, newEpoch: 6 })
    );
    await c.settleUnresolvedCommits([G]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const bodies = fetchImpl.mock.calls.map(
      (call) => JSON.parse(String((call[1] as RequestInit).body)) as { proto: string }
    );
    expect(new Set(bodies.map((b) => b.proto))).toEqual(new Set([OURS]));
    expect(c.mergePendingCommit).toHaveBeenCalledTimes(1);
  });
});

/**
 * A KEPT INVITATION THAT DID NOT LAND IS RE-PLANNED, NEVER CLEARED AWAY (OFF-3, 1.4.1 campaign).
 * W1's Add of W5 was kept across an absence; W2 moved the group from 2 to 5; W1's return settled the
 * kept commit `epoch_mismatch`, cleared it and caught up - and nothing re-issued the Add or said so.
 * The invitation rides in the commit's intent; the settlement records it BEFORE the clear erases
 * that copy (`owedInvitations.ts`), and hands it to the re-planner once the lock is let go.
 */
describe('settleUnresolvedCommits - a kept invitation that did not land', () => {
  const INVITATION = { users: ['w5'], rostered: [] as string[] };
  const keptInvite = () =>
    kept(
      { excludeDeviceIds: ['w5:d-5'], keyPackageDevices: ['d-5'], invitation: INVITATION },
      { welcome: new Uint8Array([3]), addedIndices: [0] }
    );
  const keptWith = (invitation: { users: string[]; rostered: string[] }) =>
    kept(
      { excludeDeviceIds: ['w5:d-5'], keyPackageDevices: ['d-5'], invitation },
      { welcome: new Uint8Array([3]), addedIndices: [0] }
    );
  const raceLost = () => submitting({ accepted: false, reason: 'epoch_mismatch', currentEpoch: 5 });
  /** The drain runs on its own: wait for it the way the session would not. */
  const drained = async (c: ReturnType<typeof ctx>) => {
    while ((c as unknown as { owedInvitationDrain: Promise<void> | null }).owedInvitationDrain) {
      await (c as unknown as { owedInvitationDrain: Promise<void> }).owedInvitationDrain;
    }
  };
  const settled = async (c: ReturnType<typeof ctx>) => {
    await c.settleUnresolvedCommits();
    await drained(c);
  };
  const register = (
    c: ReturnType<typeof ctx>,
    replanner: (o: OwedInvitation) => Promise<ReplanVerdict>
  ) =>
    (c as unknown as { setOwedInvitationReplanner(r: unknown): void }).setOwedInvitationReplanner(
      replanner
    );

  it('records the invitation BEFORE the clear, then hands it to the re-planner once', async () => {
    const c = ctx(raceLost(), { state: keptInvite() });
    const atClear: OwedInvitation[][] = [];
    const clear = c.clearPendingCommit.getMockImplementation() as (g: string) => Promise<void>;
    c.clearPendingCommit.mockImplementation(async (g: string) => {
      atClear.push(listOwedInvitations(U));
      return clear(g);
    });
    const replanner = vi.fn(async (): Promise<ReplanVerdict> => 'concluded');
    register(c, replanner);
    await settled(c);
    expect(atClear).toEqual([
      [
        {
          groupId: G,
          baseEpoch: 5,
          invitation: INVITATION,
          cause: 'race',
          reason: 'epoch_mismatch',
        },
      ],
    ]);
    expect(c.catchUpOnRefusedCommit).toHaveBeenCalledWith(G, 5, 5);
    expect(replanner).toHaveBeenCalledExactlyOnceWith({
      groupId: G,
      baseEpoch: 5,
      invitation: INVITATION,
      cause: 'race',
      reason: 'epoch_mismatch',
    });
    expect(listOwedInvitations(U)).toEqual([]);
  });

  it('a refusal of the bytes themselves is recorded `refused` - told, never re-planned', async () => {
    const c = ctx(submitting(new ApiRefusalError(400, null, 'bad commit')), {
      state: keptInvite(),
    });
    const replanner = vi.fn(async (): Promise<ReplanVerdict> => 'concluded');
    register(c, replanner);
    await settled(c);
    expect(replanner).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ cause: 'refused', reason: 'http_400' })
    );
  });

  it('a commit refused whole for the people it admits is re-planned WITHOUT them, as a race', async () => {
    const c = ctx(
      submitting({ accepted: false, reason: 'admit_refused', currentEpoch: 5, userIds: ['w6'] }),
      { state: keptWith({ users: ['w5', 'w6'], rostered: ['w6'] }) }
    );
    const replanner = vi.fn(async (): Promise<ReplanVerdict> => 'concluded');
    register(c, replanner);
    await settled(c);
    expect(replanner).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        cause: 'race',
        reason: 'admit_refused',
        invitation: { users: ['w5'], rostered: [] },
      })
    );
  });

  it('a commit refused whole for EVERY person it admits is `refused` - told, never re-planned', async () => {
    const c = ctx(
      submitting({ accepted: false, reason: 'admit_refused', currentEpoch: 5, userIds: ['w5'] }),
      { state: keptInvite() }
    );
    const replanner = vi.fn(async (): Promise<ReplanVerdict> => 'concluded');
    register(c, replanner);
    await settled(c);
    expect(replanner).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ cause: 'refused', reason: 'admit_refused', invitation: INVITATION })
    );
  });

  it('a BUSINESS refusal in a 200 body is classified by its typed reason, never by its shape', async () => {
    // `committer_not_member` comes back as an ANSWER, like the race does: only the token tells them apart.
    const c = ctx(
      submitting({ accepted: false, reason: 'committer_not_member', currentEpoch: 5 }),
      {
        state: keptInvite(),
      }
    );
    const replanner = vi.fn(async (): Promise<ReplanVerdict> => 'concluded');
    register(c, replanner);
    await settled(c);
    expect(replanner).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ cause: 'refused', reason: 'committer_not_member' })
    );
  });

  it('a WAITING verdict keeps the entry, and the event that lifts the wait drains it again', async () => {
    const c = ctx(raceLost(), { state: keptInvite() });
    const replanner = vi
      .fn<(o: OwedInvitation) => Promise<ReplanVerdict>>()
      .mockResolvedValueOnce('waiting')
      .mockResolvedValueOnce('concluded');
    register(c, replanner);
    await settled(c);
    expect(replanner).toHaveBeenCalledTimes(1);
    expect(listOwedInvitations(U)).toHaveLength(1);
    // An event in ANOTHER conversation owes nothing here: no drain.
    (
      c as unknown as { replanOwedInvitationsIn(g: string, w: string): void }
    ).replanOwedInvitationsIn('another-group', 'conversation available');
    await drained(c);
    expect(replanner).toHaveBeenCalledTimes(1);
    (
      c as unknown as { replanOwedInvitationsIn(g: string, w: string): void }
    ).replanOwedInvitationsIn(G, 'conversation available');
    await drained(c);
    expect(replanner).toHaveBeenCalledTimes(2);
    expect(listOwedInvitations(U)).toEqual([]);
  });

  it('THE ADD LOCK IS NOT RE-ENTRANT: no drain while this device holds one, the release drains', async () => {
    const c = ctx(raceLost(), { state: keptInvite() });
    const replanner = vi.fn(async (): Promise<ReplanVerdict> => 'concluded');
    register(c, replanner);
    // A gesture of this device holds the group's add lock across the connection's settlement.
    expect(
      await (c as unknown as { acquireAddLock(g: string): Promise<boolean> }).acquireAddLock(G)
    ).toBe(true);
    await settled(c);
    expect(replanner).not.toHaveBeenCalled();
    expect(listOwedInvitations(U)).toHaveLength(1);
    await (c as unknown as { releaseAddLock(g: string): Promise<void> }).releaseAddLock(G);
    await drained(c);
    expect(replanner).toHaveBeenCalledTimes(1);
    expect(listOwedInvitations(U)).toEqual([]);
  });

  it('records nothing for a kept commit that carries no invitation (an automatic Add)', async () => {
    const c = ctx(raceLost(), { state: kept({ excludeDeviceIds: ['u-b:d-b'] }) });
    const replanner = vi.fn(async (): Promise<ReplanVerdict> => 'concluded');
    register(c, replanner);
    await settled(c);
    expect(c.clearPendingCommit).toHaveBeenCalledTimes(1);
    expect(replanner).not.toHaveBeenCalled();
    expect(listOwedInvitations(U)).toEqual([]);
  });

  it('a RELOAD between the refusal and the re-plan re-plans it ONCE, at the next connection', async () => {
    // The session that refused it ends before any re-planner ran: the entry is all that is left.
    const first = ctx(raceLost(), { state: keptInvite() });
    await settled(first);
    expect(first.state.size).toBe(0);
    expect(listOwedInvitations(U)).toHaveLength(1);

    // The reloaded session: no stage, the entry on disk; its connection settles twice.
    const second = ctx(submitting());
    const replanner = vi.fn(async (): Promise<ReplanVerdict> => 'concluded');
    register(second, replanner);
    await settled(second);
    await settled(second);
    expect(replanner).toHaveBeenCalledTimes(1);
    expect(listOwedInvitations(U)).toEqual([]);
  });

  it('a RELOAD before the clear reached disk settles the stage again: still ONE entry, one re-plan', async () => {
    const first = ctx(raceLost(), { state: keptInvite() });
    await settled(first);
    // The checkpoint never carried the clear: the reload holds the stage AND the entry.
    const second = ctx(raceLost(), { state: keptInvite() });
    const replanner = vi.fn(async (): Promise<ReplanVerdict> => 'concluded');
    register(second, replanner);
    await settled(second);
    expect(second.delivery.submitCommit).toHaveBeenCalledTimes(1);
    expect(replanner).toHaveBeenCalledTimes(1);
    expect(listOwedInvitations(U)).toEqual([]);
  });

  it('with no re-planner yet the entry WAITS, and registering one drains it', async () => {
    const c = ctx(raceLost(), { state: keptInvite() });
    await settled(c);
    expect(listOwedInvitations(U)).toHaveLength(1);
    const replanner = vi.fn(async (): Promise<ReplanVerdict> => 'concluded');
    register(c, replanner);
    while ((c as unknown as { owedInvitationDrain: Promise<void> | null }).owedInvitationDrain) {
      await (c as unknown as { owedInvitationDrain: Promise<void> }).owedInvitationDrain;
    }
    expect(replanner).toHaveBeenCalledTimes(1);
    expect(listOwedInvitations(U)).toEqual([]);
  });

  it('a kept invitation the LOG shows lost (another commit at its base) is recorded too', async () => {
    const c = ctx(submitting(), { state: keptInvite() });
    expect(await c.settleUnresolvedCommitFromLog(G, 'theirs')).toBe('cleared');
    expect(listOwedInvitations(U)).toEqual([
      { groupId: G, baseEpoch: 5, invitation: INVITATION, cause: 'race' },
    ]);
  });

  it('THE REAL LOCK: the re-plan, which takes the lock, runs AFTER the settlement lets it go', async () => {
    const c = ctx(raceLost(), { state: keptInvite() });
    const scheduler = new MlsPerGroupScheduler('web');
    (c as unknown as { runUnderMlsLock: unknown }).runUnderMlsLock = <T>(fn: () => Promise<T>) =>
      scheduler.runUnderMlsLock(fn);
    const order: string[] = [];
    c.catchUpOnRefusedCommit.mockImplementation(async () => {
      order.push('catch-up under the settlement lock');
    });
    register(c, async () => {
      await scheduler.runUnderMlsLock(async () => {
        order.push('re-plan under the lock');
      });
      return 'concluded';
    });
    await settled(c);
    expect(order).toEqual(['catch-up under the settlement lock', 're-plan under the lock']);
    expect(listOwedInvitations(U)).toEqual([]);
  });

  /**
   * The server's add lock as `add-lock.ts` keeps it: `SET NX` (its own holder refused too), one
   * value per acquisition (owner + token), a release that deletes the acquisition its token names -
   * or, with no token (a server that predates it), any acquisition of this device. A refusal says
   * how long the key has left. Its expiry is never simulated unless a case sets `value` itself.
   */
  function fakeLockServer(c: ReturnType<typeof ctx>, opts: { tokens?: boolean } = {}) {
    const tokens = opts.tokens ?? true;
    const OWNER = `${U}:${D}`;
    const server = {
      value: null as string | null,
      minted: 0,
      ttlMs: 30_000,
      /** `false` drops the next release on the floor: the server never hears it. */
      releaseAnswers: [] as boolean[],
      valueOf: (token: string | undefined) => `${OWNER}#${token ?? ''}`,
    };
    c.delivery.acquireAddLock = vi.fn(async () => {
      if (server.value !== null) {
        return { acquired: false, retryAfterMs: tokens ? server.ttlMs : undefined } as const;
      }
      const token = tokens ? `t${++server.minted}` : undefined;
      server.value = server.valueOf(token);
      return { acquired: true, token } as const;
    });
    c.delivery.releaseAddLock = vi.fn(async (_g: string, token: string | undefined) => {
      if (server.releaseAnswers.shift() === false) return false;
      const mine = token
        ? server.value === server.valueOf(token)
        : (server.value?.startsWith(`${OWNER}#`) ?? false);
      if (mine) server.value = null;
      return true;
    });
    return server;
  }
  const lockOf = (c: ReturnType<typeof ctx>) =>
    c as unknown as {
      acquireAddLock(g: string): Promise<boolean>;
      releaseAddLock(g: string): Promise<void>;
    };

  it('THE REAL LOCK AND A FAKE ADD LOCK: a release lost with the connection is sent before the drain acquires - no TTL waited', async () => {
    const c = ctx(raceLost(), { state: keptInvite() });
    const server = fakeLockServer(c);
    const scheduler = new MlsPerGroupScheduler('web');
    (c as unknown as { runUnderMlsLock: unknown }).runUnderMlsLock = <T>(fn: () => Promise<T>) =>
      scheduler.runUnderMlsLock(fn);
    const lock = lockOf(c);
    // The cut Add: taken, then released into a dead connection - the server still holds it.
    server.releaseAnswers.push(false);
    expect(await lock.acquireAddLock(G)).toBe(true);
    await lock.releaseAddLock(G);
    expect(server.value).toBe(server.valueOf('t1'));

    // Back within the TTL: the kept Add is refused, the drain re-plans - and its acquire succeeds.
    const replanner = vi.fn(async (): Promise<ReplanVerdict> => {
      if (!(await lock.acquireAddLock(G))) return 'waiting';
      await scheduler.runUnderMlsLock(async () => {});
      await lock.releaseAddLock(G);
      return 'concluded';
    });
    register(c, replanner);
    await settled(c);
    expect(replanner).toHaveBeenCalledTimes(1);
    expect(listOwedInvitations(U)).toEqual([]);
    expect(server.value).toBeNull();
  });

  it('TWO ACQUIRES RACING WITH A RELEASE OWED never free a live lock: one sends it, one lock stands', async () => {
    const c = ctx(submitting());
    const server = fakeLockServer(c);
    const lock = lockOf(c);
    server.releaseAnswers.push(false);
    await lock.acquireAddLock(G);
    await lock.releaseAddLock(G); // lost: t1 is still up, and owed

    const [a, b] = await Promise.all([lock.acquireAddLock(G), lock.acquireAddLock(G)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    // The owed release went ONCE (claimed), and it freed t1 alone: the winner's lock stands.
    expect(c.delivery.releaseAddLock).toHaveBeenCalledTimes(2);
    expect(server.value).toBe(server.valueOf('t2'));

    // A late release of an older acquisition - the stale token - frees nothing.
    await c.delivery.releaseAddLock(G, 't1');
    expect(server.value).toBe(server.valueOf('t2'));
  });

  it('a RELOAD: the durable marker of a page that died mid-Add sends its release before the next acquire', async () => {
    const dead = ctx(submitting());
    const server = fakeLockServer(dead);
    expect(await lockOf(dead).acquireAddLock(G)).toBe(true); // ...and the page dies holding it.

    const reloaded = ctx(submitting());
    reloaded.delivery.acquireAddLock = dead.delivery.acquireAddLock;
    reloaded.delivery.releaseAddLock = dead.delivery.releaseAddLock;
    expect(await lockOf(reloaded).acquireAddLock(G)).toBe(true);
    // Said OWED, so the server line tells it from a slow Add's TTL running out under it.
    expect(reloaded.delivery.releaseAddLock).toHaveBeenCalledWith(G, 't1', { owed: true });
    expect(server.value).toBe(server.valueOf('t2'));

    // The ordinary release of the lock it holds is NOT owed.
    await lockOf(reloaded).releaseAddLock(G);
    expect(vi.mocked(reloaded.delivery.releaseAddLock).mock.calls.at(-1)).toEqual([G, 't2']);
  });

  it('a server with NO token: the release is the legacy owner-only one, and it still frees the lock', async () => {
    const c = ctx(submitting());
    const server = fakeLockServer(c, { tokens: false });
    expect(await lockOf(c).acquireAddLock(G)).toBe(true);
    await lockOf(c).releaseAddLock(G);
    expect(c.delivery.releaseAddLock).toHaveBeenCalledWith(G, undefined);
    expect(server.value).toBeNull();
  });

  it("ANOTHER DEVICE'S LOCK: the refusal wakes the drain when the SERVER says the lock ends", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const c = ctx(raceLost(), { state: keptInvite() });
      const server = fakeLockServer(c);
      server.value = `${U}:other-device#theirs`;
      server.ttlMs = 7_000;
      const replanner = vi.fn(async (): Promise<ReplanVerdict> => {
        if (!(await lockOf(c).acquireAddLock(G))) return 'waiting';
        await lockOf(c).releaseAddLock(G);
        return 'concluded';
      });
      register(c, replanner);
      await settled(c);
      expect(replanner).toHaveBeenCalledTimes(1);
      expect(listOwedInvitations(U)).toHaveLength(1);

      // Their Add ends - its release sends no frame - and the server-stated moment comes.
      server.value = null;
      await vi.advanceTimersByTimeAsync(6_999);
      expect(replanner).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await drained(c);
      expect(replanner).toHaveBeenCalledTimes(2);
      expect(listOwedInvitations(U)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  /** A refusal stating `stated` ms on a group that owes an invitation; returns the re-planner. */
  async function refusedWith(c: ReturnType<typeof ctx>, stated: number | undefined) {
    fakeLockServer(c);
    // Refused once with that statement; the holder's lock is gone by the next acquire.
    c.delivery.acquireAddLock = vi
      .fn()
      .mockResolvedValueOnce({ acquired: false, retryAfterMs: stated })
      .mockResolvedValue({ acquired: true, token: 'mine' });
    const replanner = vi.fn(async (): Promise<ReplanVerdict> => {
      if (!(await lockOf(c).acquireAddLock(G))) return 'waiting';
      return 'concluded';
    });
    register(c, replanner);
    await settled(c);
    expect(replanner).toHaveBeenCalledTimes(1);
    return replanner;
  }

  it('a DESTROYED client keeps no wake: the server-stated moment comes and nothing re-plans', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const c = ctx(raceLost(), { state: keptInvite() });
      const replanner = await refusedWith(c, 7_000);
      // The teardown's other seams are not what this case is about.
      Object.assign(c, {
        pauseSocket: vi.fn(),
        wakeKeyPackageRoundWaiters: vi.fn(),
        abandonGroupDrainedWaiters: vi.fn(),
        destroyPlatformResources: vi.fn(),
        heartbeatTimer: null,
        heldFrames: [],
      });
      (proto.destroy as (this: unknown) => void).call(c);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(replanner).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['a negative wait', -5, 0],
    ['a HUGE wait (above 2^31-1, which setTimeout fires at once)', 2 ** 40, ADD_LOCK_WAIT_BOUND_MS],
  ])('a refusal stating %s is bounded to 0..TTL+1 s', async (_name, stated, fireAt) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const c = ctx(raceLost(), { state: keptInvite() });
      const replanner = await refusedWith(c, stated);
      if (fireAt > 0) {
        await vi.advanceTimersByTimeAsync(fireAt - 1);
        expect(replanner).toHaveBeenCalledTimes(1);
      }
      await vi.advanceTimersByTimeAsync(1);
      await drained(c);
      expect(replanner).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('is outside 0..'));
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('a refusal stating NaN is NO stated end: no wake, and said so', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const c = ctx(raceLost(), { state: keptInvite() });
      const replanner = await refusedWith(c, Number.NaN);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(replanner).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('read as undefined'));
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('a SIGN-OUT during the drain stops it: the next entry is neither re-planned nor dropped', async () => {
    const c = ctx(submitting());
    const other = { ...INVITATION, users: ['w6'] };
    const { recordOwedInvitation } = await import('$lib/mls-client/owedInvitations');
    recordOwedInvitation(U, { groupId: G, baseEpoch: 5, invitation: INVITATION, cause: 'race' });
    recordOwedInvitation(U, { groupId: G, baseEpoch: 7, invitation: other, cause: 'race' });
    const replanner = vi.fn(async (): Promise<ReplanVerdict> => {
      // The member signs out while the first re-plan runs.
      (c as unknown as { setOwedInvitationReplanner(r: null): void }).setOwedInvitationReplanner(
        null
      );
      return 'concluded';
    });
    register(c, replanner);
    await settled(c);
    expect(replanner).toHaveBeenCalledTimes(1);
    expect(listOwedInvitations(U)).toEqual([
      { groupId: G, baseEpoch: 7, invitation: other, cause: 'race' },
    ]);
  });

  it('a record that cannot be WRITTEN never blocks the group: the stage is cleared, the loss said and told BY NAME', async () => {
    const c = ctx(raceLost(), { state: keptInvite() });
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await settled(c);
    setItem.mockRestore();
    expect(c.clearPendingCommit).toHaveBeenCalledTimes(1);
    expect(c.state.size).toBe(0);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('could NOT be recorded'));
    expect(listOwedInvitations(U)).toEqual([]);
    error.mockRestore();

    // No teller yet (the conversations not restored): told once one is, by the conversation's name.
    const tell = vi.fn();
    (
      c as unknown as { setOwedInvitationReplanner(r: unknown, t: unknown): void }
    ).setOwedInvitationReplanner(async () => 'concluded', tell);
    expect(tell).toHaveBeenCalledExactlyOnceWith(G);
  });
});

describe("runCommitTransaction - an accepted Add's Welcome is owed in the state, not in the caller's hands", () => {
  /** The page reloads: a new session over the same state - nothing in memory survives. */
  const reloaded = (c: ReturnType<typeof ctx>, submit = submitting()) =>
    ctx(submit, { state: c.state, owed: c.owed });
  const addOf = (c: ReturnType<typeof ctx>) =>
    c.runCommitTransaction(G, stagerOf(c, { welcome: new Uint8Array([3]) }), {
      excludeDeviceIds: ['u-b:d-b'],
      exportTree: true,
    }) as Promise<{ welcome?: Uint8Array; ratchetTree?: Uint8Array }>;
  const callerSends = (
    c: ReturnType<typeof ctx>,
    r: { welcome?: Uint8Array; ratchetTree?: Uint8Array }
  ) =>
    (c as unknown as { sendWelcome: (...a: unknown[]) => Promise<void> }).sendWelcome(
      r.welcome,
      'u-b',
      G,
      'd-b',
      r.ratchetTree
    );

  it('DUP-7: accepted only through the duplicate answer, its Welcome send failed, then a reload - the next connection delivers it', async () => {
    const c = ctx(submitting(lost(), { accepted: true, duplicate: true }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await addOf(c);
    expect(c.mergePendingCommitOwingWelcome).toHaveBeenCalledExactlyOnceWith(G, ['u-b:d-b']);
    c.delivery.sendWelcome.mockRejectedValueOnce(lost());
    await expect(callerSends(c, result)).rejects.toBeInstanceOf(TransportFailureError);
    warn.mockRestore();

    const after = reloaded(c);
    await after.settleUnresolvedCommits();
    expect(after.delivery.submitCommit).not.toHaveBeenCalled();
    expect(after.delivery.sendWelcome.mock.calls).toEqual([
      [new Uint8Array([3]), 'u-b', G, 'd-b', new Uint8Array([7])],
    ]);
    expect(after.owed.size).toBe(0);
  });

  it('a Welcome the caller delivered is owed no longer: the next connection sends nothing', async () => {
    const c = ctx(submitting({ accepted: true }));
    const result = await addOf(c);
    await callerSends(c, result);
    expect(c.owed.size).toBe(0);
    const after = reloaded(c);
    await after.settleUnresolvedCommits();
    expect(after.delivery.sendWelcome).not.toHaveBeenCalled();
  });

  it('a Welcome refused WELCOME_TARGET_NOT_MEMBER on the caller is owed no longer either', async () => {
    const c = ctx(submitting({ accepted: true }));
    const result = await addOf(c);
    c.delivery.sendWelcome.mockRejectedValueOnce(new WelcomeTargetNotMemberError(G, 'u-b', 'd-b'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(callerSends(c, result)).rejects.toBeInstanceOf(WelcomeTargetNotMemberError);
    error.mockRestore();
    expect(c.owed.size).toBe(0);
  });

  /**
   * DEV-3 (2026-10-25): a device its owner revoked while this Add was in flight. The gate accepts the
   * commit, drops the admit (`no_key_package`) and SAYS SO in its answer; the Welcome used to be sent
   * anyway, answered 500, and stay owed for every later connection.
   */
  it('a device the gate did not admit for want of a key package is owed NO Welcome, and the transaction says so', async () => {
    const refused = { userId: 'u-b', deviceId: 'd-b', reason: 'no_key_package' };
    const c = ctx(submitting({ accepted: true, refusedAdmits: [refused] }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = (await addOf(c)) as { notAdmitted: RefusedAdmit[] };

    expect(result.notAdmitted).toEqual([refused]);
    // Merged - the commit landed - but owing nothing.
    expect(c.mergePendingCommitOwingWelcome).not.toHaveBeenCalled();
    expect(c.mergePendingCommit).toHaveBeenCalledExactlyOnceWith(G);
    expect(c.owed.size).toBe(0);
    expect(log.mock.calls.flat().join('\n')).toContain('NOT admitted by the gate (no_key_package');
    log.mockRestore();
    // And no later connection sends it either.
    const after = reloaded(c);
    await after.settleUnresolvedCommits();
    expect(after.delivery.sendWelcome).not.toHaveBeenCalled();
  });

  it('a refusal a Welcome is not barred by (`already_active`) still owes it, said once at debug', async () => {
    const c = ctx(
      submitting({
        accepted: true,
        refusedAdmits: [{ userId: 'u-b', deviceId: 'd-b', reason: 'already_active' }],
      })
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});

    const result = (await addOf(c)) as { notAdmitted: RefusedAdmit[] };

    expect(result.notAdmitted).toEqual([]);
    // An ordinary answer to a re-Add: never at log level, where it would print on every such commit.
    expect(log.mock.calls.flat().join(' | ')).not.toContain('did not record the admit');
    expect(c.mergePendingCommitOwingWelcome).toHaveBeenCalledExactlyOnceWith(G, ['u-b:d-b']);
    expect(debug.mock.calls.flat().join(' | ')).toContain(
      'did not record the admit of u-b:d-b (already_active) - its Welcome is sent and answered as before'
    );
    log.mockRestore();
    debug.mockRestore();
  });

  it('a Welcome refused WELCOME_TARGET_UNKNOWN - the answer that named it was lost - is owed no longer', async () => {
    // Accepted only through the duplicate answer, which names no refused admit.
    const c = ctx(submitting(lost(), { accepted: true, duplicate: true }));
    const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await addOf(c);
    expect(c.mergePendingCommitOwingWelcome).toHaveBeenCalledExactlyOnceWith(G, ['u-b:d-b']);
    c.delivery.sendWelcome.mockRejectedValueOnce(new WelcomeTargetUnknownError(G, 'u-b', 'd-b'));

    await expect(callerSends(c, result)).rejects.toBeInstanceOf(WelcomeTargetUnknownError);

    expect(c.owed.size).toBe(0);
    expect(quiet.mock.calls.flat().join('\n')).toContain('no device is registered under it');
    quiet.mockRestore();
  });

  it('the connection drain stops owing a Welcome refused WELCOME_TARGET_UNKNOWN, without an error line', async () => {
    const owed: OwedState = new Map([
      [
        G,
        [
          {
            groupId: G,
            welcome: new Uint8Array([3]),
            ratchetTree: new Uint8Array([7]),
            recipients: ['u-b:d-b'],
          },
        ],
      ],
    ]);
    const c = ctx(submitting(), { owed });
    c.delivery.sendWelcome.mockRejectedValueOnce(new WelcomeTargetUnknownError(G, 'u-b', 'd-b'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await c.settleUnresolvedCommits();

    expect(owed.size).toBe(0);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
    warn.mockRestore();
  });

  it('sends the Welcome ONCE when the connection drain meets the caller sending it', async () => {
    const c = ctx(submitting({ accepted: true }));
    const result = await addOf(c);
    let answer!: () => void;
    c.delivery.sendWelcome.mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          answer = r;
        })
    );
    const caller = callerSends(c, result);
    const drain = c.settleUnresolvedCommits();
    await vi.waitFor(() => expect(c.owedWelcomes).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    answer();
    await Promise.all([caller, drain]);
    expect(c.delivery.sendWelcome).toHaveBeenCalledTimes(1);
    expect(c.owed.size).toBe(0);
  });

  it.each([
    ['delivered', undefined],
    ['refused for good', new WelcomeTargetNotMemberError(G, 'u-b', 'd-b')],
  ] as const)(
    'an older Welcome %s AFTER a re-admission merged a newer one never clears the newer one',
    async (_n, refusal) => {
      const c = ctx(submitting({ accepted: true }, { accepted: true }));
      const first = await addOf(c);
      let answer!: (e?: Error) => void;
      c.delivery.sendWelcome.mockImplementationOnce(
        () =>
          new Promise<void>((resolve, reject) => {
            answer = (e) => (e ? reject(e) : resolve());
          })
      );
      const w1 = callerSends(c, first);
      // The same device admitted again while W1 is in flight: W2 owed, W1's entry superseded.
      await c.runCommitTransaction(G, stagerOf(c, { welcome: new Uint8Array([4]) }), {
        excludeDeviceIds: ['u-b:d-b'],
        exportTree: true,
      });
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      answer(refusal);
      if (refusal) await expect(w1).rejects.toBe(refusal);
      else await w1;
      error.mockRestore();
      expect(c.owed.get(G)).toEqual([
        expect.objectContaining({ welcome: new Uint8Array([4]), recipients: ['u-b:d-b'] }),
      ]);
    }
  );

  it('a consumed Welcome is handed to the next checkpoint', async () => {
    const c = ctx(submitting({ accepted: true }));
    const result = await addOf(c);
    scheduleOutboundMlsPersist.mockClear();
    await callerSends(c, result);
    expect(c.owed.size).toBe(0);
    expect(scheduleOutboundMlsPersist).toHaveBeenCalledTimes(1);
  });

  it('the connection drain schedules ONE persist for a whole pass, however many it clears', async () => {
    const owed: OwedState = new Map([
      [
        G,
        [
          {
            groupId: G,
            welcome: new Uint8Array([3]),
            ratchetTree: new Uint8Array([7]),
            recipients: ['u-b:d-b1', 'u-b:d-b2', 'u-c:d-c'],
          },
        ],
      ],
    ]);
    const c = ctx(submitting(), { owed });
    c.delivery.sendWelcome.mockRejectedValueOnce(new WelcomeTargetNotMemberError(G, 'u-b', 'd-b1'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    scheduleOutboundMlsPersist.mockClear();
    await c.settleUnresolvedCommits();
    error.mockRestore();
    expect(c.delivery.sendWelcome).toHaveBeenCalledTimes(3);
    expect(owed.size).toBe(0);
    expect(scheduleOutboundMlsPersist).toHaveBeenCalledTimes(1);
  });

  it('drops an owed recipient that names no device WITHOUT claiming a server refusal', async () => {
    const owed: OwedState = new Map([
      [
        G,
        [
          {
            groupId: G,
            welcome: new Uint8Array([3]),
            ratchetTree: new Uint8Array([7]),
            recipients: ['not-a-device'],
          },
        ],
      ],
    ]);
    const c = ctx(submitting(), { owed });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    scheduleOutboundMlsPersist.mockClear();
    await c.settleUnresolvedCommits();
    const lines = error.mock.calls.map(([l]) => String(l));
    error.mockRestore();
    expect(c.delivery.sendWelcome).not.toHaveBeenCalled();
    expect(owed.size).toBe(0);
    expect(lines.some((l) => l.includes('names no device'))).toBe(true);
    expect(lines.some((l) => l.includes('REFUSED'))).toBe(false);
    expect(scheduleOutboundMlsPersist).toHaveBeenCalledTimes(1);
  });

  it('merges a commit that admits nobody plainly - it owes no Welcome', async () => {
    const c = ctx(submitting({ accepted: true }));
    await run(c);
    expect(c.mergePendingCommit).toHaveBeenCalledTimes(1);
    expect(c.mergePendingCommitOwingWelcome).not.toHaveBeenCalled();
    expect(c.owed.size).toBe(0);
  });
});
