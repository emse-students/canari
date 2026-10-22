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
  encodeIntent,
  type CommitIntent,
  type OwedWelcome,
  type PendingSubmissionRead,
  type StagedRecord,
} from '$lib/mls-client/commitSubmission';
import { readLeafRefreshLedger } from '$lib/mls-client/leafRefresh';
import { ApiRefusalError } from '$lib/utils/apiRefusalError';
import { clearEpochGap, isInEpochGap } from '$lib/utils/chat/epochGapRegistry';
import { TransportFailureError, isTransportFailure } from '$lib/utils/transportFailure';

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

/** group id -> the Welcome a settled Add still owes (`mls-core/src/owed_welcome.rs`). */
type OwedState = Map<string, OwedWelcome>;

function primitives(state: PendingState, owed: OwedState = new Map()) {
  return {
    owed,
    mergePendingCommitOwingWelcome: vi.fn(async (g: string, recipients: string[]) => {
      const read = state.get(g);
      if (read?.status !== 'recorded' || !read.record.welcome) throw new Error('InvalidData');
      owed.set(g, {
        groupId: g,
        welcome: read.record.welcome,
        ratchetTree: new Uint8Array([7]),
        recipients,
      });
      state.delete(g);
    }),
    owedWelcomes: vi.fn(async () => [...owed.values()].map((w) => ({ ...w }))),
    welcomeDelivered: vi.fn(async (g: string, r: string) => {
      const w = owed.get(g);
      if (!w) return;
      w.recipients = w.recipients.filter((x) => x !== r);
      if (w.recipients.length === 0) owed.delete(g);
    }),
    pendingSubmission: vi.fn(async (g: string) => state.get(g) ?? { status: 'none' }),
    groupsWithPendingCommit: vi.fn(async () => [...state.keys()]),
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
    delivery: { submitCommit },
    runUnderMlsLock: <T>(fn: () => Promise<T>) => fn(),
    freshEpoch: vi.fn().mockResolvedValue(5),
    getEpoch: vi.fn(() => 5),
    exportRatchetTree: vi.fn().mockResolvedValue(new Uint8Array([7])),
    sendWelcome: vi.fn().mockResolvedValue(undefined),
    catchUpOnRefusedCommit: vi.fn().mockResolvedValue(undefined),
    unresolvedGroups: null,
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
    'mergeSettled',
    'deliverOwedWelcomes',
    'knownUnresolvedGroups',
    'settleUnresolvedCommits',
    'settleUnresolvedCommitFromLog',
  ]) {
    c[name] = proto[name];
  }
  return c as unknown as Record<string, ReturnType<typeof vi.fn>> & {
    state: PendingState;
    owed: OwedState;
    delivery: { submitCommit: ReturnType<typeof vi.fn> };
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
      [{ userId: 'user-z' }]
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
    expect(c.sendWelcome).not.toHaveBeenCalled();
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
      undefined
    );
    expect(c.mergePendingCommit).toHaveBeenCalledTimes(1);
    expect(c.state.size).toBe(0);
    expect(persistMlsStructuralCheckpoint).toHaveBeenCalledTimes(1);
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
    expect(c.sendWelcome.mock.calls).toEqual([
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
    const durable = persistMlsStructuralCheckpoint.mock.invocationCallOrder[0];
    const sent = c.sendWelcome.mock.invocationCallOrder[0];
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
        {
          groupId: G,
          welcome: new Uint8Array([3]),
          ratchetTree: new Uint8Array([7]),
          recipients: ['u-b:d-b2'],
        },
      ],
    ]);
    const c = ctx(submitting(), { owed });
    await c.settleUnresolvedCommits();
    expect(c.delivery.submitCommit).not.toHaveBeenCalled();
    expect(c.mergePendingCommit).not.toHaveBeenCalled();
    expect(c.mergePendingCommitOwingWelcome).not.toHaveBeenCalled();
    expect(c.sendWelcome.mock.calls).toEqual([
      [new Uint8Array([3]), 'u-b', G, 'd-b2', new Uint8Array([7])],
    ]);
    expect(owed.size).toBe(0);
  });

  it('keeps a Welcome owed when its send fails, for the next settlement', async () => {
    const c = ctx(submitting({ accepted: true, duplicate: true }), {
      state: kept({ excludeDeviceIds: ['u-b:d-b'] }, { welcome: new Uint8Array([3]) }),
    });
    c.sendWelcome.mockRejectedValueOnce(lost());
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await c.settleUnresolvedCommits();
    expect(c.owed.get(G)?.recipients).toEqual(['u-b:d-b']);
    error.mockRestore();
    await c.settleUnresolvedCommits();
    expect(c.sendWelcome).toHaveBeenCalledTimes(2);
    expect(c.owed.size).toBe(0);
  });

  it('delivers no Welcome when the kept Add is refused', async () => {
    const c = ctx(submitting({ accepted: false, reason: 'epoch_mismatch', currentEpoch: 7 }), {
      state: kept({ excludeDeviceIds: ['u-b:d-b'] }, { welcome: new Uint8Array([3]) }),
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

describe('settleUnresolvedCommitFromLog - the log decided at the base epoch', () => {
  it("merges when the row at the base epoch is OUR commit, and delivers an Add's Welcome", async () => {
    const c = ctx(submitting(), {
      state: kept({ excludeDeviceIds: ['u-b:d-b'] }, { welcome: new Uint8Array([3]) }),
    });
    expect(await c.settleUnresolvedCommitFromLog(G, OURS)).toBe('merged');
    expect(c.mergePendingCommitOwingWelcome).toHaveBeenCalledTimes(1);
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
  constructor(submitCommit: ReturnType<typeof vi.fn>, state: PendingState) {
    super('web');
    Object.assign(this as unknown as Record<string, unknown>, {
      userId: U,
      deviceId: D,
      delivery: { postApplicationMessage: async () => null, submitCommit },
      scheduleLeafRefresh: () => {},
      getEpoch: () => 5,
      ...primitives(state),
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
