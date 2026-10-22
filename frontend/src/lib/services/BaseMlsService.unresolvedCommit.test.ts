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
  readUnresolvedCommits,
  recordUnresolvedCommit,
  unresolvedCommitFor,
  type UnresolvedCommit,
} from '$lib/mls-client/unresolvedCommits';
import { readLeafRefreshLedger } from '$lib/mls-client/leafRefresh';
import { ApiRefusalError } from '$lib/utils/apiRefusalError';
import { TransportFailureError, isTransportFailure } from '$lib/utils/transportFailure';

/**
 * A SUBMISSION WHOSE ANSWER WAS LOST IS RESUBMITTED, NEVER GUESSED.
 *
 * Reading the server's log after a lost answer cannot tell "not landed yet" from "never landed": a
 * clear decided from an empty log races the request still in flight, which the gate then accepts
 * - and the device has thrown away a commit everyone else applied. So the SAME bytes are submitted
 * again, the gate answers a duplicate of an accepted commit as accepted, and an outcome that stays
 * unknown is KEPT, durably, with nothing else committed or sent in the group until a resubmission
 * answers. These cases pin each verdict and each place a resubmission is owed.
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

function ctx(submitCommit: ReturnType<typeof vi.fn>, opts: { epoch?: number } = {}) {
  const c: Record<string, unknown> = {
    userId: U,
    deviceId: D,
    delivery: { submitCommit },
    runUnderMlsLock: <T>(fn: () => Promise<T>) => fn(),
    freshEpoch: vi.fn().mockResolvedValue(5),
    getEpoch: vi.fn(() => opts.epoch ?? 5),
    getLocalGroups: vi.fn(() => [G]),
    mergePendingCommit: vi.fn().mockResolvedValue(undefined),
    clearPendingCommit: vi.fn().mockResolvedValue(undefined),
    catchUpOnRefusedCommit: vi.fn().mockResolvedValue(undefined),
  };
  // The real seams under test: what they decide from the gate's answers is what these cases are about.
  for (const name of [
    'runCommitTransaction',
    'settleUnresolvedLocked',
    'submitRecorded',
    'resubmitUnresolved',
    'keepUnresolved',
    'awaitCommitCheckpoint',
    'mergeSettled',
    'settleUnresolvedCommits',
    'settleUnresolvedCommitFromLog',
  ]) {
    c[name] = proto[name];
  }
  return c as unknown as Record<string, ReturnType<typeof vi.fn>> & {
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

const stage = vi.fn(async () => ({ commit: new Uint8Array([1]), groupInfo: new Uint8Array([2]) }));
const run = (c: ReturnType<typeof ctx>) =>
  c.runCommitTransaction(G, stage, { removes: [{ userId: 'user-z' }] });

function record(over: Partial<UnresolvedCommit> = {}): UnresolvedCommit {
  return { groupId: G, baseEpoch: 5, commit: OURS, groupInfo: BASE, at: 1, ...over };
}

beforeEach(() => {
  localStorage.clear();
  stage.mockClear();
  persistMlsStructuralCheckpoint.mockReset().mockResolvedValue(true);
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
    expect(readUnresolvedCommits(U, D)).toEqual({});
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
    expect(readUnresolvedCommits(U, D)).toEqual({});
  });

  it('clears WITHOUT resubmitting a 4xx - the gate answered, and it refused', async () => {
    const refusal = new ApiRefusalError(403, null, 'Commit submission HTTP error (403)');
    const c = ctx(submitting(refusal));
    await expect(run(c)).rejects.toBe(refusal);
    expect(c.delivery.submitCommit).toHaveBeenCalledTimes(1);
    expect(c.clearPendingCommit).toHaveBeenCalledTimes(1);
    expect(readUnresolvedCommits(U, D)).toEqual({});
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
    'KEEPS the staged commit, records it durably and checkpoints it after %s',
    async (_name, second) => {
      const c = ctx(submitting(lost(), second));
      const err = await run(c).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CommitOutcomeUnknownError);
      // Read by every caller as "no answer": retried when the server answers, never final.
      expect(isTransportFailure(err)).toBe(true);
      expect(c.clearPendingCommit).not.toHaveBeenCalled();
      expect(c.mergePendingCommit).not.toHaveBeenCalled();
      expect(unresolvedCommitFor(U, D, G)).toMatchObject({
        groupId: G,
        baseEpoch: 5,
        commit: OURS,
        groupInfo: BASE,
        removes: [{ userId: 'user-z' }],
      });
      expect(persistMlsStructuralCheckpoint).toHaveBeenCalledTimes(1);
    }
  );

  it('clears when the unresolved record cannot be written - nothing would settle it after a reload', async () => {
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    try {
      const c = ctx(submitting(lost(), lost()));
      await expect(run(c)).rejects.toBeInstanceOf(TransportFailureError);
      expect(c.clearPendingCommit).toHaveBeenCalledTimes(1);
    } finally {
      setItem.mockRestore();
    }
  });
});

describe('runCommitTransaction - a group whose last commit is unresolved', () => {
  it('takes NO new commit while a resubmission of the old one still gets no answer', async () => {
    recordUnresolvedCommit(U, D, record());
    const c = ctx(submitting(lost()));
    await expect(run(c)).rejects.toBeInstanceOf(CommitOutcomeUnknownError);
    expect(stage).not.toHaveBeenCalled();
    expect(c.delivery.submitCommit.mock.calls[0].slice(0, 3)).toEqual([G, 5, OURS]);
    expect(unresolvedCommitFor(U, D, G)).not.toBeNull();
  });

  it('merges the old commit when its resubmission is accepted, then stages the new one', async () => {
    recordUnresolvedCommit(U, D, record());
    const c = ctx(submitting({ accepted: true, duplicate: true }, { accepted: true }));
    await run(c);
    expect(c.mergePendingCommit).toHaveBeenCalledTimes(2);
    expect(stage).toHaveBeenCalledTimes(1);
    expect(unresolvedCommitFor(U, D, G)).toBeNull();
  });
});

describe('settleUnresolvedCommits - the resubmission at the next connection', () => {
  it('merges on a duplicate answer, forgets the record and checkpoints', async () => {
    recordUnresolvedCommit(U, D, record({ admits: [{ userId: 'u-b', deviceId: 'd-b' }] }));
    const c = ctx(submitting({ accepted: true, duplicate: true }));
    await c.settleUnresolvedCommits();
    expect(c.delivery.submitCommit).toHaveBeenCalledExactlyOnceWith(
      G,
      5,
      OURS,
      undefined,
      BASE,
      [{ userId: 'u-b', deviceId: 'd-b' }],
      undefined
    );
    expect(c.mergePendingCommit).toHaveBeenCalledTimes(1);
    expect(unresolvedCommitFor(U, D, G)).toBeNull();
    expect(persistMlsStructuralCheckpoint).toHaveBeenCalledTimes(1);
  });

  it('clears and catches up on a refusal', async () => {
    recordUnresolvedCommit(U, D, record());
    const c = ctx(submitting({ accepted: false, reason: 'epoch_mismatch', currentEpoch: 7 }));
    await c.settleUnresolvedCommits();
    expect(c.clearPendingCommit).toHaveBeenCalledTimes(1);
    expect(c.catchUpOnRefusedCommit).toHaveBeenCalledWith(G, 5, 7);
    expect(unresolvedCommitFor(U, D, G)).toBeNull();
  });

  it('keeps the record when the resubmission gets no answer either', async () => {
    recordUnresolvedCommit(U, D, record());
    const c = ctx(submitting(lost()));
    await c.settleUnresolvedCommits();
    expect(c.clearPendingCommit).not.toHaveBeenCalled();
    expect(c.mergePendingCommit).not.toHaveBeenCalled();
    expect(unresolvedCommitFor(U, D, G)).not.toBeNull();
  });

  it('forgets, without a submission, a record whose group moved on or is no longer held', async () => {
    recordUnresolvedCommit(U, D, record());
    recordUnresolvedCommit(U, D, record({ groupId: 'g-gone' }));
    // g-1 is at epoch 6: something else moved it (another member's commit at 5 cleared ours).
    const c = ctx(submitting(), { epoch: 6 });
    await c.settleUnresolvedCommits();
    expect(c.delivery.submitCommit).not.toHaveBeenCalled();
    expect(readUnresolvedCommits(U, D)).toEqual({});
  });
});

describe('settleUnresolvedCommitFromLog - the log decided at the base epoch', () => {
  it('merges when the row at the base epoch is OUR commit', async () => {
    recordUnresolvedCommit(U, D, record());
    const c = ctx(submitting());
    expect(await c.settleUnresolvedCommitFromLog(G, OURS)).toBe('merged');
    expect(c.mergePendingCommit).toHaveBeenCalledTimes(1);
    expect(unresolvedCommitFor(U, D, G)).toBeNull();
  });

  it("clears when the row at the base epoch is another device's commit", async () => {
    recordUnresolvedCommit(U, D, record());
    const c = ctx(submitting());
    expect(await c.settleUnresolvedCommitFromLog(G, 'Bw==')).toBe('cleared');
    expect(c.clearPendingCommit).toHaveBeenCalledTimes(1);
    expect(unresolvedCommitFor(U, D, G)).toBeNull();
  });

  it('decides NOTHING when the log has no row at the base epoch yet', async () => {
    recordUnresolvedCommit(U, D, record());
    const c = ctx(submitting());
    expect(await c.settleUnresolvedCommitFromLog(G, null)).toBe('undecided');
    expect(c.mergePendingCommit).not.toHaveBeenCalled();
    expect(c.clearPendingCommit).not.toHaveBeenCalled();
    expect(unresolvedCommitFor(U, D, G)).not.toBeNull();
  });
});

/** Only `sendMessage` and what it reaches; the two dozen other abstract members stay unstubbed. */
abstract class SendHarness extends BaseMlsService {
  readonly encrypted: string[] = [];
  constructor(submitCommit: ReturnType<typeof vi.fn>) {
    super('web');
    Object.assign(this as unknown as Record<string, unknown>, {
      userId: U,
      deviceId: D,
      delivery: { postApplicationMessage: async () => null, submitCommit },
      scheduleLeafRefresh: () => {},
      getEpoch: () => 5,
      getLocalGroups: () => [G],
      mergePendingCommit: vi.fn().mockResolvedValue(undefined),
      clearPendingCommit: vi.fn().mockResolvedValue(undefined),
    });
  }
  protected async encryptForSend(groupId: string): Promise<Uint8Array> {
    this.encrypted.push(groupId);
    return new Uint8Array([1]);
  }
}
const Harness = SendHarness as unknown as new (s: ReturnType<typeof vi.fn>) => SendHarness;

describe('sendMessage - a group whose last commit is unresolved', () => {
  it('encrypts NOTHING while the resubmission still gets no answer', async () => {
    recordUnresolvedCommit(U, D, record());
    const svc = new Harness(submitting(lost()));
    await expect(svc.sendMessage(G, new Uint8Array([9]))).rejects.toBeInstanceOf(
      CommitOutcomeUnknownError
    );
    expect(svc.encrypted).toEqual([]);
  });

  it('settles first, then sends at the epoch the answer decided', async () => {
    recordUnresolvedCommit(U, D, record());
    const svc = new Harness(submitting({ accepted: true, duplicate: true }));
    await svc.sendMessage(G, new Uint8Array([9]));
    expect(svc.encrypted).toEqual([G]);
    expect(unresolvedCommitFor(U, D, G)).toBeNull();
  });
});
