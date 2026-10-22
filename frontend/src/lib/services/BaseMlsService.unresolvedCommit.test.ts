// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/TauriMlsService', () => ({ TauriMlsService: class {} }));
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));
const persistMlsStructuralCheckpoint = vi.hoisted(() => vi.fn());
vi.mock('$lib/mls-client/mlsStatePersisterRegistry', () => ({
  persistMlsStructuralCheckpoint: (...a: unknown[]) => persistMlsStructuralCheckpoint(...a),
  scheduleOutboundMlsPersist: vi.fn(),
}));

import { BaseMlsService } from './BaseMlsService';
import { CommitRefusedError } from '$lib/mls-client/CommitRefusedError';
import {
  CommitOutcomeUnknownError,
  decodeSubmission,
  encodeSubmission,
  type CommitSubmission,
} from '$lib/mls-client/commitSubmission';
import { readLeafRefreshLedger } from '$lib/mls-client/leafRefresh';
import { ApiRefusalError } from '$lib/utils/apiRefusalError';
import { TransportFailureError, isTransportFailure } from '$lib/utils/transportFailure';

/**
 * A SUBMISSION WHOSE ANSWER WAS LOST IS RESUBMITTED, NEVER GUESSED - AND IT IS KEPT IN THE MLS STATE.
 *
 * Reading the server's log after a lost answer cannot tell "not landed yet" from "never landed": a
 * clear decided from an empty log races the request still in flight. So the SAME bytes are sent
 * again, the gate answers a duplicate of an accepted commit as accepted, and an outcome that stays
 * unknown is KEPT - beside the staged commit, in the same state, recorded before the first request,
 * so the two can never disagree on disk. A staged commit with no submission was therefore never
 * sent. These cases pin each verdict and each place a resubmission is owed.
 *
 * The platform's staged commit and its submission are modelled by `state`, with the crate's rules
 * (`mls-core/tests/pending_submission.rs` pins them): a stage starts a commit with no submission,
 * a merge or a clear ends both.
 */

const U = 'user-a';
const D = 'web-a';
const G = 'g-1';
const OURS = 'AQ=='; // base64 of the staged commit [1]
const BASE = 'Ag=='; // base64 of the staged groupInfo [2]

const proto = BaseMlsService.prototype as unknown as Record<string, unknown>;

type Answer = { accepted: boolean; reason?: string; currentEpoch?: number; duplicate?: boolean };
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

/** group id -> its staged commit's submission (`null`: staged, never submitted). */
type PendingState = Map<string, Uint8Array | null>;

function primitives(state: PendingState, order: string[]) {
  return {
    recordPendingSubmission: vi.fn(async (g: string, s: Uint8Array) => {
      order.push('record');
      if (!state.has(g)) throw new Error('InvalidData: no staged commit');
      state.set(g, s);
    }),
    pendingSubmission: vi.fn(async (g: string) => state.get(g) ?? null),
    groupsWithPendingCommit: vi.fn(async () => [...state.keys()]),
    mergePendingCommit: vi.fn(async (g: string) => {
      state.delete(g);
    }),
    clearPendingCommit: vi.fn(async (g: string) => {
      state.delete(g);
    }),
  };
}

function ctx(submitCommit: ReturnType<typeof vi.fn>, opts: { state?: PendingState } = {}) {
  const state: PendingState = opts.state ?? new Map();
  const order: string[] = [];
  const submit = vi.fn(async (...args: unknown[]) => {
    order.push('submit');
    return (submitCommit as (...a: unknown[]) => unknown)(...args);
  });
  const c: Record<string, unknown> = {
    userId: U,
    deviceId: D,
    state,
    order,
    delivery: { submitCommit: submit },
    runUnderMlsLock: <T>(fn: () => Promise<T>) => fn(),
    freshEpoch: vi.fn().mockResolvedValue(5),
    getEpoch: vi.fn(() => 5),
    exportRatchetTree: vi.fn().mockResolvedValue(new Uint8Array([7])),
    sendWelcome: vi.fn().mockResolvedValue(undefined),
    catchUpOnRefusedCommit: vi.fn().mockResolvedValue(undefined),
    unresolvedGroups: null,
    ...primitives(state, order),
  };
  // The real seams under test: what they decide from the gate's answers is what these cases are about.
  for (const name of [
    'runCommitTransaction',
    'settleUnresolvedLocked',
    'submitRecorded',
    'resubmitUnresolved',
    'awaitCommitCheckpoint',
    'mergeSettled',
    'knownUnresolvedGroups',
    'settleUnresolvedCommits',
    'settleUnresolvedCommitFromLog',
  ]) {
    c[name] = proto[name];
  }
  return c as unknown as Record<string, ReturnType<typeof vi.fn>> & {
    state: PendingState;
    order: string[];
    delivery: { submitCommit: ReturnType<typeof vi.fn> };
    runCommitTransaction(
      g: string,
      stage: () => Promise<unknown>,
      opts?: Record<string, unknown>
    ): Promise<unknown>;
    settleUnresolvedCommits(groupIds?: string[]): Promise<void>;
    settleUnresolvedCommitFromLog(g: string, atBase: string | null): Promise<string>;
  };
}

/** A stage as the crate does it: the group now holds a staged commit with no submission. */
function stagerOf(c: ReturnType<typeof ctx>) {
  return vi.fn(async () => {
    c.state.set(G, null);
    return { commit: new Uint8Array([1]), groupInfo: new Uint8Array([2]) };
  });
}

const run = (c: ReturnType<typeof ctx>, stage = stagerOf(c)) =>
  c.runCommitTransaction(G, stage, { removes: [{ userId: 'user-z' }] });

function submission(over: Partial<CommitSubmission> = {}): CommitSubmission {
  return { groupId: G, baseEpoch: 5, commit: OURS, groupInfo: BASE, ...over };
}

/** A group whose state holds a staged commit and the submission kept beside it. */
function kept(over: Partial<CommitSubmission> = {}): PendingState {
  return new Map([[G, encodeSubmission(submission(over))]]);
}

beforeEach(() => {
  localStorage.clear();
  persistMlsStructuralCheckpoint.mockReset().mockResolvedValue(true);
});

describe('runCommitTransaction - a submission that got no answer', () => {
  it('keeps the submission beside the staged commit BEFORE the first request', async () => {
    const c = ctx(submitting({ accepted: true }));
    await run(c);
    expect(c.order).toEqual(['record', 'submit']);
    const recorded = c.recordPendingSubmission.mock.calls[0][1] as Uint8Array;
    expect(decodeSubmission(recorded)).toEqual(submission({ removes: [{ userId: 'user-z' }] }));
  });

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

  it('clears, catches up and refuses when another commit took the epoch', async () => {
    const c = ctx(
      submitting(lost(), { accepted: false, reason: 'epoch_mismatch', currentEpoch: 6 })
    );
    await expect(run(c)).rejects.toBeInstanceOf(CommitRefusedError);
    expect(c.clearPendingCommit).toHaveBeenCalledTimes(1);
    expect(c.catchUpOnRefusedCommit).toHaveBeenCalledWith(G, 5, 6);
    expect(c.mergePendingCommit).not.toHaveBeenCalled();
    expect(c.state.size).toBe(0);
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
  ] as Array<[string, Step]>)(
    'KEEPS the staged commit and its submission, and checkpoints them, after %s',
    async (_name, second) => {
      const c = ctx(submitting(lost(), second));
      const err = await run(c).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CommitOutcomeUnknownError);
      // Read by every caller as "no answer": retried when the server answers, never final.
      expect(isTransportFailure(err)).toBe(true);
      expect(c.clearPendingCommit).not.toHaveBeenCalled();
      expect(c.mergePendingCommit).not.toHaveBeenCalled();
      expect(decodeSubmission(c.state.get(G)!)).toMatchObject({ baseEpoch: 5, commit: OURS });
      expect(persistMlsStructuralCheckpoint).toHaveBeenCalledTimes(1);
    }
  );

  it('sends nothing and clears when the submission cannot be kept beside the commit', async () => {
    const c = ctx(submitting());
    c.recordPendingSubmission.mockRejectedValueOnce(new Error('state unavailable'));
    await expect(run(c)).rejects.toThrow('state unavailable');
    expect(c.delivery.submitCommit).not.toHaveBeenCalled();
    expect(c.clearPendingCommit).toHaveBeenCalledTimes(1);
  });

  it('delivers nothing itself when the Add is accepted at once - its caller sends the Welcome', async () => {
    const c = ctx(submitting(lost(), { accepted: true }));
    const stage = vi.fn(async () => {
      c.state.set(G, null);
      return {
        commit: new Uint8Array([1]),
        groupInfo: new Uint8Array([2]),
        welcome: new Uint8Array([3]),
      };
    });
    const out = (await c.runCommitTransaction(G, stage, {
      excludeDeviceIds: ['user-b:dev-b'],
    })) as { welcome?: Uint8Array };
    expect(out.welcome).toEqual(new Uint8Array([3]));
    expect(c.sendWelcome).not.toHaveBeenCalled();
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
});

describe('settleUnresolvedCommits - the resubmission at the next connection', () => {
  it('merges on a duplicate answer, from the submission kept in the state, and checkpoints', async () => {
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
      undefined,
      undefined
    );
    expect(c.mergePendingCommit).toHaveBeenCalledTimes(1);
    expect(c.state.size).toBe(0);
    expect(persistMlsStructuralCheckpoint).toHaveBeenCalledTimes(1);
  });

  it("delivers an Add's Welcome to every device it admits - nobody else is left to send it", async () => {
    const c = ctx(submitting({ accepted: true, duplicate: true }), {
      state: kept({
        welcome: 'Aw==',
        admits: [
          { userId: 'u-b', deviceId: 'd-b1' },
          { userId: 'u-b', deviceId: 'd-b2' },
        ],
      }),
    });
    await c.settleUnresolvedCommits();
    // AFTER the merge: the tree the joiner needs is the one of the epoch the Add created.
    expect(c.exportRatchetTree.mock.invocationCallOrder[0]).toBeGreaterThan(
      c.mergePendingCommit.mock.invocationCallOrder[0]
    );
    expect(c.sendWelcome.mock.calls).toEqual([
      [new Uint8Array([3]), 'u-b', G, 'd-b1', new Uint8Array([7])],
      [new Uint8Array([3]), 'u-b', G, 'd-b2', new Uint8Array([7])],
    ]);
  });

  it('delivers no Welcome when the kept Add is refused', async () => {
    const c = ctx(submitting({ accepted: false, reason: 'epoch_mismatch', currentEpoch: 7 }), {
      state: kept({ welcome: 'Aw==', admits: [{ userId: 'u-b', deviceId: 'd-b' }] }),
    });
    await c.settleUnresolvedCommits();
    expect(c.clearPendingCommit).toHaveBeenCalledTimes(1);
    expect(c.catchUpOnRefusedCommit).toHaveBeenCalledWith(G, 5, 7);
    expect(c.sendWelcome).not.toHaveBeenCalled();
    expect(c.state.size).toBe(0);
  });

  it('keeps both when the resubmission gets no answer either', async () => {
    const c = ctx(submitting(lost()), { state: kept() });
    await c.settleUnresolvedCommits();
    expect(c.clearPendingCommit).not.toHaveBeenCalled();
    expect(c.mergePendingCommit).not.toHaveBeenCalled();
    expect(c.state.has(G)).toBe(true);
  });

  it('clears, with no request, a staged commit that has no submission - it was never sent', async () => {
    // The crash this answers: the checkpoint landed after the stage and before the submission was
    // kept, which happens before the first request - so the reloaded state holds a commit that
    // never left the device.
    const c = ctx(submitting(), { state: new Map([[G, null]]) });
    await c.settleUnresolvedCommits();
    expect(c.delivery.submitCommit).not.toHaveBeenCalled();
    expect(c.clearPendingCommit).toHaveBeenCalledTimes(1);
    expect(c.state.size).toBe(0);
  });
});

describe('settleUnresolvedCommitFromLog - the log decided at the base epoch', () => {
  it("merges when the row at the base epoch is OUR commit, and delivers an Add's Welcome", async () => {
    const c = ctx(submitting(), {
      state: kept({ welcome: 'Aw==', admits: [{ userId: 'u-b', deviceId: 'd-b' }] }),
    });
    expect(await c.settleUnresolvedCommitFromLog(G, OURS)).toBe('merged');
    expect(c.mergePendingCommit).toHaveBeenCalledTimes(1);
    expect(c.sendWelcome).toHaveBeenCalledTimes(1);
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

  it('clears a staged commit that was never sent', async () => {
    const c = ctx(submitting(), { state: new Map([[G, null]]) });
    expect(await c.settleUnresolvedCommitFromLog(G, null)).toBe('cleared');
  });
});

/** Only `sendMessage` and what it reaches; the two dozen other abstract members stay unstubbed. */
abstract class SendHarness extends BaseMlsService {
  readonly encrypted: string[] = [];
  constructor(submitCommit: ReturnType<typeof vi.fn>, state: PendingState) {
    super('web');
    Object.assign(this as unknown as Record<string, unknown>, {
      userId: U,
      deviceId: D,
      delivery: { postApplicationMessage: async () => null, submitCommit },
      scheduleLeafRefresh: () => {},
      getEpoch: () => 5,
      ...primitives(state, []),
    });
  }
  protected async encryptForSend(groupId: string): Promise<Uint8Array> {
    this.encrypted.push(groupId);
    return new Uint8Array([1]);
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
});
