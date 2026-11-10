// @vitest-environment happy-dom
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
import {
  LEAF_REFRESH_INTERVAL_MS,
  LeafRefreshHeldError,
  callHoldLockName,
  noteLeafObserved,
  readLeafRefreshLedger,
} from '$lib/mls-client/leafRefresh';
import { UnpublishedBranchError } from '$lib/mls-client/publishedBranch';
import {
  CommitOutcomeUnknownError,
  FollowerTabCommitError,
} from '$lib/mls-client/commitSubmission';
import { clearEpochGap, isInEpochGap } from '$lib/utils/chat/epochGapRegistry';
import { recordingStage } from '../../test/recordingStage';
import { sealedFrame } from '$lib/mls-client/test/sealedFrame';
import type { AuthoredFrame } from '$lib/mls-client/mlsDeliveryApi';
import { plainCommitLock } from '$lib/mls-client/test/fixtures/plainCommitLock';

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
    ...plainCommitLock,
    runUnderMlsLock: <T>(fn: () => Promise<T>) => fn(),
    freshEpoch: vi.fn().mockResolvedValue(5),
    // The key the merged commit gives this device's leaf, which the ledger names it by.
    ownLeafKey: vi.fn(async () => 'k-leaf'),
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
        'mergeAccepted',
        'noteOwnLeafReplaced',
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
  it('records the epoch the accepted commit created, naming the leaf the MERGE produced', async () => {
    const ctx = commitCtx(true);
    await runCommitTransaction.call(ctx, 'g-1', ctx.recorder.wrap(staged), {});
    expect(readLeafRefreshLedger(U, D)['g-1']).toMatchObject({ epoch: 6, leaf: 'k-leaf' });
    // Read after the merge: before it, the key is the leaf this commit replaces.
    expect(ctx.ownLeafKey.mock.invocationCallOrder[0]).toBeGreaterThan(
      ctx.mergePendingCommit.mock.invocationCallOrder[0]
    );
  });

  it('a kept commit merged by its settlement dates the leaf through the same writer', async () => {
    // KILL-2 asked whether some merge of an own commit skips the ledger: the transaction and the
    // settlement both merge through `mergeAccepted`, which dates the leaf.
    const ctx = commitCtx(true);
    const mergeSettled = (
      BaseMlsService.prototype as unknown as { mergeSettled(s: unknown): Promise<void> }
    ).mergeSettled;
    await mergeSettled.call(ctx, { groupId: 'g-1', baseEpoch: 9, commit: 'Y29tbWl0' });
    expect(ctx.mergePendingCommit).toHaveBeenCalledExactlyOnceWith('g-1');
    expect(readLeafRefreshLedger(U, D)['g-1']).toMatchObject({ epoch: 10, leaf: 'k-leaf' });
  });

  it('a leaf key that cannot be read dates nothing, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ctx = commitCtx(true);
    ctx.ownLeafKey.mockRejectedValue(new Error('no state'));
    await runCommitTransaction.call(ctx, 'g-1', ctx.recorder.wrap(staged), {});
    expect(readLeafRefreshLedger(U, D)['g-1']).toBeUndefined();
    expect(warn.mock.calls.flat().join(' ')).toContain('not dated');
    warn.mockRestore();
  });

  it('records nothing for a refused commit - the leaf did not change', async () => {
    const ctx = commitCtx(false);
    await expect(
      runCommitTransaction.call(ctx, 'g-1', ctx.recorder.wrap(staged), {})
    ).rejects.toThrow();
    expect(readLeafRefreshLedger(U, D)['g-1']).toBeUndefined();
  });
});

describe('the commits no person asks for - staged only on the branch the server publishes', () => {
  const GI = 'Zm9v'; // any base64: the comparison is stubbed

  function branchCtx(opts: {
    base: { groupInfo: string; baseEpoch: number; activeEpoch: number } | null;
    matches?: boolean;
  }) {
    const stagedCommit = { commit: new Uint8Array([1]), groupInfo: new Uint8Array([2]) };
    const run = vi.fn(
      async (_g: string, stage: (intent: Uint8Array) => Promise<unknown>, _opts?: unknown) => {
        await stage(INTENT);
        return {};
      }
    );
    return {
      delivery: { fetchGroupInfo: vi.fn().mockResolvedValue(opts.base) },
      // REAL routing: a conversation (no registered scope) reads its base from chat-delivery.
      distributionScopeByGroup: new Map(),
      knownDistributionGroups: new Set(),
      groupInfoChannel: (BaseMlsService.prototype as unknown as { groupInfoChannel: unknown })
        .groupInfoChannel,
      freshEpoch: vi.fn().mockResolvedValue(5),
      ownContextMatchesBase: vi.fn().mockResolvedValue(opts.matches ?? true),
      // The real read: no follower tab holds a call here.
      callHeldByAnotherTab: (
        BaseMlsService.prototype as unknown as { callHeldByAnotherTab: unknown }
      ).callHeldByAnotherTab,
      runCommitTransaction: run,
      stageSelfUpdate: vi.fn().mockResolvedValue(stagedCommit),
      stageRemoveMembersByDevice: vi.fn().mockResolvedValue(stagedCommit),
      assertOnPublishedBranch: (
        BaseMlsService.prototype as unknown as { assertOnPublishedBranch: unknown }
      ).assertOnPublishedBranch,
    };
  }
  const proto = BaseMlsService.prototype as unknown as {
    refreshOwnLeaf(g: string): Promise<void>;
    removeMemberDevice(g: string, ids: string[]): Promise<void>;
  };
  const REVOKED = ['user-b:dev-lost'];
  const commits = [
    ['the leaf refresh', (ctx: object) => proto.refreshOwnLeaf.call(ctx, 'g-1'), 'stageSelfUpdate'],
    [
      'the removal of a revoked device',
      (ctx: object) => proto.removeMemberDevice.call(ctx, 'g-1', REVOKED),
      'stageRemoveMembersByDevice',
    ],
  ] as const;

  afterEach(() => clearEpochGap('g-1'));

  it('stages a refresh as a plain commit transaction that admits and removes nobody', async () => {
    const ctx = branchCtx({ base: { groupInfo: GI, baseEpoch: 5, activeEpoch: 5 } });
    await proto.refreshOwnLeaf.call(ctx, 'g-1');
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

  it('stages the removal of a revoked device on the published branch, declaring what it removes', async () => {
    const ctx = branchCtx({ base: { groupInfo: GI, baseEpoch: 5, activeEpoch: 5 } });
    await proto.removeMemberDevice.call(ctx, 'g-1', REVOKED);
    expect(ctx.ownContextMatchesBase).toHaveBeenCalledTimes(1);
    expect(ctx.stageRemoveMembersByDevice).toHaveBeenCalledExactlyOnceWith('g-1', REVOKED, INTENT);
    expect(ctx.runCommitTransaction.mock.calls[0][2]).toEqual({
      removes: [{ userId: 'user-b', deviceId: 'dev-lost' }],
    });
  });

  it('refuses a refresh on a follower tab BEFORE fetching the published base', async () => {
    const leadership = await import('$lib/mls-client/tabLeader');
    vi.spyOn(leadership, 'getTabLeadership').mockReturnValue('follower');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const ctx = branchCtx({ base: { groupInfo: GI, baseEpoch: 5, activeEpoch: 5 } });
    await expect(proto.refreshOwnLeaf.call(ctx, 'g-1')).rejects.toBeInstanceOf(
      FollowerTabCommitError
    );
    expect(ctx.delivery.fetchGroupInfo).not.toHaveBeenCalled();
    expect(ctx.runCommitTransaction).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  describe.each(commits)('%s', (_name, commit, stageName) => {
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
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const ctx = branchCtx(opts);
      const err = await commit(ctx).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnpublishedBranchError);
      expect((err as UnpublishedBranchError).reason).toBe(reason);
      expect(ctx[stageName]).not.toHaveBeenCalled();
      // ONLY a fork accuses: it is handed to rung 2 through the epoch-gap registry, said at error
      // level. A missing or older base says nothing about this device's branch.
      expect(isInEpochGap('g-1')).toBe(reason === 'diverged');
      expect(error).toHaveBeenCalledTimes(reason === 'diverged' ? 1 : 0);
      error.mockRestore();
    });
  });
});

/**
 * A FOLLOWER TAB'S CALL HOLD, READ THROUGH THE REAL WIRING (sixth review of #3326). The browser's
 * lock table is stubbed on `navigator.locks`; everything between it and the decision is the
 * service's own.
 */
describe("a follower tab's call holds the refresh, through the service's own reads", () => {
  const G = 'g-held';
  const held: Array<{ name: string }> = [];
  beforeEach(() => {
    held.length = 0;
    Object.defineProperty(navigator, 'locks', {
      value: { query: async () => ({ held: [...held] }) },
      configurable: true,
    });
  });
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'locks');
    vi.restoreAllMocks();
  });

  const proto = BaseMlsService.prototype as unknown as Record<string, unknown>;

  it('a hold taken AFTER the decision is met under the MLS lock, before anything is staged', async () => {
    const stageSelfUpdate = vi.fn().mockResolvedValue({});
    const ctx = {
      delivery: {
        // The base is fetched between the decision and the lock: the follower takes its hold then.
        fetchGroupInfo: vi.fn(async () => {
          held.push({ name: callHoldLockName(G) });
          return { groupInfo: 'Zm9v', baseEpoch: 5, activeEpoch: 5 };
        }),
      },
      distributionScopeByGroup: new Map(),
      knownDistributionGroups: new Set(),
      groupInfoChannel: proto.groupInfoChannel,
      assertOnPublishedBranch: proto.assertOnPublishedBranch,
      callHeldByAnotherTab: proto.callHeldByAnotherTab,
      freshEpoch: vi.fn().mockResolvedValue(5),
      ownContextMatchesBase: vi.fn().mockResolvedValue(true),
      runCommitTransaction: vi.fn(async (_g: string, stage: (i: Uint8Array) => Promise<unknown>) =>
        stage(INTENT)
      ),
      stageSelfUpdate,
    };
    const refresh = proto.refreshOwnLeaf as (this: object, g: string) => Promise<void>;
    await expect(refresh.call(ctx, G)).rejects.toBeInstanceOf(LeafRefreshHeldError);
    expect(stageSelfUpdate).not.toHaveBeenCalled();
  });

  it('the decision reads the lock table through the service: a held group is never handed to the commit', async () => {
    const now = Date.now();
    noteLeafObserved(U, D, G, 5, 'k-leaf', now - LEAF_REFRESH_INTERVAL_MS);
    const refreshOwnLeaf = vi.fn(async () => {});
    const ctx = {
      userId: U,
      deviceId: D,
      isDistributionGroup: () => false,
      isGroupActive: async () => true,
      getEpoch: () => 5,
      ownLeafMintedAt: async () => Math.floor((now - 8 * 24 * 60 * 60 * 1000) / 1000),
      ownLeafKey: async () => 'k-leaf',
      refreshOwnLeaf,
      callHeldByAnotherTab: proto.callHeldByAnotherTab,
      leafRefreshAttempts: new Map(),
      leafRefreshNoOwnLeafReports: new Map(),
      leafRefreshInFlight: new Map<string, Promise<unknown>>(),
      leafRefreshSettled: proto.leafRefreshSettled,
    };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const schedule = proto.scheduleLeafRefresh as (this: object, g: string) => void;
    const settled = proto.leafRefreshSettled as (this: object, g: string) => Promise<void>;

    held.push({ name: callHoldLockName(G) });
    schedule.call(ctx, G);
    await settled.call(ctx, G);
    expect(refreshOwnLeaf).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join(' | ')).toContain('a call in another tab');

    // Control: the hang-up drops the lock, and the same decision commits.
    held.length = 0;
    schedule.call(ctx, G);
    await settled.call(ctx, G);
    expect(refreshOwnLeaf).toHaveBeenCalledExactlyOnceWith(G);
  });
});

/**
 * THE EPOCH A FOLLOWER'S CALL KEYS ARE READ AT (seventh review of #3326): a commit kept with an
 * unknown outcome merges at the next send - the call's first signalling frame, AFTER its keys - so
 * the leader settles it first, by the path every send takes. The same holds for a leader that
 * inherited the staged commit from the one before it.
 */
describe('settleForCallKeys - no call key is read over a staged commit', () => {
  const G = 'g-call';
  const proto = BaseMlsService.prototype as unknown as Record<string, unknown>;
  const settleForCallKeys = proto.settleForCallKeys as (this: object, g: string) => Promise<void>;

  /** A leader whose state holds `pending`, and whose settlement leaves `afterSettle` staged. */
  function leader(opts: {
    index: Set<string> | null;
    pending: string[];
    afterSettle: string[];
    inFlight?: Promise<unknown>;
  }) {
    const order: string[] = [];
    const ctx = {
      order,
      state: { pending: opts.pending },
      unresolvedGroups: opts.index,
      leafRefreshInFlight: new Map(opts.inFlight ? [[G, opts.inFlight]] : []),
      leafRefreshSettled: proto.leafRefreshSettled,
      settleBeforeSend: proto.settleBeforeSend,
      knownUnresolvedGroups: proto.knownUnresolvedGroups,
      getEpoch: () => 5,
      groupsWithPendingCommit: async () => ctx.state.pending,
      // The existing settlement, reduced to its effect on the state and the index.
      settleUnresolvedCommits: vi.fn(async () => {
        order.push('settled');
        ctx.state.pending = opts.afterSettle;
        ctx.unresolvedGroups = new Set(opts.afterSettle);
      }),
    };
    return ctx;
  }

  it('a refresh that ended with an unknown outcome is settled BEFORE the keys, after the refresh', async () => {
    let refreshEnds!: () => void;
    const inFlight = new Promise<void>((r) => (refreshEnds = r));
    const ctx = leader({ index: new Set(), pending: [], afterSettle: [], inFlight });
    const ready = settleForCallKeys.call(ctx, G).then(() => ctx.order.push('ready'));
    await Promise.resolve();
    expect(ctx.order).toEqual([]);
    // The refresh's commit was kept, outcome unknown: the index names the group.
    ctx.state.pending = [G];
    ctx.unresolvedGroups!.add(G);
    refreshEnds();
    await ready;
    expect(ctx.order).toEqual(['settled', 'ready']);
    expect(ctx.settleUnresolvedCommits).toHaveBeenCalledExactlyOnceWith([G]);
  });

  it('a leader that INHERITED a staged commit (no index yet) settles it the same way', async () => {
    const ctx = leader({ index: null, pending: [G], afterSettle: [] });
    await settleForCallKeys.call(ctx, G);
    expect(ctx.order).toEqual(['settled']);
  });

  it('a staged commit still unanswered after its settlement refuses the keys, typed', async () => {
    const ctx = leader({ index: null, pending: [G], afterSettle: [G] });
    await expect(settleForCallKeys.call(ctx, G)).rejects.toBeInstanceOf(CommitOutcomeUnknownError);
  });

  it('a group with no staged commit is ready at once, settling nothing', async () => {
    const ctx = leader({ index: null, pending: [], afterSettle: [] });
    await settleForCallKeys.call(ctx, G);
    expect(ctx.settleUnresolvedCommits).not.toHaveBeenCalled();
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
  protected async encryptForSend(): Promise<AuthoredFrame> {
    return { sealed: sealedFrame(1), authorProof: new Uint8Array([4]) };
  }
}
const Harness = SendHarness as unknown as new () => SendHarness;

describe('BaseMlsService.sendMessage - which sends ask whether a refresh is due', () => {
  const cases: Array<[string, FrameDelivery, boolean]> = [
    ['a visible message', DELIVERY.visible, true],
    ['a mutation (reaction, edit, read receipt)', DELIVERY.mutation, true],
    ['transport traffic, which every connection sends', DELIVERY.transport, false],
    ['a Graine seed - key-group traffic, never a refresh trigger', DELIVERY.keyMaterial, false],
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
