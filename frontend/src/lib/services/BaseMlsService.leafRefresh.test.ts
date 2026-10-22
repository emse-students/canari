// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/TauriMlsService', () => ({ TauriMlsService: class {} }));
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));
vi.mock('$lib/mls-client/mlsStatePersisterRegistry', () => ({
  persistMlsStructuralCheckpoint: vi.fn().mockResolvedValue(true),
  scheduleOutboundMlsPersist: vi.fn(),
}));

import { BaseMlsService } from './BaseMlsService';
import { DELIVERY, addressedKeyMaterial, type FrameDelivery } from '$lib/mls-client/frameDelivery';
import { LeafRefreshUnverifiedError, readLeafRefreshLedger } from '$lib/mls-client/leafRefresh';

/**
 * THE WIRING OF THE PERIODIC LEAF REFRESH INTO THE TWO SEAMS IT HANGS FROM.
 *
 * `leafRefresh.test.ts` owns the decision. These pin where it is reached from: every own commit the
 * server ACCEPTS dates the leaf (a Remove or an Add replaces it as surely as a refresh does), a
 * refused one does not, and only a durable conversation send asks whether a refresh is due - never
 * a seed and never transport traffic.
 */

const U = 'user-a';
const D = 'web-a';

type RunCommit = (
  g: string,
  stage: () => Promise<{ commit: Uint8Array; groupInfo: Uint8Array }>,
  opts?: Record<string, unknown>
) => Promise<unknown>;
const runCommitTransaction = (
  BaseMlsService.prototype as unknown as { runCommitTransaction: RunCommit }
).runCommitTransaction;

function commitCtx(accepted: boolean) {
  return {
    userId: U,
    deviceId: D,
    delivery: {
      submitCommit: vi
        .fn()
        .mockResolvedValue(
          accepted ? { accepted: true } : { accepted: false, reason: 'concurrent_commit' }
        ),
    },
    runUnderMlsLock: <T>(fn: () => Promise<T>) => fn(),
    freshEpoch: vi.fn().mockResolvedValue(5),
    mergePendingCommit: vi.fn().mockResolvedValue(undefined),
    clearPendingCommit: vi.fn().mockResolvedValue(undefined),
    catchUpOnRefusedCommit: vi.fn().mockResolvedValue(undefined),
    // The real one: what it reads of the log is what these cases are about.
    ownCommitLanded: (BaseMlsService.prototype as unknown as { ownCommitLanded: unknown })
      .ownCommitLanded,
  };
}

const staged = async () => ({ commit: new Uint8Array([1]), groupInfo: new Uint8Array([2]) });

beforeEach(() => localStorage.clear());

describe('BaseMlsService - every accepted own commit dates the leaf', () => {
  it('records the epoch the accepted commit created', async () => {
    await runCommitTransaction.call(commitCtx(true), 'g-1', staged, {});
    expect(readLeafRefreshLedger(U, D)['g-1']).toMatchObject({ epoch: 6 });
  });

  it('records nothing for a refused commit - the leaf did not change', async () => {
    await expect(runCommitTransaction.call(commitCtx(false), 'g-1', staged, {})).rejects.toThrow();
    expect(readLeafRefreshLedger(U, D)['g-1']).toBeUndefined();
  });
});

describe('BaseMlsService.runCommitTransaction - a submission whose answer was lost', () => {
  // THE STAGED COMMIT MUST NOT OUTLIVE AN UNANSWERED SUBMIT. Left pending, the next checkpoint
  // persists it, and from then on openmls refuses every commit this device stages in the group -
  // no Add, no Remove, no refresh - until something clears it, which nothing did.
  const OURS = 'AQ=='; // base64 of the staged commit [1]

  function lostAnswerCtx(
    replay: () => Promise<{
      commits: Array<{ baseEpoch: number; proto: string }>;
      activeEpoch: number;
    }>
  ) {
    const ctx = commitCtx(true);
    ctx.delivery.submitCommit = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    return Object.assign(ctx, {
      delivery: {
        ...ctx.delivery,
        fetchCommitsSince: vi.fn(async () => ({ belowFloor: false, ...(await replay()) })),
      },
    });
  }

  it('merges when the server log holds OUR commit at the base epoch - it was accepted', async () => {
    const ctx = lostAnswerCtx(async () => ({
      commits: [{ baseEpoch: 5, proto: OURS }],
      activeEpoch: 6,
    }));
    await runCommitTransaction.call(ctx, 'g-1', staged, {});
    expect(ctx.delivery.fetchCommitsSince).toHaveBeenCalledWith('g-1', 5);
    expect(ctx.mergePendingCommit).toHaveBeenCalledTimes(1);
    expect(ctx.clearPendingCommit).not.toHaveBeenCalled();
    expect(readLeafRefreshLedger(U, D)['g-1']).toMatchObject({ epoch: 6 });
  });

  it('clears and rethrows when the log does not hold it - nothing was accepted', async () => {
    const ctx = lostAnswerCtx(async () => ({ commits: [], activeEpoch: 5 }));
    await expect(runCommitTransaction.call(ctx, 'g-1', staged, {})).rejects.toThrow(
      'Failed to fetch'
    );
    expect(ctx.clearPendingCommit).toHaveBeenCalledTimes(1);
    expect(ctx.mergePendingCommit).not.toHaveBeenCalled();
    expect(ctx.catchUpOnRefusedCommit).not.toHaveBeenCalled();
  });

  it('clears, catches up and rethrows when ANOTHER commit took the base epoch', async () => {
    const ctx = lostAnswerCtx(async () => ({
      commits: [{ baseEpoch: 5, proto: 'Ag==' }],
      activeEpoch: 6,
    }));
    await expect(runCommitTransaction.call(ctx, 'g-1', staged, {})).rejects.toThrow();
    expect(ctx.clearPendingCommit).toHaveBeenCalledTimes(1);
    expect(ctx.mergePendingCommit).not.toHaveBeenCalled();
    expect(ctx.catchUpOnRefusedCommit).toHaveBeenCalledWith('g-1', 5, 6);
  });

  it('clears and rethrows when the log cannot be read either', async () => {
    const ctx = lostAnswerCtx(async () => {
      throw new TypeError('offline');
    });
    await expect(runCommitTransaction.call(ctx, 'g-1', staged, {})).rejects.toThrow(
      'Failed to fetch'
    );
    expect(ctx.clearPendingCommit).toHaveBeenCalledTimes(1);
    expect(ctx.mergePendingCommit).not.toHaveBeenCalled();
    expect(readLeafRefreshLedger(U, D)['g-1']).toBeUndefined();
  });
});

describe('BaseMlsService.refreshOwnLeaf - staged only on the branch the server publishes', () => {
  const GI = 'Zm9v'; // any base64: the comparison is stubbed

  function refreshCtx(opts: {
    base: { groupInfo: string; baseEpoch: number; activeEpoch: number } | null;
    matches?: boolean;
  }) {
    const stageSelfUpdate = vi.fn().mockResolvedValue({
      commit: new Uint8Array([1]),
      groupInfo: new Uint8Array([2]),
    });
    const run = vi.fn(async (_g: string, stage: () => Promise<unknown>, _opts?: unknown) => {
      await stage();
      return {};
    });
    return {
      delivery: { fetchGroupInfo: vi.fn().mockResolvedValue(opts.base) },
      freshEpoch: vi.fn().mockResolvedValue(5),
      ownContextMatchesBase: vi.fn().mockResolvedValue(opts.matches ?? true),
      runCommitTransaction: run,
      stageSelfUpdate,
    };
  }
  const refresh = (
    BaseMlsService.prototype as unknown as { refreshOwnLeaf(g: string): Promise<void> }
  ).refreshOwnLeaf;

  it('stages a plain commit transaction that admits and removes nobody', async () => {
    const ctx = refreshCtx({ base: { groupInfo: GI, baseEpoch: 5, activeEpoch: 5 } });
    await refresh.call(ctx, 'g-1');
    expect(ctx.runCommitTransaction).toHaveBeenCalledTimes(1);
    // No `removes`, no `excludeDeviceIds`: the server must queue it to nobody extra and record no
    // admission - a refresh is neither a departure nor an arrival.
    expect(ctx.runCommitTransaction.mock.calls[0][2]).toBeUndefined();
    expect(ctx.ownContextMatchesBase).toHaveBeenCalledWith(
      'g-1',
      new Uint8Array([0x66, 0x6f, 0x6f])
    );
    expect(ctx.stageSelfUpdate).toHaveBeenCalledExactlyOnceWith('g-1');
  });

  it.each([
    ['no base is published', { base: null }, 'no-base'],
    [
      'the base is of another epoch',
      { base: { groupInfo: GI, baseEpoch: 4, activeEpoch: 4 } },
      'other-epoch',
    ],
    [
      'this device is on another branch at the same epoch number',
      { base: { groupInfo: GI, baseEpoch: 5, activeEpoch: 5 }, matches: false },
      'diverged',
    ],
  ] as const)('refuses, staging nothing, when %s', async (_n, opts, reason) => {
    const ctx = refreshCtx(opts);
    const err = await refresh.call(ctx, 'g-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LeafRefreshUnverifiedError);
    expect((err as LeafRefreshUnverifiedError).reason).toBe(reason);
    expect(ctx.stageSelfUpdate).not.toHaveBeenCalled();
  });
});

/** Only `sendMessage` and what it reaches; the two dozen other abstract members stay unstubbed. */
abstract class SendHarness extends BaseMlsService {
  readonly scheduled: string[] = [];
  constructor() {
    super('web');
    (this as unknown as { delivery: unknown }).delivery = {
      postApplicationMessage: async () => null,
    };
    (this as unknown as { scheduleLeafRefresh: (g: string) => void }).scheduleLeafRefresh = (
      g: string
    ) => {
      this.scheduled.push(g);
    };
  }
  protected async encryptForSend(): Promise<Uint8Array> {
    return new Uint8Array([1]);
  }
}
const Harness = SendHarness as unknown as new () => SendHarness;

describe('BaseMlsService.sendMessage - which sends ask whether a refresh is due', () => {
  const cases: Array<[string, FrameDelivery, boolean]> = [
    ['a visible message', DELIVERY.visible, true],
    ['a mutation (reaction, edit, read receipt)', DELIVERY.mutation, true],
    ['transport traffic, which every connection sends', DELIVERY.transport, false],
    ['a Graine seed, whose key group rotates on any epoch move', DELIVERY.keyMaterial, false],
    // A NEW object on every call, shaped exactly like a mutation: neither its identity nor its
    // value may make it look like a conversation send.
    ['a seed ADDRESSED to one requester', addressedKeyMaterial('user-b:dev-b'), false],
  ];
  it.each(cases)('%s', async (_name, delivery, asks) => {
    const svc = new Harness();
    await svc.sendMessage('g-1', new Uint8Array([9]), undefined, delivery);
    expect(svc.scheduled).toEqual(asks ? ['g-1'] : []);
  });
});
