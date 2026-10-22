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
import { recordingStage } from '../../test/recordingStage';

/** Any intent: the refresh only hands it on to its stage. */
const INTENT = new Uint8Array([9]);

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
  stage: (intent: Uint8Array) => Promise<{ commit: Uint8Array; groupInfo: Uint8Array }>,
  opts?: Record<string, unknown>
) => Promise<unknown>;
const runCommitTransaction = (
  BaseMlsService.prototype as unknown as { runCommitTransaction: RunCommit }
).runCommitTransaction;

function commitCtx(accepted: boolean) {
  const recorder = recordingStage(() => 5);
  return {
    recorder,
    pendingSubmission: recorder.pendingSubmission,
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
    // No staged commit kept in the state: every commit here is answered at once.
    groupsWithPendingCommit: vi.fn(async () => []),
    // The real ones: with no staged commit kept they settle nothing (see
    // `BaseMlsService.unresolvedCommit.test.ts` for the cases where they do).
    ...Object.fromEntries(
      [
        'settleUnresolvedLocked',
        'checkpointStageBeforeSend',
        'submitRecorded',
        'resubmitUnresolved',
      ].map((name) => [
        name,
        (BaseMlsService.prototype as unknown as Record<string, unknown>)[name],
      ])
    ),
  };
}

const staged = async () => ({ commit: new Uint8Array([1]), groupInfo: new Uint8Array([2]) });

beforeEach(() => localStorage.clear());

describe('BaseMlsService - every accepted own commit dates the leaf', () => {
  it('records the epoch the accepted commit created', async () => {
    const ctx = commitCtx(true);
    await runCommitTransaction.call(ctx, 'g-1', ctx.recorder.wrap(staged), {});
    expect(readLeafRefreshLedger(U, D)['g-1']).toMatchObject({ epoch: 6 });
  });

  it('records nothing for a refused commit - the leaf did not change', async () => {
    const ctx = commitCtx(false);
    await expect(
      runCommitTransaction.call(ctx, 'g-1', ctx.recorder.wrap(staged), {})
    ).rejects.toThrow();
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
    const run = vi.fn(
      async (_g: string, stage: (intent: Uint8Array) => Promise<unknown>, _opts?: unknown) => {
        await stage(INTENT);
        return {};
      }
    );
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
    expect(ctx.stageSelfUpdate).toHaveBeenCalledExactlyOnceWith('g-1', INTENT);
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
  /** No staged commit is kept in this state: a send asks, and finds nothing to settle. */
  protected async groupsWithPendingCommit(): Promise<string[]> {
    return [];
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
