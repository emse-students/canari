// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/TauriMlsService', () => ({ TauriMlsService: class {} }));
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));
// The loss counter, observed: section 11 pins that a frame whose handler threw never reaches it.
vi.mock('$lib/mls-client/keyGroupFrameLosses', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/mls-client/keyGroupFrameLosses')>();
  return { ...actual, noteKeyGroupFrameLost: vi.fn(actual.noteKeyGroupFrameLost) };
});

import { BaseMlsService } from './BaseMlsService';
import {
  registerMlsStatePersister,
  unregisterMlsStatePersister,
} from '$lib/mls-client/mlsStatePersisterRegistry';
import type { ExternalJoinOutcome } from '$lib/mls-client/IMlsService';
import {
  describeKeyGroupFrameLosses,
  noteKeyGroupFrameLost,
  resetKeyGroupFrameLosses,
} from '$lib/mls-client/keyGroupFrameLosses';
import { frameFingerprint } from '$lib/mls-client/inboundFrameLedger';
import {
  KEPT_FRAME_MAX_BYTES,
  UnhandleableFrameError,
  keptFrameIds,
  keptFrameKey,
  keptFrameValue,
  readKeptFrame,
  roomToKeep,
} from '$lib/mls-client/keptKeyGroupFrames';
import { GRAINE_BUNDLE_PAGE_MAX_BYTES } from '$lib/crypto/graineConstants';
import {
  channelScope,
  workspaceScope,
  type DistributionScope,
} from '$lib/mls-client/distributionScope';
import {
  markEpochGap,
  isInEpochGap,
  resetEpochGapRegistry,
} from '$lib/utils/chat/epochGapRegistry';
import type { StoredDistributionGroup } from '$lib/db/types';
import {
  noteUnackedFrame,
  resetUnackedFrames,
  takeGroupsAwaiting,
  type UnackedReason,
} from '$lib/mls-client/messagePipeline/unackedFrames';
import { flushMacrotask } from '../../test/flush';
import { TransportFailureError } from '$lib/utils/transportFailure';
import { leadHoldsInFlight, resetLeadHoldsForTests } from '$lib/mls-client/leadHolds';
import { SenderMismatchError } from '$lib/mls-client/verifiedSender';
import { distributionEpochFor } from '$lib/utils/graine/seedDistribution';
import {
  closeStateLedgers,
  hydrateStateLedgers,
  noteStateLedgerHeldByState,
  readStateLedger,
  resetStateLedgersForTests,
  stateLedgerKeys,
} from '$lib/mls-client/stateLedgers';
import { forgetSeenCipherCaches } from '$lib/utils/chat/history';

/**
 * A Graine key-distribution group on the client (WP-22) - a community's, or a private salon's.
 *
 * Two things are being pinned down. First, that this group's external-join base is read from and
 * written to SOCIAL-SERVICE and never chat-delivery: the base is the capability to read every seed
 * in the community, so it is gated on community membership, which chat-delivery does not hold - its
 * own group-info route would answer 403 and read like a permission bug.
 *
 * Second, that two devices finding the group uninitialised converge without an election. Both
 * create an MLS group under the same id at epoch 0, and epoch 0 is no newer than epoch 0, so the
 * monotonic rule cannot separate them. Who won the INSERT can, and the loser must throw its group
 * away - a fork here would split a community's seeds in half, silently.
 */

type Ctx = ReturnType<typeof makeCtx>;

/** Prototype methods invoked through `.call`, so the real implementations are the ones under test. */
const proto = BaseMlsService.prototype as unknown as {
  settleUnresolvedCommitFromLog(groupId: string, commitAtBase: string | null): Promise<string>;
  registerDistributionGroup(scope: DistributionScope, groupId: string): void;
  isDistributionGroup(groupId: string): boolean;
  isDistributionBaseSettled(groupId: string): boolean;
  distributionGroupFor(scope: DistributionScope): string | null;
  distributionScopes(): DistributionScope[];
  groupInfoChannel(groupId: string): {
    fetch(): Promise<{ groupInfo: string; baseEpoch: number; activeEpoch: number } | null>;
    publish(groupInfo: string, baseEpoch: number): Promise<{ stored: boolean }>;
  };
  exportBaseForPublication(groupId: string): Promise<{ base: string; baseEpoch: number }>;
  publishCurrentBase(groupId: string): Promise<{ stored: boolean; baseEpoch: number }>;
  ensureDistributionGroup(
    scope: DistributionScope,
    ref: {
      groupId: string;
      groupInfo: string | null;
      baseEpoch: number | null;
      activeEpoch: number;
    }
  ): Promise<ExternalJoinOutcome>;
  routeDistributionFrame(
    groupId: string,
    sender: string,
    ciphertext: Uint8Array,
    senderDeviceId?: string,
    aheadOfMailbox?: boolean
  ): Promise<boolean>;
  noteDistributionGroup(groupId: string): void;
  forgetDistributionGroupById(
    groupId: string,
    reason: string,
    options?: { rejoining?: boolean }
  ): Promise<boolean>;
  forgetDistributionGroup(scope: DistributionScope): Promise<string | null>;
  openStateLedgers(): Promise<void>;
  hydrateDistributionGroups(): Promise<void>;
  refetchFramesLeftBehind(
    reasons: UnackedReason | readonly UnackedReason[],
    trigger: string,
    groupId?: string
  ): boolean;
  collectFramesLeftForKeyGroup(groupId: string): void;
  openAdmissionOfKeyGroup(groupId: string): void;
  noteDistributionGroup(groupId: string): void;
  persistDistributionGroup(scope: DistributionScope, groupId: string): void;
  openDistributionFrame(
    groupId: string,
    sender: string,
    bytes: Uint8Array
  ): Promise<Uint8Array | null>;
  dispositionOfUnreadableFrame(groupId: string, e: unknown): boolean;
  stepDistributionGroup(groupId: string): Promise<boolean>;
  closeDistributionGap(groupId: string): void;
  tellDistributionGapVerdict(groupId: string, verdict: string): void;
  tellEvictedOnce(groupId: string): void;
  handleKeptDistributionFrame(
    groupId: string,
    fingerprint: string,
    occasion: string
  ): Promise<boolean>;
  runKeptDistributionFrame(
    groupId: string,
    fingerprint: string,
    occasion: string
  ): Promise<boolean>;
  forgetKeptDistributionFrame(groupId: string, fingerprint: string): void;
  handleKeptDistributionFrames(onlyGroupId?: string): void;
  releaseFramesWaitingOnKept(groupId: string, trigger: string): void;
  dropKeptFramesOfGroupsNotHeld(namedByARow: ReadonlySet<string>): void;
  keyGroupWaitsOnKeptFrame(groupId: string): boolean;
  deferDistributionEpochCheck(groupId: string, activeEpoch: number): 'deferred';
  verifyDistributionEpoch(groupId: string, activeEpoch: number): Promise<string>;
  catchUpDistributionGroup(groupId: string, target: number): Promise<string>;
  onDistributionFrame(handler: unknown): void;
};

// The MLS state's ledgers, opened as a login opens them: the route reads and keeps frames in them.
beforeEach(() => {
  resetStateLedgersForTests();
  forgetSeenCipherCaches('u');
  hydrateStateLedgers('u', {});
});

/** An in-memory `DistributionGroupStore`, so a test reads back what a registration wrote. */
function makeStore(initial: StoredDistributionGroup[] = []) {
  const rows = new Map(initial.map((r) => [r.groupId, r]));
  return {
    rows,
    saveDistributionGroup: vi.fn(async (entry: StoredDistributionGroup) => {
      rows.set(entry.groupId, entry);
    }),
    getDistributionGroups: vi.fn(async () => [...rows.values()]),
    deleteDistributionGroup: vi.fn(async (groupId: string) => {
      rows.delete(groupId);
    }),
  };
}

const WS = workspaceScope('ws-1');
const SALON = channelScope('ws-1', 'chan-1');

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'u',
    deviceId: 'd',
    delivery: {
      fetchGroupInfo: vi
        .fn()
        .mockResolvedValue({ groupInfo: 'ZGVs', baseEpoch: 3, activeEpoch: 3 }),
      storeGroupInfo: vi.fn().mockResolvedValue({ stored: true }),
      submitCommit: vi.fn(),
    },
    distributionScopeByGroup: new Map<string, DistributionScope>(),
    // The predicate's own store: it answers "is this one", which the scope map cannot answer
    // for a salon whose community this session has not loaded.
    knownDistributionGroups: new Set<string>(),
    // The create window's own store. Empty means "settled", which is the state of every group this
    // device did not create in this test.
    unsettledDistributionGroups: new Set<string>(),
    distributionGroupInfo: {
      fetch: vi.fn().mockResolvedValue({ groupInfo: 'c29j', baseEpoch: 7, activeEpoch: 7 }),
      publish: vi.fn().mockResolvedValue({ stored: true }),
    },
    distributionFrameHandler: vi.fn().mockResolvedValue(undefined),
    runUnderMlsLock: <T>(fn: () => Promise<T>) => fn(),
    getLocalGroups: vi.fn().mockReturnValue([]),
    // The base class's answer: the cache describes the loaded state (Tauri's is its listing).
    heldGroupsKnown: () => true,
    createGroup: vi.fn().mockResolvedValue(undefined),
    exportGroupInfo: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    getEpoch: vi.fn().mockReturnValue(0),
    forgetGroup: vi.fn(),
    externalJoin: vi.fn().mockResolvedValue({ joined: true }),
    processIncomingMessage: vi
      .fn()
      .mockResolvedValue({ plaintext: new Uint8Array([9, 9]), author: 'unsigned' }),
    // The durable half of the registry, and the net that collects what the drain refused - REAL,
    // because registering a group is what drives both.
    distributionGroupStore: null as ReturnType<typeof makeStore> | null,
    heldAtHydration: new Set<string>(),
    isWsOpen: vi.fn().mockReturnValue(true),
    fetchPendingMessages: vi.fn().mockResolvedValue(undefined),
    refetchFramesLeftBehind: proto.refetchFramesLeftBehind,
    collectFramesLeftForKeyGroup: proto.collectFramesLeftForKeyGroup,
    // REAL: a key group is classified OPEN where it is registered, and that is pinned below. The
    // service it asks is a stub - the compiled rule is `admission.realWasm.test.ts`'s subject.
    openAdmissionOfKeyGroup: proto.openAdmissionOfKeyGroup,
    setAdmissionPolicy: vi.fn().mockResolvedValue(undefined),
    persistDistributionGroup: proto.persistDistributionGroup,
    // The route's own halves and the catch-up it runs on an epoch gap - REAL, since which frame is
    // acknowledged and when a gap closes is exactly what these cases pin.
    distributionGapTarget: new Map<string, number>(),
    distributionGapListener: vi.fn(),
    openDistributionFrame: proto.openDistributionFrame,
    dispositionOfUnreadableFrame: proto.dispositionOfUnreadableFrame,
    stepDistributionGroup: proto.stepDistributionGroup,
    closeDistributionGap: proto.closeDistributionGap,
    tellDistributionGapVerdict: proto.tellDistributionGapVerdict,
    evictionTold: new Set<string>(),
    tellEvictedOnce: proto.tellEvictedOnce,
    isGroupActive: vi.fn().mockResolvedValue(true),
    fetchCommitsSince: vi
      .fn()
      .mockResolvedValue({ commits: [], activeEpoch: 0, belowFloor: false }),
    // REAL: with no unresolved commit recorded it settles nothing, which is the case here.
    settleUnresolvedCommitFromLog: proto.settleUnresolvedCommitFromLog,
    // What a replay that applied commits announces (a lost invitation's wake): nothing waits here.
    notifyCommitsApplied: vi.fn(),
    groupsWithPendingCommit: vi.fn(async () => []),
    registerDistributionGroup: proto.registerDistributionGroup,
    // The kept-frame halves of the route - REAL, since what is kept, handled and forgotten is what
    // the section 11 cases pin.
    keptFrameRuns: new Map<string, Promise<boolean>>(),
    keyGroupsWaitingForRoom: new Set<string>(),
    keyGroupsHeldInOrder: new Set<string>(),
    epochChecksHeldByKept: new Map<string, number>(),
    keptFramesFullWarned: false,
    keyGroupWaitsOnKeptFrame: proto.keyGroupWaitsOnKeptFrame,
    deferDistributionEpochCheck: proto.deferDistributionEpochCheck,
    verifyDistributionEpoch: proto.verifyDistributionEpoch,
    catchUpDistributionGroup: proto.catchUpDistributionGroup,
    distributionEpochChecks: new Map(),
    whenGroupDrained: vi.fn().mockResolvedValue(undefined),
    releaseFramesWaitingOnKept: proto.releaseFramesWaitingOnKept,
    dropKeptFramesOfGroupsNotHeld: proto.dropKeptFramesOfGroupsNotHeld,
    distributionGroupFor: proto.distributionGroupFor,
    forgetDistributionGroupById: proto.forgetDistributionGroupById,
    handleKeptDistributionFrame: proto.handleKeptDistributionFrame,
    runKeptDistributionFrame: proto.runKeptDistributionFrame,
    forgetKeptDistributionFrame: proto.forgetKeptDistributionFrame,
    handleKeptDistributionFrames: proto.handleKeptDistributionFrames,
    isDistributionBaseSettled: proto.isDistributionBaseSettled,
    groupInfoChannel: proto.groupInfoChannel,
    // REAL, like `groupInfoChannel`: the create path publishes through the shared publisher, and a
    // stub here would keep this file green while the one implementation drifted.
    exportBaseForPublication: proto.exportBaseForPublication,
    publishCurrentBase: proto.publishCurrentBase,
    ...overrides,
  };
}

const ensure = (
  ctx: Ctx,
  scope: DistributionScope,
  ref: Parameters<typeof proto.ensureDistributionGroup>[1]
) => proto.ensureDistributionGroup.call(ctx, scope, ref);

const route = (ctx: Ctx, groupId: string, sender: string, bytes: Uint8Array) =>
  proto.routeDistributionFrame.call(ctx, groupId, sender, bytes);

describe('the registry', () => {
  it('answers both directions from one map, so the two cannot disagree', () => {
    const ctx = makeCtx();
    proto.registerDistributionGroup.call(ctx, WS, 'g-1');

    expect(proto.isDistributionGroup.call(ctx, 'g-1')).toBe(true);
    expect(proto.isDistributionGroup.call(ctx, 'g-other')).toBe(false);
    expect(proto.distributionGroupFor.call(ctx, WS)).toBe('g-1');
    expect(proto.distributionGroupFor.call(ctx, workspaceScope('ws-other'))).toBeNull();
  });

  it('keeps a salon apart from its own community, though both ids are uuids', () => {
    const ctx = makeCtx();
    proto.registerDistributionGroup.call(ctx, WS, 'g-community');
    proto.registerDistributionGroup.call(ctx, SALON, 'g-salon');

    // The prefix in the key is what makes this true. Without it a lookup by raw id would match
    // whichever entry came first, and a private salon's seed would go out on the community's group.
    expect(proto.distributionGroupFor.call(ctx, WS)).toBe('g-community');
    expect(proto.distributionGroupFor.call(ctx, SALON)).toBe('g-salon');
    expect(proto.distributionGroupFor.call(ctx, channelScope('ws-1', 'chan-2'))).toBeNull();
  });

  it('enumerates every scope it holds, which is what a purge sweeps', () => {
    const ctx = makeCtx();
    proto.registerDistributionGroup.call(ctx, WS, 'g-community');
    proto.registerDistributionGroup.call(ctx, SALON, 'g-salon');

    expect(proto.distributionScopes.call(ctx)).toEqual([WS, SALON]);
  });
});

describe('where a group-info base is read and written', () => {
  it('sends an ordinary group to chat-delivery', async () => {
    const ctx = makeCtx();

    const channel = proto.groupInfoChannel.call(ctx, 'g-plain');
    await channel.fetch();
    await channel.publish('QUFB', 4);

    expect(ctx.delivery.fetchGroupInfo).toHaveBeenCalledWith('g-plain', 'd');
    expect(ctx.delivery.storeGroupInfo).toHaveBeenCalledWith('g-plain', 'QUFB', 4);
    expect(ctx.distributionGroupInfo.fetch).not.toHaveBeenCalled();
  });

  it('sends a distribution group to social-service, keyed by its community', async () => {
    const ctx = makeCtx();
    proto.registerDistributionGroup.call(ctx, WS, 'g-1');

    const channel = proto.groupInfoChannel.call(ctx, 'g-1');
    expect(await channel.fetch()).toEqual({ groupInfo: 'c29j', baseEpoch: 7, activeEpoch: 7 });
    await channel.publish('QUFB', 9);

    // Never chat-delivery: it gates on a `dm_group_members` row this group has none of.
    expect(ctx.delivery.fetchGroupInfo).not.toHaveBeenCalled();
    expect(ctx.delivery.storeGroupInfo).not.toHaveBeenCalled();
    // The publishing DEVICE travels with the base: it is the only way the device that created
    // the group gets onto the group's delivery roster, which the commit fan-out never writes
    // for a creator because a creator sends no commit.
    expect(ctx.distributionGroupInfo.publish).toHaveBeenCalledWith(WS, 'QUFB', 9, 'd');
  });

  it('sends a private salon to the SALON route, not its community one', async () => {
    const ctx = makeCtx();
    proto.registerDistributionGroup.call(ctx, SALON, 'g-salon');

    await proto.groupInfoChannel.call(ctx, 'g-salon').publish('QUFB', 2);

    // The scope travels to social-service, which turns it into the route authorized by
    // `canAccessChannel` rather than by community membership.
    expect(ctx.distributionGroupInfo.publish).toHaveBeenCalledWith(SALON, 'QUFB', 2, 'd');
  });

  it('throws rather than falling back to chat-delivery when no transport is wired', () => {
    const ctx = makeCtx({ distributionGroupInfo: null });
    proto.registerDistributionGroup.call(ctx, WS, 'g-1');

    // Routing it to chat-delivery would produce a 403 that reads like a permission problem and
    // send the next reader to entirely the wrong place. A wiring bug must look like one.
    expect(() => proto.groupInfoChannel.call(ctx, 'g-1')).toThrow(/transport/i);
  });

  it('throws for a key group only NOTED, rather than asking chat-delivery for a base it has not', () => {
    const ctx = makeCtx();
    proto.noteDistributionGroup.call(ctx, 'g-1');

    // chat-delivery would answer 403 - "not a member", the one refusal read as final.
    expect(() => proto.groupInfoChannel.call(ctx, 'g-1')).toThrow(/no scope yet/);
    expect(ctx.delivery.fetchGroupInfo).not.toHaveBeenCalled();
  });
});

describe('joining on first use', () => {
  const REF_PUBLISHED = { groupId: 'g-1', groupInfo: 'c29j', baseEpoch: 7, activeEpoch: 7 };
  const REF_FRESH = { groupId: 'g-1', groupInfo: null, baseEpoch: null, activeEpoch: 0 };

  it('registers the group even when it is already held locally', async () => {
    const ctx = makeCtx({ getLocalGroups: vi.fn().mockReturnValue(['g-1']) });

    expect(await ensure(ctx, WS, REF_PUBLISHED)).toEqual({ joined: true });
    // Registration is not a side effect of joining: the frame router needs it on every start,
    // including the one where there was nothing to join.
    expect(proto.isDistributionGroup.call(ctx, 'g-1')).toBe(true);
    expect(ctx.createGroup).not.toHaveBeenCalled();
    expect(ctx.externalJoin).not.toHaveBeenCalled();
  });

  it('external-joins a published base rather than creating anything', async () => {
    const ctx = makeCtx();

    expect(await ensure(ctx, WS, REF_PUBLISHED)).toEqual({ joined: true });
    // Asking whether a Welcome is owed AFTER the base it builds on (channel-encryption section 20).
    expect(ctx.externalJoin).toHaveBeenCalledWith('g-1', { welcomeOwed: 'ask' });
    expect(ctx.createGroup).not.toHaveBeenCalled();
  });

  it('creates the group and publishes the base when this device is the first one in', async () => {
    const ctx = makeCtx();
    const flushEncrypted = vi.fn(async () => {});
    registerMlsStatePersister({
      markStructural: () => {},
      scheduleDeferred: () => {},
      flushEncrypted,
    } as any);

    try {
      expect(await ensure(ctx, WS, REF_FRESH)).toEqual({ joined: true });
    } finally {
      unregisterMlsStatePersister();
    }
    // Its creator's keys are checkpointed before the base counts as joined.
    expect(flushEncrypted).toHaveBeenCalledTimes(1);
    expect(ctx.createGroup).toHaveBeenCalledWith('g-1');
    expect(ctx.distributionGroupInfo.publish).toHaveBeenCalledWith(WS, expect.any(String), 0, 'd');
    expect(ctx.externalJoin).not.toHaveBeenCalled();
    expect(ctx.forgetGroup).not.toHaveBeenCalled();
  });

  // Third review of #4053: the base was published outside the MLS mutex, with no lead hold, so a
  // session ending between the publish and a checkpoint left a published base whose creator's keys
  // were in memory only. The lead is held from the creation until the checkpoint covers it.
  it('holds the lead from the creation until a checkpoint covers the published base', async () => {
    resetLeadHoldsForTests();
    const ctx = makeCtx();
    const seen: Record<string, number> = {};
    ctx.distributionGroupInfo.publish.mockImplementation(async () => {
      seen.publish = leadHoldsInFlight();
      return { stored: true };
    });
    registerMlsStatePersister({
      markStructural: () => {},
      scheduleDeferred: () => {},
      flushEncrypted: async () => {
        seen.checkpoint = leadHoldsInFlight();
      },
    } as any);

    try {
      expect(await ensure(ctx, WS, REF_FRESH)).toEqual({ joined: true });
    } finally {
      unregisterMlsStatePersister();
    }
    expect(seen).toEqual({ publish: 1, checkpoint: 1 });
    expect(leadHoldsInFlight()).toBe(0);
  });

  it('throws its own group away and joins the winner when it loses the first publish', async () => {
    const ctx = makeCtx();
    ctx.distributionGroupInfo.publish.mockResolvedValue({ stored: false });

    expect(await ensure(ctx, WS, REF_FRESH)).toEqual({ joined: true });
    // Keeping it would fork the community: two MLS groups under one id, each holding half the
    // seeds, with nothing on either side ever reporting it.
    expect(ctx.forgetGroup).toHaveBeenCalledWith('g-1', 0);
    expect(ctx.externalJoin).toHaveBeenCalledWith('g-1', { welcomeOwed: 'ask' });
  });

  it('discards a group whose base could not be published at all', async () => {
    const ctx = makeCtx();
    ctx.distributionGroupInfo.publish.mockRejectedValue(new Error('offline'));

    expect(await ensure(ctx, WS, REF_FRESH)).toEqual({ joined: false, reason: 'unreachable' });
    // A group held locally that nobody can join is worse than no group: the next call would find
    // it in `getLocalGroups` and return early, for ever.
    expect(ctx.forgetGroup).toHaveBeenCalledWith('g-1', 0);
  });
});

describe('the window between creating a group and learning whether it survives', () => {
  const REF_FRESH = { groupId: 'g-1', groupInfo: null, baseEpoch: null, activeEpoch: 0 };
  const settled = (ctx: Ctx) => proto.isDistributionBaseSettled.call(ctx, 'g-1');

  it('reports the group UNSETTLED while the base is being published', async () => {
    const ctx = makeCtx();
    let duringPublish: boolean | null = null;
    // Observed from inside the publish, which is the only moment the window is open. Sampling it
    // before or after would pass against the defect this exists to prevent.
    ctx.distributionGroupInfo.publish.mockImplementation(() => {
      duringPublish = settled(ctx);
      return Promise.resolve({ stored: true });
    });

    await ensure(ctx, WS, REF_FRESH);

    // A sender reading `true` here mints a Graine session against a group that may be discarded a
    // moment later, and whatever it seals is then unreadable by everyone including its author.
    expect(duringPublish).toBe(false);
  });

  it('settles the group once its base has won', async () => {
    const ctx = makeCtx();

    expect(await ensure(ctx, WS, REF_FRESH)).toEqual({ joined: true });
    expect(settled(ctx)).toBe(true);
  });

  it('settles again after losing the race, rather than refusing the scope for ever', async () => {
    const ctx = makeCtx();
    ctx.distributionGroupInfo.publish.mockResolvedValue({ stored: false });

    await ensure(ctx, WS, REF_FRESH);
    // The mark describes a window, not a verdict on the group: left behind, it would go on
    // refusing every send for the scope this device just successfully joined.
    expect(settled(ctx)).toBe(true);
  });

  it('settles again when the publish threw, so a transport failure strands nothing', async () => {
    const ctx = makeCtx();
    ctx.distributionGroupInfo.publish.mockRejectedValue(new Error('offline'));

    await ensure(ctx, WS, REF_FRESH);
    expect(settled(ctx)).toBe(true);
  });

  it('leaves a group it merely JOINED settled throughout - there was never a race', async () => {
    const ctx = makeCtx();
    let duringJoin: boolean | null = null;
    ctx.externalJoin.mockImplementation(() => {
      duringJoin = settled(ctx);
      return Promise.resolve({ joined: true });
    });

    await ensure(ctx, WS, { groupId: 'g-1', groupInfo: 'YmFzZQ==', baseEpoch: 2, activeEpoch: 2 });

    // A published base IS the arbitration; making a joiner wait for one would be inventing a
    // window where none exists.
    expect(duringJoin).toBe(true);
  });
});

describe('routing a frame that arrived on the group', () => {
  function registered(overrides: Record<string, unknown> = {}) {
    const ctx = makeCtx(overrides);
    proto.registerDistributionGroup.call(ctx, WS, 'g-1');
    return ctx;
  }

  it('hands the decrypted payload to the Graine handler and acknowledges', async () => {
    const ctx = registered();

    expect(await route(ctx, 'g-1', 'peer', new Uint8Array([1]))).toBe(true);
    expect(ctx.distributionFrameHandler).toHaveBeenCalledWith({
      scope: WS,
      workspaceId: 'ws-1',
      groupId: 'g-1',
      sender: 'peer',
      plaintext: new Uint8Array([9, 9]),
    });
  });

  it('hands the sending DEVICE over too, which a seed answer is addressed to (section 23)', async () => {
    const ctx = registered();

    await proto.routeDistributionFrame.call(
      ctx as never,
      'g-1',
      'peer',
      new Uint8Array([1]),
      'peer-phone'
    );

    expect(ctx.distributionFrameHandler).toHaveBeenCalledWith(
      expect.objectContaining({ sender: 'peer', senderDeviceId: 'peer-phone' })
    );
  });

  it('hands the envelope DEVICE to the sender check, so a sibling cannot be spoken for', async () => {
    const processIncomingMessage = vi.fn().mockResolvedValue(new Uint8Array([9, 9]));
    const ctx = registered({ processIncomingMessage });

    await proto.routeDistributionFrame.call(
      ctx as never,
      'g-1',
      'peer',
      new Uint8Array([1]),
      'peer-phone'
    );

    expect(processIncomingMessage).toHaveBeenCalledWith(
      'g-1',
      new Uint8Array([1]),
      { userId: 'peer', deviceId: 'peer-phone', path: 'distribution' },
      expect.stringMatching(/^kept-frame:g-1:/)
    );
  });

  describe('the device half of the sender check, through the REAL comparison', () => {
    // The decrypt is stubbed to do what the engine does: OpenMLS verified `peer:peer-phone`, and the
    // envelope this route hands over is compared with it by the one `assertVerifiedSender`.
    async function verifyingCtx() {
      const { assertVerifiedSender, resetReportedSenderMismatches } =
        await import('$lib/mls-client/verifiedSender');
      resetReportedSenderMismatches();
      return registered({
        processIncomingMessage: vi.fn(
          async (
            groupId: string,
            _bytes: Uint8Array,
            envelope: Parameters<typeof assertVerifiedSender>[1]
          ) => {
            assertVerifiedSender(groupId, envelope, 'peer:peer-phone');
            return { plaintext: new Uint8Array([9, 9]), author: 'unsigned' };
          }
        ),
      });
    }

    it('files the seed when the envelope names the device MLS verified', async () => {
      const ctx = await verifyingCtx();

      expect(
        await proto.routeDistributionFrame.call(
          ctx as never,
          'g-1',
          'peer',
          new Uint8Array([1]),
          'peer-phone'
        )
      ).toBe(true);
      expect(ctx.distributionFrameHandler).toHaveBeenCalledWith(
        expect.objectContaining({ sender: 'peer', senderDeviceId: 'peer-phone' })
      );
    });

    it('REFUSES a sibling device speaking in its name: acknowledged, consumed, filed nowhere', async () => {
      const { frameFingerprint, hasFrameBeenProcessed } =
        await import('$lib/mls-client/inboundFrameLedger');
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const frame = new Uint8Array([4, 2]);
      const ctx = await verifyingCtx();
      resetKeyGroupFrameLosses();

      // Same USER, another DEVICE: before this check, the frame was filed as `peer-tablet`'s.
      expect(
        await proto.routeDistributionFrame.call(ctx as never, 'g-1', 'peer', frame, 'peer-tablet')
      ).toBe(true);

      expect(ctx.distributionFrameHandler).not.toHaveBeenCalled();
      expect(hasFrameBeenProcessed('g-1', frameFingerprint(frame))).toBe(true);
      expect(error).toHaveBeenCalledWith(
        expect.stringMatching(/SENDER MISMATCH \(device\).*path=distribution/)
      );
      // A refusal for its sender is not a LOST seed: the next seed request must not print it as one.
      expect(describeKeyGroupFrameLosses('g-1')).toBe('none');
      error.mockRestore();
      warn.mockRestore();
    });

    it('accepts a frame with NO device on its envelope, as an old sender delivers it', async () => {
      // A client that never sent `senderDeviceId`, or a stored row read back empty, compares the
      // user alone - exactly as before this check existed.
      const ctx = await verifyingCtx();

      expect(await route(ctx, 'g-1', 'peer', new Uint8Array([1]))).toBe(true);
      expect(ctx.processIncomingMessage).toHaveBeenCalledWith(
        'g-1',
        new Uint8Array([1]),
        { userId: 'peer', path: 'distribution' },
        expect.stringMatching(/^kept-frame:g-1:/)
      );
      expect(ctx.distributionFrameHandler).toHaveBeenCalledWith(
        expect.objectContaining({ sender: 'peer', plaintext: new Uint8Array([9, 9]) })
      );
    });
  });

  it('counts a frame lost for good, by cause, for the seed requests that follow to print', async () => {
    // F3 of the 2026-10-12 queue audit: a request line names what is missing and could not say why.
    resetKeyGroupFrameLosses();
    const ctx = registered({
      processIncomingMessage: vi
        .fn()
        .mockRejectedValue(
          new Error('Process error: past epoch application frame [msg_epoch=8, group_epoch=20]')
        ),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(await route(ctx, 'g-1', 'peer', new Uint8Array([1]))).toBe(true);

    expect(describeKeyGroupFrameLosses('g-1')).toBe('past-epoch-application:1');
    warn.mockRestore();
  });

  it('acknowledges a commit without involving the handler', async () => {
    const ctx = registered({ processIncomingMessage: vi.fn().mockResolvedValue(null) });

    // A commit advanced the MLS state and carries no payload. Replaying it would only be refused.
    expect(await route(ctx, 'g-1', 'peer', new Uint8Array([1]))).toBe(true);
    expect(ctx.distributionFrameHandler).not.toHaveBeenCalled();
  });

  it('clears an epoch gap when a commit applies, the only exit this group has', async () => {
    // THE MARK HAD NO CLEARER AND NO ESCALATOR. A refused commit (`catchUpOnRefusedCommit`) is the
    // only thing that can put this group in the gap registry, and the pipeline branches here BEFORE
    // both of the sites that call `clearEpochGap` - so the mark stood for the rest of the session
    // over state that had long since caught up, holding `anyEpochGapArmed` true and the sync
    // watchdog on its five-second tick with it.
    resetEpochGapRegistry();
    markEpochGap('g-1');
    const ctx = registered({ processIncomingMessage: vi.fn().mockResolvedValue(null) });

    expect(await route(ctx, 'g-1', 'peer', new Uint8Array([1]))).toBe(true);

    expect(isInEpochGap('g-1')).toBe(false);
  });

  it('leaves the mark alone for a frame that merely DECRYPTS', async () => {
    // An application message that opens proves nothing about the epoch - typically a peer on the
    // same stale branch. Only a commit moves the group, which is why the conversation side clears
    // on `isCommit` and not on a successful read.
    resetEpochGapRegistry();
    markEpochGap('g-1');
    const ctx = registered();

    expect(await route(ctx, 'g-1', 'peer', new Uint8Array([1]))).toBe(true);

    expect(isInEpochGap('g-1')).toBe(true);
    resetEpochGapRegistry();
  });

  it('does NOT acknowledge a frame it cannot decrypt yet', async () => {
    const ctx = registered({
      processIncomingMessage: vi.fn().mockRejectedValue(new Error('unknown epoch')),
    });

    // The join has not landed. Acknowledging would drop a seed nobody can ask for again.
    expect(await route(ctx, 'g-1', 'peer', new Uint8Array([1]))).toBe(false);
  });

  it('ACKNOWLEDGES a frame that can never be decrypted, whatever made it permanent', async () => {
    // Measured on prod 2026-08-19: refusing every failure alike meant six frames were re-read on
    // every connection for ever - including this device's OWN seeds, which OpenMLS refuses by
    // construction. A redelivery cannot repair any of these; only a peer answering a history
    // request can, and that is a different mechanism entirely.
    const permanent = [
      'Process error: past epoch application frame [msg_epoch=8, group_epoch=20]',
      'CannotDecryptOwnMessage',
      'SecretReuseError',
      'TooDistantInTheFuture',
      // THE ONE THAT WAS MISSING, and the only one on this list that is not about the ratchet.
      // `mls-core` compares the frame's epoch with the group's before it attempts anything, so
      // reaching the residue means they MATCHED - and an epoch's tree is fixed once the epoch
      // exists. Prod 2026-08-26: a refusal at epoch 0 on two distribution groups read as `unknown`,
      // was refused an ACK on the argument that it might still become readable, and came back on
      // every connection for ever - eleven cells of the COMM rung, from one frame.
      'Process error: same-epoch refusal ValidationError(InvalidSignature) [msg_epoch=0, group_epoch=0]',
    ];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const message of permanent) {
      const ctx = registered({
        processIncomingMessage: vi.fn().mockRejectedValue(new Error(message)),
      });
      expect(await route(ctx, 'g-1', 'peer', new Uint8Array([1]))).toBe(true);
      // Acknowledged is not silent: a seed genuinely lost here is worth exactly one line.
      expect(ctx.distributionFrameHandler).not.toHaveBeenCalled();
    }
    expect(warn).toHaveBeenCalledTimes(permanent.length);
    warn.mockRestore();
  });

  it('acknowledges a frame refused for its SENDER, records it consumed, and hands it to nobody', async () => {
    // WP-G2-1b: the frame decrypted, so its generation is spent - but its envelope named somebody
    // MLS did not verify, so the seed it carries is never filed. Redelivery would bring the same lie.
    const { SenderMismatchError } = await import('$lib/mls-client/verifiedSender');
    const { frameFingerprint, hasFrameBeenProcessed } =
      await import('$lib/mls-client/inboundFrameLedger');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const frame = new Uint8Array([7, 7, 7]);
    const ctx = registered({
      processIncomingMessage: vi.fn().mockRejectedValue(new SenderMismatchError('g-1', 'user')),
    });

    expect(await route(ctx, 'g-1', 'mallory', frame)).toBe(true);
    expect(ctx.distributionFrameHandler).not.toHaveBeenCalled();
    expect(hasFrameBeenProcessed('g-1', frameFingerprint(frame))).toBe(true);
    // Accused once, at ERROR, where it was refused - not again here as a lost seed.
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('still redelivers what a later epoch may repair', async () => {
    // `GAP_QUEUED` WITHOUT the same-epoch marker: the native layer wraps what it does not
    // recognise, and a genuine gap is the one thing on this whole path a redelivery does repair.
    const recoverable = ['GAP_QUEUED:g-1:missing commit', 'WrongEpoch', 'something new'];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const message of recoverable) {
      const ctx = registered({
        processIncomingMessage: vi.fn().mockRejectedValue(new Error(message)),
      });
      expect(await route(ctx, 'g-1', 'peer', new Uint8Array([1]))).toBe(false);
    }
    warn.mockRestore();
  });

  it('does NOT acknowledge, and says so loudly, when no handler is wired', async () => {
    const ctx = registered({ distributionFrameHandler: null });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await route(ctx, 'g-1', 'peer', new Uint8Array([1]))).toBe(false);
    // The only other symptom of a handler never wired is a community whose history quietly never
    // loads, weeks later, with nothing to point at.
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  // Production 1.5.1: a handler that could not reach the server was logged as a refusal, at error.
  it('keeps a frame its handler could not handle for lack of an answer, said as no answer', async () => {
    const ctx = registered({
      distributionFrameHandler: vi.fn(async () => {
        throw new TransportFailureError(new TypeError('Failed to fetch'));
      }),
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(await route(ctx, 'g-1', 'peer', new Uint8Array([1]))).toBe(false);
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('got no answer'));
    error.mockRestore();
    warn.mockRestore();
  });

  it('control: a handler that REFUSES a frame for another cause is a failed run, not an absent link', async () => {
    const ctx = registered({
      distributionFrameHandler: vi.fn(async () => {
        throw new Error('seed store refused');
      }),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(await route(ctx, 'g-1', 'peer', new Uint8Array([1]))).toBe(false);
    // Counted in the kept value and climbing to error from the third run (section 11's cases).
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('handler refused a frame'),
      expect.stringContaining('seed store refused')
    );
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('got no answer'));
    warn.mockRestore();
  });

  it('refuses a group it has no community for', async () => {
    const ctx = makeCtx();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(await route(ctx, 'g-unknown', 'peer', new Uint8Array([1]))).toBe(false);
    expect(ctx.processIncomingMessage).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

/**
 * The classification is DEVICE STATE, known before the first drain (production, 2026-09-28).
 *
 * The registry used to live in memory only, filled by the community loop - which `setIsLoggedIn`
 * starts without awaiting, while the gateway drains the whole queue a few hundred milliseconds
 * later. A key group registered after the drain had every frame refused as `absent-conversation`,
 * a reason only a conversation appearing discharges - which a key group never has. Measured: 51
 * frames refused on every load of one device, eight epochs of commits among them.
 */
describe('the durable registry', () => {
  beforeEach(() => resetUnackedFrames());

  function wired(initial: StoredDistributionGroup[] = [], overrides: Record<string, unknown> = {}) {
    const store = makeStore(initial);
    const ctx = makeCtx(overrides);
    ctx.distributionGroupStore = store;
    return { ctx, store };
  }

  it('writes a registration the first time, and not again for the same scope', async () => {
    const { ctx, store } = wired();

    proto.registerDistributionGroup.call(ctx, SALON, 'g-1');
    proto.registerDistributionGroup.call(ctx, SALON, 'g-1');
    await Promise.resolve();

    // The community loop re-registers every group on every load; a write each time is a write for
    // nothing.
    expect(store.saveDistributionGroup).toHaveBeenCalledTimes(1);
    expect(store.rows.get('g-1')).toEqual({
      groupId: 'g-1',
      workspaceId: 'ws-1',
      channelId: 'chan-1',
    });
  });

  it('writes again when the scope CHANGED, since the row would otherwise route to the old one', async () => {
    const { ctx, store } = wired();

    proto.registerDistributionGroup.call(ctx, WS, 'g-1');
    proto.registerDistributionGroup.call(ctx, SALON, 'g-1');
    await Promise.resolve();

    expect(store.saveDistributionGroup).toHaveBeenCalledTimes(2);
    expect(store.rows.get('g-1')?.channelId).toBe('chan-1');
  });

  it('does not store a group the server merely NOTED, whose roster it cannot name', () => {
    const { ctx, store } = wired();

    proto.noteDistributionGroup.call(ctx, 'g-1');

    expect(store.saveDistributionGroup).not.toHaveBeenCalled();
  });

  it('deletes the row when the group is forgotten', async () => {
    const { ctx, store } = wired([], {
      getLocalGroups: vi.fn().mockReturnValue(['g-1']),
      persistCheckpoint: vi.fn().mockResolvedValue(undefined),
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    proto.registerDistributionGroup.call(ctx, WS, 'g-1');

    expect(
      await proto.forgetDistributionGroupById.call(ctx, 'g-1', 'distribution group left')
    ).toBe(true);

    expect(store.deleteDistributionGroup).toHaveBeenCalledWith('g-1');
    expect(store.rows.has('g-1')).toBe(false);
    log.mockRestore();
  });

  it('prints the reason its caller states, never a fixed one', async () => {
    const { ctx } = wired([], {
      getLocalGroups: vi.fn().mockReturnValue(['g-1', 'g-2']),
      persistCheckpoint: vi.fn().mockResolvedValue(undefined),
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await proto.forgetDistributionGroupById.call(ctx, 'g-1', 'absent from server');
    await proto.forgetDistributionGroupById.call(ctx, 'g-2', 'distribution group left');

    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('g-1') && l.includes('(absent from server,'))).toBe(true);
    expect(lines.some((l) => l.includes('g-2') && l.includes('(distribution group left,'))).toBe(
      true
    );
    log.mockRestore();
  });

  it('keeps the session registration when the store refuses the write, and says so', async () => {
    const { ctx, store } = wired();
    store.saveDistributionGroup.mockRejectedValueOnce(new Error('quota'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    proto.registerDistributionGroup.call(ctx, WS, 'g-1');
    await flushMacrotask();

    expect(proto.isDistributionGroup.call(ctx, 'g-1')).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('registered but not stored'),
      'Error: quota'
    );
    warn.mockRestore();
  });

  it('restores every row whose tree is held, before anything registers it', async () => {
    const { ctx, store } = wired(
      [
        { groupId: 'g-community', workspaceId: 'ws-1', channelId: null },
        { groupId: 'g-salon', workspaceId: 'ws-1', channelId: 'chan-1' },
      ],
      { getLocalGroups: vi.fn().mockReturnValue(['g-community', 'g-salon']) }
    );

    await proto.hydrateDistributionGroups.call(ctx);

    expect(proto.isDistributionGroup.call(ctx, 'g-community')).toBe(true);
    expect(proto.distributionGroupFor.call(ctx, WS)).toBe('g-community');
    expect(proto.distributionGroupFor.call(ctx, SALON)).toBe('g-salon');
    // Restoring is not news: nothing is written back.
    expect(store.saveDistributionGroup).not.toHaveBeenCalled();
  });

  it('deletes a row whose tree is gone rather than believing it - the allowlist is the MLS state', async () => {
    const { ctx, store } = wired(
      [
        { groupId: 'g-held', workspaceId: 'ws-1', channelId: null },
        { groupId: 'g-gone', workspaceId: 'ws-2', channelId: null },
      ],
      { getLocalGroups: vi.fn().mockReturnValue(['g-held']) }
    );

    await proto.hydrateDistributionGroups.call(ctx);

    expect(proto.isDistributionGroup.call(ctx, 'g-gone')).toBe(false);
    expect(store.deleteDistributionGroup).toHaveBeenCalledWith('g-gone');
    expect([...store.rows.keys()]).toEqual(['g-held']);
  });

  it('says so at error level when no store is wired or the store cannot be read', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await proto.hydrateDistributionGroups.call(makeCtx());
    const { ctx, store } = wired();
    store.getDistributionGroups.mockRejectedValueOnce(new Error('closed'));
    await proto.hydrateDistributionGroups.call(ctx);

    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  it('routes a drained frame to the seed handler once hydrated, with no community loaded', async () => {
    // The production order: the drain runs before the community loop reaches this group. With the
    // row restored first, the frame takes the key-group branch instead of the conversation one.
    const { ctx } = wired([{ groupId: 'g-1', workspaceId: 'ws-1', channelId: null }], {
      getLocalGroups: vi.fn().mockReturnValue(['g-1']),
    });
    await proto.hydrateDistributionGroups.call(ctx);

    expect(await route(ctx, 'g-1', 'peer', new Uint8Array([1]))).toBe(true);
    expect(ctx.distributionFrameHandler).toHaveBeenCalledWith(
      expect.objectContaining({ scope: WS, groupId: 'g-1' })
    );
  });

  it('answers a seed REQUEST arriving inside the boot drain, from the restored scope', async () => {
    const plaintext = new TextEncoder().encode('{"kind":"seed-request"}');
    const { ctx } = wired([{ groupId: 'g-salon', workspaceId: 'ws-1', channelId: 'chan-1' }], {
      getLocalGroups: vi.fn().mockReturnValue(['g-salon']),
      processIncomingMessage: vi.fn().mockResolvedValue({ plaintext, author: 'unsigned' }),
    });
    await proto.hydrateDistributionGroups.call(ctx);

    expect(await route(ctx, 'g-salon', 'peer', new Uint8Array([1]))).toBe(true);
    expect(ctx.distributionFrameHandler).toHaveBeenCalledWith(
      expect.objectContaining({ scope: SALON, workspaceId: 'ws-1', plaintext })
    );
  });
});

// A KEY GROUP IS CLASSIFIED OPEN WHERE IT IS REGISTERED, which is always before it is joined or
// created. A group a conversation's rule closed would refuse every newcomer of a community, so this
// is the half of the admission rule that must never be missing for a key group.
describe('registering a key group opens it for the admission rule', () => {
  beforeEach(() => resetUnackedFrames());

  it('classifies the group open when a scope names it', () => {
    const ctx = makeCtx();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    proto.registerDistributionGroup.call(ctx, WS, 'g-open');

    expect(ctx.setAdmissionPolicy).toHaveBeenCalledWith('g-open', 'open');
    log.mockRestore();
  });

  it('classifies a group the server named without a scope open too', () => {
    const ctx = makeCtx();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    proto.noteDistributionGroup.call(ctx, 'g-noted');

    expect(ctx.setAdmissionPolicy).toHaveBeenCalledWith('g-noted', 'open');
    log.mockRestore();
  });

  it('says so at WARN when it cannot, and the registration still completes', async () => {
    const ctx = makeCtx();
    ctx.setAdmissionPolicy = vi.fn().mockRejectedValue(new Error('wasm not ready'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(() => proto.registerDistributionGroup.call(ctx, WS, 'g-late')).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('stays unclassified'));
    warn.mockRestore();
    log.mockRestore();
  });
});

describe('registering a key group collects what the drain refused for it', () => {
  beforeEach(() => resetUnackedFrames());

  it('re-fetches the frames refused as absent-conversation, in ONE pull', () => {
    const ctx = makeCtx();
    noteUnackedFrame('g-1', 'absent-conversation');
    noteUnackedFrame('g-1', 'absent-conversation');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    proto.registerDistributionGroup.call(ctx, WS, 'g-1');

    expect(ctx.fetchPendingMessages).toHaveBeenCalledTimes(1);
    expect(takeGroupsAwaiting('absent-conversation')).toEqual([]);
    log.mockRestore();
  });

  it('collects a frame kept for its roster once the scope is named, in the same pull', () => {
    const ctx = makeCtx();
    noteUnackedFrame('g-1', 'absent-conversation');
    noteUnackedFrame('g-1', 'unscoped-distribution-group');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    proto.registerDistributionGroup.call(ctx, SALON, 'g-1');

    expect(ctx.fetchPendingMessages).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('absent-conversation + unscoped-distribution-group')
    );
    log.mockRestore();
  });

  it('leaves a roster-less frame waiting when the server only NOTED the group', () => {
    const ctx = makeCtx();
    noteUnackedFrame('g-1', 'unscoped-distribution-group');

    proto.noteDistributionGroup.call(ctx, 'g-1');

    // Its roster is still unknown, so re-fetching it would only refuse it again.
    expect(ctx.fetchPendingMessages).not.toHaveBeenCalled();
    expect(takeGroupsAwaiting('unscoped-distribution-group')).toEqual(['g-1']);
  });

  it('touches no other group, and pulls nothing when nothing waits', () => {
    const ctx = makeCtx();
    noteUnackedFrame('g-other', 'absent-conversation');

    proto.registerDistributionGroup.call(ctx, WS, 'g-1');

    expect(ctx.fetchPendingMessages).not.toHaveBeenCalled();
    expect(takeGroupsAwaiting('absent-conversation')).toEqual(['g-other']);
  });

  it('ACCUSES the durable half when a group held at start-up still needed the net', async () => {
    const ctx = makeCtx({ getLocalGroups: vi.fn().mockReturnValue(['g-1']) });
    ctx.distributionGroupStore = makeStore();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Held, but the store has no row for it: the durable half missed it.
    await proto.hydrateDistributionGroups.call(ctx);
    noteUnackedFrame('g-1', 'absent-conversation');

    proto.registerDistributionGroup.call(ctx, WS, 'g-1');

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('was held at start-up'));
    log.mockRestore();
    warn.mockRestore();
  });

  it('accuses nothing for a group first joined in this session', () => {
    const ctx = makeCtx();
    noteUnackedFrame('g-new', 'absent-conversation');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    proto.registerDistributionGroup.call(ctx, WS, 'g-new');

    expect(warn).not.toHaveBeenCalled();
    log.mockRestore();
    warn.mockRestore();
  });

  it('notes a frame for a group whose roster is not named, so the registration can collect it', async () => {
    const ctx = makeCtx();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    proto.noteDistributionGroup.call(ctx, 'g-1');

    expect(await route(ctx, 'g-1', 'peer', new Uint8Array([1]))).toBe(false);

    expect(takeGroupsAwaiting('unscoped-distribution-group')).toEqual(['g-1']);
    warn.mockRestore();
  });
});

/**
 * A HELD key group is compared with the server's epoch once the drain settles (production,
 * 2026-09-28: a device frozen at epoch 4 of a key group the server had at 15, reloading into the same
 * freeze for a day because `activeEpoch` was read on every load and compared with nothing).
 */
describe('a held key group behind its server', () => {
  const proto2 = BaseMlsService.prototype as unknown as {
    verifyDistributionEpoch(groupId: string, activeEpoch: number): Promise<string>;
    whenDistributionEpochSettled(groupId: string): Promise<void>;
    catchUpDistributionGroup(groupId: string, target: number): Promise<string>;
  };

  /** A tree at `epoch`, a commit log that can move it, and a drain the test settles by hand. */
  function behind(epoch: number, log: { baseEpoch: number }[], serverEpoch: number) {
    const tree = { epoch };
    let settle!: () => void;
    const drained = new Promise<void>((r) => {
      settle = r;
    });
    const listener = vi.fn();
    const ctx = makeCtx({
      getLocalGroups: vi.fn().mockReturnValue(['g-1']),
      getEpoch: vi.fn(() => tree.epoch),
      // Applying a commit moves the tree one epoch, which is all a replay needs to be true about.
      processIncomingMessage: vi.fn(async () => {
        tree.epoch += 1;
        return null;
      }),
      fetchCommitsSince: vi.fn(async () => ({
        commits: log.map((c) => ({ ...c, proto: 'AA==' })),
        activeEpoch: serverEpoch,
        belowFloor: false,
      })),
      // The drain of THIS link (a pull listed the whole mailbox since the socket opened, and the
      // group's share of it applied) - never the boot's, which a resume leaves hours old.
      whenGroupDrained: vi.fn(() => drained),
      distributionEpochChecks: new Map(),
      distributionGapListener: listener,
      catchUpDistributionGroup: (proto2 as { catchUpDistributionGroup: unknown })
        .catchUpDistributionGroup,
    });
    return { ctx, tree, settle, listener };
  }

  beforeEach(() => resetEpochGapRegistry());

  it('decides nothing before the drain has settled - the commits may still be in the queue', async () => {
    const { ctx } = behind(4, [{ baseEpoch: 4 }], 5);
    const verdict = proto2.verifyDistributionEpoch.call(ctx, 'g-1', 5);
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(ctx.fetchCommitsSince).not.toHaveBeenCalled();
    expect(isInEpochGap('g-1')).toBe(false);
    // The drain of THIS group on THIS link, not the boot's (2026-11-04: a resume left it hours old).
    expect((ctx as unknown as { whenGroupDrained: unknown }).whenGroupDrained).toHaveBeenCalledWith(
      'g-1'
    );
    void verdict;
  });

  it('answers current, and touches nothing, when the drain caught the group up', async () => {
    const { ctx, tree, settle } = behind(4, [], 5);
    const verdict = proto2.verifyDistributionEpoch.call(ctx, 'g-1', 5);
    tree.epoch = 5; // the queued commits applied during the drain
    settle();

    expect(await verdict).toBe('current');
    expect(ctx.fetchCommitsSince).not.toHaveBeenCalled();
  });

  it('replays what was never queued, holding the gap for the whole catch-up, then says so', async () => {
    const { ctx, tree, settle, listener } = behind(4, [{ baseEpoch: 4 }, { baseEpoch: 5 }], 6);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let armedDuringReplay = false;
    ctx.processIncomingMessage.mockImplementation(async () => {
      armedDuringReplay ||= isInEpochGap('g-1');
      tree.epoch += 1;
      return null;
    });
    const verdict = proto2.verifyDistributionEpoch.call(ctx, 'g-1', 6);
    settle();

    expect(await verdict).toBe('caught-up');
    expect(tree.epoch).toBe(6);
    // Nothing may be sealed at epoch 4 or 5 while this runs - that is what the mark is for.
    expect(armedDuringReplay).toBe(true);
    expect(isInEpochGap('g-1')).toBe(false);
    expect(listener).toHaveBeenCalledWith('g-1', 'caught-up');
    log.mockRestore();
    warn.mockRestore();
  });

  it('says EXHAUSTED when the log cannot supply the commits, and leaves the gap armed', async () => {
    const { ctx, settle, listener } = behind(4, [], 9);
    ctx.fetchCommitsSince.mockResolvedValue({ commits: [], activeEpoch: 9, belowFloor: true });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const verdict = proto2.verifyDistributionEpoch.call(ctx, 'g-1', 9);
    settle();

    expect(await verdict).toBe('replay-exhausted');
    expect(isInEpochGap('g-1')).toBe(true);
    // Rung 2 is owed NOW; the listener is what re-joins, through the loader.
    expect(listener).toHaveBeenCalledWith('g-1', 'replay-exhausted');
    log.mockRestore();
    warn.mockRestore();
  });

  it('holds a request about the group until its check has answered', async () => {
    const { ctx, tree, settle } = behind(4, [], 5);
    const verdict = proto2.verifyDistributionEpoch.call(ctx, 'g-1', 5);
    let through = false;
    const waiting = proto2.whenDistributionEpochSettled.call(ctx, 'g-1').then(() => {
      through = true;
    });
    await Promise.resolve();
    expect(through).toBe(false);

    tree.epoch = 5;
    settle();
    await verdict;
    await waiting;
    expect(through).toBe(true);
  });
});

describe('a frame from an epoch this device has not reached', () => {
  beforeEach(() => resetEpochGapRegistry());

  /**
   * Production 2026-09-28: a key group at epoch 4, its queue holding the commits and seeds of
   * epochs 5 to 15 - only the commit 4->5 was missing. 1984 frames were refused as `epoch-gap`, none
   * acknowledged, and nothing caught the group up.
   */
  function gapped() {
    const tree = { epoch: 4 };
    const listener = vi.fn();
    const seed = new Uint8Array([7]);
    const ctx = makeCtx({
      getLocalGroups: vi.fn().mockReturnValue(['g-1']),
      getEpoch: vi.fn(() => tree.epoch),
      // A seed sealed at epoch 5 opens once the tree is there; a replayed commit moves the tree.
      processIncomingMessage: vi.fn(async (_g: string, bytes: Uint8Array) => {
        if (bytes[0] === 0xcc) {
          tree.epoch += 1;
          return null;
        }
        if (tree.epoch < 5) {
          throw new Error(`Process error: epoch gap [msg_epoch=5, group_epoch=${tree.epoch}]`);
        }
        return { plaintext: seed, author: 'unsigned' };
      }),
      fetchCommitsSince: vi.fn(async () => ({
        commits: [4, 5, 6].map((baseEpoch) => ({ baseEpoch, proto: 'zA==' })), // 0xcc
        activeEpoch: 7,
        belowFloor: false,
      })),
      distributionGapListener: listener,
    });
    proto.registerDistributionGroup.call(ctx, WS, 'g-1');
    return { ctx, tree, listener, seed };
  }

  it('replays ONE commit, opens the frame, and leaves the queue to apply the rest in order', async () => {
    const { ctx, tree, seed } = gapped();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await route(ctx, 'g-1', 'peer', new Uint8Array([1]))).toBe(true);

    // Replaying to the server's 7 would have put every seed of epochs 5 and 6 out of reach
    // (`max_past_epochs` is 2); one step is exactly the hole.
    expect(tree.epoch).toBe(5);
    expect(ctx.distributionFrameHandler).toHaveBeenCalledWith(
      expect.objectContaining({ plaintext: seed })
    );
    // Still behind the server: nothing may be sealed yet.
    expect(isInEpochGap('g-1')).toBe(true);
    log.mockRestore();
  });

  /**
   * THE LIVE FRAME THAT OVERTAKES ITS OWN MAILBOX (tester export, 2026-11-04: nine seeds of one key
   * group lost as `past-epoch-application` during a resume's bulk ingest, no join anywhere). After a
   * reconnect, a seed pushed live at the server's epoch reaches the scheduler before the pull has
   * listed the commits and seeds queued ahead of it. Stepping the log to its epoch put every one of
   * those seeds more than `max_past_epochs` (2) behind, for good.
   */
  describe('stamped as having arrived ahead of the mailbox on this link', () => {
    /** `gapped()` plus the real hold. The STAMP is what decides, never the link read now. */
    function liveGapped(link: { pulling?: Promise<void> | null } = {}) {
      const g = gapped();
      Object.assign(g.ctx, {
        // Listed by now - which is exactly the moment the stamp exists for: the pull that listed
        // the mailbox may have ended before this frame, ahead of its rows, is handled.
        mailboxEmptiedByAPull: true,
        pendingPullInFlight: link.pulling ?? null,
        liveHeldKeyGroups: new Map<string, number>(),
        holdLiveKeyGroupFrame: (
          BaseMlsService.prototype as unknown as { holdLiveKeyGroupFrame(g: string): void }
        ).holdLiveKeyGroupFrame,
      });
      return g;
    }
    const routeAhead = (ctx: Ctx, bytes: Uint8Array, ahead = true) =>
      proto.routeDistributionFrame.call(ctx, 'g-1', 'peer', bytes, 'peer-phone', ahead);

    it('steps NO commit, leaves the frame unacknowledged, and pulls the mailbox in order', async () => {
      const { ctx, tree } = liveGapped();
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

      expect(await routeAhead(ctx, new Uint8Array([1]))).toBe(false);
      await flushMacrotask();

      expect(tree.epoch).toBe(4);
      expect(ctx.fetchCommitsSince).not.toHaveBeenCalled();
      expect(ctx.distributionFrameHandler).not.toHaveBeenCalled();
      expect(ctx.fetchPendingMessages).toHaveBeenCalledTimes(1);
      log.mockRestore();
    });

    it('asks the pull for its key group on every frame, and counts the burst for the line it prints', async () => {
      // ONE pull for the burst is the single-flight rule of `fetchPendingMessages` itself (asked
      // while a pull fetches, it is owed and issued once) - `BaseMlsService.singleFlightPull.test.ts`.
      const { ctx } = liveGapped({ pulling: new Promise<void>(() => undefined) });
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

      await routeAhead(ctx, new Uint8Array([1]));
      await routeAhead(ctx, new Uint8Array([1]));
      await flushMacrotask();

      expect(ctx.fetchPendingMessages).toHaveBeenCalledTimes(2);
      expect(ctx.fetchPendingMessages).toHaveBeenCalledWith(['g-1']);
      expect(
        (ctx as unknown as { liveHeldKeyGroups: Map<string, number> }).liveHeldKeyGroups
      ).toEqual(new Map([['g-1', 2]]));
      log.mockRestore();
    });

    it('steps as before a frame NOT stamped - pulled, or live after the listing: the commits really are missing', async () => {
      const { ctx, tree } = liveGapped();
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

      expect(await routeAhead(ctx, new Uint8Array([1]), false)).toBe(true);

      expect(tree.epoch).toBe(5);
      expect(ctx.fetchPendingMessages).not.toHaveBeenCalled();
      log.mockRestore();
    });
  });

  it('hands the envelope device to the RETRY as well, so a step cannot drop the check', async () => {
    const { ctx } = gapped();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await proto.routeDistributionFrame.call(
      ctx as never,
      'g-1',
      'peer',
      new Uint8Array([1]),
      'peer-phone'
    );

    const opens = (ctx.processIncomingMessage as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([, bytes]) => (bytes as Uint8Array)[0] === 1
    );
    // The refused first attempt, then the one after the step.
    expect(opens).toHaveLength(2);
    for (const [, , envelope] of opens) {
      expect(envelope).toEqual({ userId: 'peer', deviceId: 'peer-phone', path: 'distribution' });
    }
    log.mockRestore();
  });

  it('keeps the gap through the queued commits and lifts it at the server epoch, saying so', async () => {
    const { ctx, tree, listener } = gapped();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await route(ctx, 'g-1', 'peer', new Uint8Array([1]));

    // The queued commits 5->6 and 6->7 arrive in order.
    await route(ctx, 'g-1', 'peer', new Uint8Array([0xcc]));
    expect(tree.epoch).toBe(6);
    expect(isInEpochGap('g-1')).toBe(true);
    expect(listener).not.toHaveBeenCalled();

    await route(ctx, 'g-1', 'peer', new Uint8Array([0xcc]));
    expect(tree.epoch).toBe(7);
    expect(isInEpochGap('g-1')).toBe(false);
    // What releases the requests held while it was behind.
    expect(listener).toHaveBeenCalledWith('g-1', 'caught-up');
    log.mockRestore();
  });

  it('does not acknowledge the frame when the log cannot move the group, and says it is exhausted', async () => {
    const { ctx, listener } = gapped();
    ctx.fetchCommitsSince.mockResolvedValue({ commits: [], activeEpoch: 7, belowFloor: true });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await route(ctx, 'g-1', 'peer', new Uint8Array([1]))).toBe(false);

    expect(listener).toHaveBeenCalledWith('g-1', 'replay-exhausted');
    log.mockRestore();
  });
});

/**
 * A KEY GROUP'S EVICTION IS A FACT FOR THE LOADER, NOT A DISPOSITION (production 2026-09-28). The
 * user's PC held a state whose leaf its own second join had removed, and every frame on the group
 * was acknowledged as "no repair is owed" for three days.
 */
describe('a key group this device was evicted from', () => {
  beforeEach(() => resetEpochGapRegistry());

  it('acknowledges each frame and tells the listener ONCE for the whole burst', async () => {
    const listener = vi.fn();
    const ctx = makeCtx({
      getLocalGroups: vi.fn().mockReturnValue(['g-1']),
      processIncomingMessage: vi.fn().mockRejectedValue(new Error('EVICTED: g-1')),
      distributionGapListener: listener,
    });
    proto.registerDistributionGroup.call(ctx, WS, 'g-1');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    for (let i = 0; i < 5; i++) {
      expect(await route(ctx, 'g-1', 'peer', new Uint8Array([i]))).toBe(true);
    }

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('g-1', 'evicted');
    warn.mockRestore();
  });

  it('tells it again once the dead state was forgotten - the next eviction is a new fact', () => {
    const ctx = makeCtx({ distributionGapListener: vi.fn() });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    proto.tellEvictedOnce.call(ctx, 'g-1');
    ctx.evictionTold.delete('g-1');
    proto.tellEvictedOnce.call(ctx, 'g-1');

    expect(ctx.distributionGapListener).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('reads a replay stopped on an inactive tree as an eviction, from the fact and not the message', async () => {
    const listener = vi.fn();
    const ctx = makeCtx({
      getLocalGroups: vi.fn().mockReturnValue(['g-1']),
      getEpoch: vi.fn().mockReturnValue(5),
      processIncomingMessage: vi.fn().mockRejectedValue(new Error('anything at all')),
      fetchCommitsSince: vi.fn(async () => ({
        commits: [{ baseEpoch: 5, proto: 'AA==' }],
        activeEpoch: 16,
        belowFloor: false,
      })),
      isGroupActive: vi.fn().mockResolvedValue(false),
      distributionGapListener: listener,
    });
    const quiet = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    ];

    const verdict = await (
      proto as unknown as { catchUpDistributionGroup(g: string, t: number): Promise<string> }
    ).catchUpDistributionGroup.call(ctx, 'g-1', 16);

    expect(verdict).toBe('evicted');
    expect(listener).toHaveBeenCalledWith('g-1', 'evicted');
    quiet.forEach((q) => q.mockRestore());
  });

  it('reads a replay that REACHED its target on the commit removing this device as an eviction, not a catch-up', async () => {
    // Measured locally 2026-09-29: "replayed 1 commit(s), epoch 24->25, healed=true" - the Remove
    // applies like any commit, so the epoch alone says caught up.
    let epoch = 24;
    const listener = vi.fn();
    const ctx = makeCtx({
      getLocalGroups: vi.fn().mockReturnValue(['g-1']),
      getEpoch: vi.fn(() => epoch),
      processIncomingMessage: vi.fn(async () => {
        epoch = 25;
      }),
      fetchCommitsSince: vi.fn(async () => ({
        commits: [{ baseEpoch: 24, proto: 'AA==' }],
        activeEpoch: 25,
        belowFloor: false,
      })),
      isGroupActive: vi.fn().mockResolvedValue(false),
      distributionGapListener: listener,
    });
    const quiet = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    ];

    const verdict = await (
      proto as unknown as { catchUpDistributionGroup(g: string, t: number): Promise<string> }
    ).catchUpDistributionGroup.call(ctx, 'g-1', 25);

    expect(verdict).toBe('evicted');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('g-1', 'evicted');
    quiet.forEach((q) => q.mockRestore());
  });
});

describe('a key-group frame tells the persister what it spent', () => {
  function withPersisterSpy() {
    const noteReceivedFrame = vi.fn();
    registerMlsStatePersister({ noteReceivedFrame } as any);
    return noteReceivedFrame;
  }

  afterEach(() => unregisterMlsStatePersister());

  function registered(overrides: Record<string, unknown> = {}) {
    const ctx = makeCtx(overrides);
    proto.registerDistributionGroup.call(ctx, WS, 'g-1');
    return ctx;
  }

  it('a commit is STRUCTURAL, so the drain that carried it can never skip its checkpoint', async () => {
    const note = withPersisterSpy();
    const ctx = registered({ processIncomingMessage: vi.fn().mockResolvedValue(null) });

    await route(ctx, 'g-1', 'peer', new Uint8Array([1]));

    expect(note).toHaveBeenCalledWith(true);
  });

  it('a seed or application frame spends a generation and is counted as one', async () => {
    const note = withPersisterSpy();
    const ctx = registered();

    await route(ctx, 'g-1', 'peer', new Uint8Array([1]));

    expect(note).toHaveBeenCalledWith(false);
  });
});

describe('a key-group frame refused for its sender still spends a counted generation', () => {
  afterEach(() => unregisterMlsStatePersister());

  it('tells the persister, so a drain of them cannot look empty to the measurement switch', async () => {
    const { SenderMismatchError } = await import('$lib/mls-client/verifiedSender');
    const noteReceivedFrame = vi.fn();
    registerMlsStatePersister({ noteReceivedFrame } as any);
    const ctx = makeCtx({
      processIncomingMessage: vi.fn().mockRejectedValue(new SenderMismatchError('g-1', 'user')),
    });
    proto.registerDistributionGroup.call(ctx, WS, 'g-1');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await route(ctx, 'g-1', 'mallory', new Uint8Array([7, 7, 7]));

    expect(noteReceivedFrame).toHaveBeenCalledWith(false);
  });

  it('a partial key-group replay (commits applied, not caught up) asks for a checkpoint', async () => {
    const persistNow = vi.fn();
    registerMlsStatePersister({ persistNow } as any);
    const ctx = makeCtx({
      getLocalGroups: vi.fn().mockReturnValue(['g-1']),
      getEpoch: vi.fn().mockReturnValue(5),
      processIncomingMessage: vi.fn().mockResolvedValue(null),
      fetchCommitsSince: vi.fn(async () => ({
        commits: [{ baseEpoch: 5, proto: 'AA==' }],
        activeEpoch: 16,
        belowFloor: false,
      })),
      isGroupActive: vi.fn().mockResolvedValue(true),
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await (
      proto as unknown as { catchUpDistributionGroup(g: string, t: number): Promise<string> }
    ).catchUpDistributionGroup.call(ctx, 'g-1', 16);

    expect(persistNow).toHaveBeenCalled();
  });

  it('a key-group replay that applied commits AND caught up asks for ONE checkpoint, not two', async () => {
    const persistNow = vi.fn();
    registerMlsStatePersister({ persistNow } as any);
    let epoch = 5;
    const ctx = makeCtx({
      getLocalGroups: vi.fn().mockReturnValue(['g-1']),
      getEpoch: vi.fn(() => epoch),
      processIncomingMessage: vi.fn(async () => {
        epoch += 1;
        return null;
      }),
      fetchCommitsSince: vi.fn(async () => ({
        commits: [{ baseEpoch: 5, proto: 'AA==' }],
        activeEpoch: 6,
        belowFloor: false,
      })),
      isGroupActive: vi.fn().mockResolvedValue(true),
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const verdict = await (
      proto as unknown as { catchUpDistributionGroup(g: string, t: number): Promise<string> }
    ).catchUpDistributionGroup.call(ctx, 'g-1', 6);

    expect(verdict).toBe('caught-up');
    expect(persistNow).toHaveBeenCalledTimes(1);
  });
});

/**
 * A KEY-GROUP FRAME WHOSE HANDLER THREW IS KEPT, NEVER LOST (mls-desync-prevention section 11).
 *
 * The generation is spent at decrypt and the seed is stored after it, so a handler that threw used to
 * leave a frame MLS refuses on redelivery (`secret-reuse`): acknowledged as unreadable, counted as a
 * network loss, and the seed gone from this device. The plaintext is now kept in the MLS state by the
 * decrypt itself, and every arrival of the frame - its redelivery, the next start - runs the handler on
 * it. `spendingMls` stands in for the platform: it keeps the plaintext under `keepAs` exactly as
 * `process_incoming_message_kept` does, and refuses bytes whose generation it already spent.
 */
describe('a key-group frame whose handler threw (section 11)', () => {
  const SEED = new Uint8Array([4, 2]);
  const FRAME = new Uint8Array([7, 1, 7]);
  const LATER = new Uint8Array([7, 1, 8]);

  /**
   * The decrypt as the platforms run it: a generation spent once, and the plaintext kept in the same
   * call. `plaintextOf` says what each frame decrypts to - null for a commit, which keeps nothing.
   */
  function spendingMls(
    verifiedSender: string | null = 'peer:peer-phone',
    plaintextOf: (bytes: Uint8Array) => Uint8Array | null = () => SEED
  ) {
    const spent = new Set<string>();
    return vi.fn(async (_groupId: string, bytes: Uint8Array, _env: unknown, keepAs?: string) => {
      const fp = frameFingerprint(bytes);
      if (spent.has(fp)) throw new Error('SecretReuseError: already-consumed generation');
      spent.add(fp);
      const plaintext = plaintextOf(bytes);
      if (plaintext === null) return null;
      if (keepAs)
        noteStateLedgerHeldByState('u', keepAs, keptFrameValue(verifiedSender, plaintext));
      return { plaintext, author: 'unsigned' };
    });
  }

  function registered(overrides: Record<string, unknown> = {}) {
    const ctx = makeCtx(overrides);
    proto.registerDistributionGroup.call(ctx, WS, 'g-1');
    return ctx;
  }

  /** What a checkpoint and a kill leave on disk: the ledgers the live client holds. */
  function stateOnDisk(): Record<string, string> {
    return Object.fromEntries(stateLedgerKeys('u', '').map((k) => [k, readStateLedger('u', k)!]));
  }

  /** No `localStorage` copy of any ledger: the opening's migration finds nothing to move. */
  const emptyLocalStorage = {
    length: 0,
    key: () => null,
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  };

  beforeEach(() => {
    vi.mocked(noteKeyGroupFrameLost).mockClear();
    resetKeyGroupFrameLosses();
    resetUnackedFrames();
    vi.stubGlobal('localStorage', emptyLocalStorage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('runs the handler again on the redelivery, stores the seed, and counts no loss', async () => {
    const processIncomingMessage = spendingMls();
    const handler = vi
      .fn()
      .mockRejectedValueOnce(new Error('seed store write failed'))
      .mockResolvedValue(undefined);
    const ctx = registered({ processIncomingMessage, distributionFrameHandler: handler });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    // The store failed: not acknowledged, and the plaintext is kept beside the spent generation.
    expect(await route(ctx, 'g-1', 'peer', FRAME)).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /failed run 1, key group keeps 1 frame\(s\), 1 failed run\(s\).*its plaintext is kept/
      ),
      expect.stringContaining('seed store write failed')
    );
    expect(readKeptFrame('u', 'g-1', frameFingerprint(FRAME))).toMatchObject({ failures: 1 });

    // The redelivery: never decrypted again, handled from the kept plaintext, then forgotten.
    expect(await route(ctx, 'g-1', 'peer', FRAME)).toBe(true);
    expect(processIncomingMessage).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenLastCalledWith(
      expect.objectContaining({ groupId: 'g-1', plaintext: SEED })
    );
    expect(readKeptFrame('u', 'g-1', frameFingerprint(FRAME))).toBeNull();

    // An acknowledgement lost after that: a spent generation on bytes already read, not a loss -
    // said at warn, naming what it cannot tell apart.
    warn.mockClear();
    expect(await route(ctx, 'g-1', 'peer', FRAME)).toBe(true);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'already read here (its generation spent on these bytes) and nothing is kept for it: handled, refused for good, or lost'
      )
    );
    expect(noteKeyGroupFrameLost).not.toHaveBeenCalled();
    expect(describeKeyGroupFrameLosses('g-1')).toBe('none');
  });

  it('survives a restart: the opened state carries it, and the next start handles it from the sender MLS verified', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const before = registered({
      processIncomingMessage: spendingMls('peer:peer-phone'),
      distributionFrameHandler: vi.fn().mockRejectedValue(new Error('runtime ended')),
    });
    expect(await route(before, 'g-1', 'peer', FRAME)).toBe(false);

    // The kill, and the next start, through the real opening: the state's ledgers are read back
    // (`openStateLedgers`), the key-group registry restored from its rows, then the handler wired.
    const disk = stateOnDisk();
    resetStateLedgersForTests();
    const handler = vi.fn().mockResolvedValue(undefined);
    const after = makeCtx({
      distributionFrameHandler: null,
      readStateLedgers: vi.fn(async () => disk),
      getLocalGroups: vi.fn().mockReturnValue(['g-1']),
      distributionGroupStore: makeStore([{ groupId: 'g-1', workspaceId: 'ws-1', channelId: null }]),
    });
    await proto.openStateLedgers.call(after);
    await proto.hydrateDistributionGroups.call(after);
    proto.onDistributionFrame.call(after, handler);
    await flushMacrotask();

    expect(handler).toHaveBeenCalledWith({
      scope: WS,
      workspaceId: 'ws-1',
      groupId: 'g-1',
      sender: 'peer',
      senderDeviceId: 'peer-phone',
      plaintext: SEED,
    });
    expect(readKeptFrame('u', 'g-1', frameFingerprint(FRAME))).toBeNull();
    expect(info).toHaveBeenCalledWith(expect.stringContaining('1 key-group frame(s) kept'));

    // The frame was never acknowledged, so the server redelivers it: read here, so acknowledged.
    after.processIncomingMessage = vi
      .fn()
      .mockRejectedValue(new Error('SecretReuseError: already-consumed generation'));
    expect(await route(after, 'g-1', 'peer', FRAME)).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(noteKeyGroupFrameLost).not.toHaveBeenCalled();
  });

  it('counts the failed runs in the state, across starts, and accuses from the third', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const failing = () => vi.fn().mockRejectedValue(new Error('seed store refused'));
    const ctx = registered({
      processIncomingMessage: spendingMls(),
      distributionFrameHandler: failing(),
    });
    expect(await route(ctx, 'g-1', 'peer', FRAME)).toBe(false);
    expect(await route(ctx, 'g-1', 'peer', FRAME)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(error).not.toHaveBeenCalled();

    // A restart: the count is read back from the state, not started again.
    const disk = stateOnDisk();
    resetStateLedgersForTests();
    const next = makeCtx({
      distributionFrameHandler: null,
      readStateLedgers: vi.fn(async () => disk),
    });
    await proto.openStateLedgers.call(next);
    proto.registerDistributionGroup.call(next, WS, 'g-1');
    proto.onDistributionFrame.call(next, failing());
    await flushMacrotask();

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('failed run 3'),
      expect.stringContaining('seed store refused')
    );
    expect(readKeptFrame('u', 'g-1', frameFingerprint(FRAME))).toMatchObject({ failures: 3 });
    expect(noteKeyGroupFrameLost).not.toHaveBeenCalled();
  });

  it('keeps it through a sign-out: the same account signing in again handles it', async () => {
    // A sign-out keeps the account's MLS state on disk for its next sign-in, ratchets included, and
    // the kept frame lives in that state. Dropping it there would spend the generation for nothing:
    // the redelivery would then meet a generation this device spent, and the seed would be lost.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const service = registered({
      processIncomingMessage: spendingMls(),
      distributionFrameHandler: vi.fn().mockRejectedValue(new Error('runtime ended')),
    });
    expect(await route(service, 'g-1', 'peer', FRAME)).toBe(false);

    // The sign-out: its final checkpoint writes the state, and the next sign-in's `init` closes this
    // document's view before it loads the state again (`closeStateLedgers`) - nothing is read from
    // memory across the two.
    const disk = stateOnDisk();
    closeStateLedgers('u');
    expect(readKeptFrame('u', 'g-1', frameFingerprint(FRAME))).toBeNull();

    // The sign-in, on the same service: the state opened, the registry restored, the handler wired.
    const handler = vi.fn().mockResolvedValue(undefined);
    Object.assign(service, {
      readStateLedgers: vi.fn(async () => disk),
      getLocalGroups: vi.fn().mockReturnValue(['g-1']),
      distributionGroupStore: makeStore([{ groupId: 'g-1', workspaceId: 'ws-1', channelId: null }]),
    });
    await proto.openStateLedgers.call(service);
    expect(readKeptFrame('u', 'g-1', frameFingerprint(FRAME))).not.toBeNull();
    await proto.hydrateDistributionGroups.call(service);
    proto.onDistributionFrame.call(service, handler);
    await flushMacrotask();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ plaintext: SEED }));
    expect(readKeptFrame('u', 'g-1', frameFingerprint(FRAME))).toBeNull();
  });

  it('goes with the state when the device is wiped: a state opened empty keeps nothing', () => {
    // The kept frame has no store of its own - it is a ledger of the MLS state, so the erasure that
    // deletes the state (a revoked or reset device) deletes it, and a new state carries none.
    noteStateLedgerHeldByState('u', keptFrameKey('g-1', frameFingerprint(FRAME)), 'x');
    expect(keptFrameIds('u')).toHaveLength(1);
    resetStateLedgersForTests();
    hydrateStateLedgers('u', {});
    expect(keptFrameIds('u')).toEqual([]);
  });

  it('a handler that can never succeed is terminal: forgotten, acknowledged, said at error, not counted', async () => {
    const ctx = registered({
      processIncomingMessage: spendingMls(),
      distributionFrameHandler: vi
        .fn()
        .mockRejectedValue(new UnhandleableFrameError('undecodable payload')),
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(await route(ctx, 'g-1', 'peer', FRAME)).toBe(true);

    expect(error).toHaveBeenCalledWith(expect.stringContaining('can never be handled'));
    expect(readKeptFrame('u', 'g-1', frameFingerprint(FRAME))).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    // Its redelivery is known as read here, and never counted as a network loss.
    expect(await route(ctx, 'g-1', 'peer', FRAME)).toBe(true);
    expect(noteKeyGroupFrameLost).not.toHaveBeenCalled();
  });

  it('holds every later frame of a group behind its own kept frame, and fetches them once it is handled', async () => {
    const processIncomingMessage = spendingMls();
    const handler = vi
      .fn()
      .mockRejectedValueOnce(new Error('seed store write failed'))
      .mockResolvedValue(undefined);
    const ctx = registered({ processIncomingMessage, distributionFrameHandler: handler });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await route(ctx, 'g-1', 'peer', FRAME)).toBe(false);
    // In server order: the later frame is not decrypted while the earlier one waits, and the line
    // says so once, not once per frame.
    expect(await route(ctx, 'g-1', 'peer', LATER)).toBe(false);
    expect(await route(ctx, 'g-1', 'peer', LATER)).toBe(false);
    expect(processIncomingMessage).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('wait unread behind'))).toHaveLength(
      1
    );

    // The redelivery handles the kept one, which opens the group's order and asks for what waited.
    const fetched = vi.fn().mockResolvedValue(undefined);
    ctx.fetchPendingMessages = fetched;
    expect(await route(ctx, 'g-1', 'peer', FRAME)).toBe(true);
    expect(fetched).toHaveBeenCalledWith(['g-1']);
    expect(await route(ctx, 'g-1', 'peer', LATER)).toBe(true);
    expect(processIncomingMessage).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('a handler failing for good on community A does not stop community B, its commits or its largest frame', async () => {
    // The largest honest frame, a full bundle page, and a commit as large: the worst A can hold, and
    // the worst B can ask for.
    const page = new Uint8Array(GRAINE_BUNDLE_PAGE_MAX_BYTES + 4 * 1024);
    const pageA = page.slice();
    pageA[0] = 1;
    const commitA = new Uint8Array([9, 9, 1]);
    const commitB = page.slice();
    commitB[0] = 2;
    const pageB = page.slice();
    pageB[0] = 3;
    const plaintextOf = (bytes: Uint8Array) =>
      bytes === commitA || bytes === commitB ? null : bytes.subarray(0, bytes.length - 64);
    const processIncomingMessage = spendingMls('peer:peer-phone', plaintextOf);
    const handler = vi.fn(async (frame: { workspaceId: string }) => {
      if (frame.workspaceId === 'ws-a') throw new Error('seed store refuses this community');
    });
    const ctx = makeCtx({ processIncomingMessage, distributionFrameHandler: handler });
    proto.registerDistributionGroup.call(ctx, workspaceScope('ws-a'), 'g-a');
    proto.registerDistributionGroup.call(ctx, workspaceScope('ws-b'), 'g-b');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    // A's page is read, its handler fails for good: kept, and A's later frames wait behind it.
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await route(ctx, 'g-a', 'peer', pageA)).toBe(false);
      expect(await route(ctx, 'g-a', 'peer', commitA)).toBe(false);
    }
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('failed run 3'),
      expect.stringContaining('refuses this community')
    );

    // B goes on: its commit applies and its own largest frame is read and handled.
    expect(await route(ctx, 'g-b', 'peer', commitB)).toBe(true);
    expect(await route(ctx, 'g-b', 'peer', pageB)).toBe(true);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws-b' }));
    expect(processIncomingMessage.mock.calls.map((c) => c[0])).toEqual(['g-a', 'g-b', 'g-b']);
    expect(keptFrameIds('u')).toEqual([{ groupId: 'g-a', fingerprint: frameFingerprint(pageA) }]);
    expect(noteKeyGroupFrameLost).not.toHaveBeenCalled();
  });

  it('decrypts nothing of a group refused for room, a small frame included, and fetches it once a kept one is handled', async () => {
    // Two other groups each keep a frame near their share: the set is full for anything sizeable.
    const nearShare = new Uint8Array(Math.floor(((KEPT_FRAME_MAX_BYTES - 1024) * 3) / 4));
    for (const g of ['g-0', 'g-2']) {
      noteStateLedgerHeldByState(
        'u',
        keptFrameKey(g, 'k:1'),
        keptFrameValue('peer:peer-phone', nearShare)
      );
    }
    const processIncomingMessage = spendingMls();
    const ctx = makeCtx({ processIncomingMessage, distributionFrameHandler: null });
    proto.registerDistributionGroup.call(ctx, WS, 'g-1');
    proto.registerDistributionGroup.call(ctx, channelScope('ws-1', 'c-0'), 'g-0');
    proto.registerDistributionGroup.call(ctx, channelScope('ws-1', 'c-2'), 'g-2');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);

    expect(await route(ctx, 'g-1', 'peer', new Uint8Array(70_000))).toBe(false);
    // A small frame after it would fit, and is NOT decrypted: it would be handled out of order.
    expect(await route(ctx, 'g-1', 'peer', new Uint8Array(40))).toBe(false);
    expect(processIncomingMessage).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    // It names who holds the room, so "A and B hold back C" is read from the log.
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /fill their budget .*by g-0: 1 frame\(s\), 0 failed run\(s\), \d+ bytes; g-2: 1 frame\(s\)/
      )
    );

    // One kept frame is handled: the room it frees is re-fetched, and a refusal met again in the
    // same episode is said at info - the same fact, no repeating warn.
    const fetched = vi.fn().mockResolvedValue(undefined);
    ctx.fetchPendingMessages = fetched;
    const info = vi.mocked(console.info);
    proto.forgetKeptDistributionFrame.call(ctx, 'g-0', 'k:1');
    expect(fetched).toHaveBeenCalledWith(['g-1']);
    noteStateLedgerHeldByState(
      'u',
      keptFrameKey('g-0', 'k:2'),
      keptFrameValue('peer:peer-phone', nearShare)
    );
    expect(await route(ctx, 'g-1', 'peer', new Uint8Array(70_000))).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('fill their budget'));

    // Every kept one is handled: the room is back, and the group is fetched again.
    fetched.mockClear();
    proto.onDistributionFrame.call(ctx, vi.fn().mockResolvedValue(undefined));
    await flushMacrotask();
    expect(keptFrameIds('u')).toEqual([]);
    expect(fetched).toHaveBeenCalledWith(['g-1']);
    expect(await route(ctx, 'g-1', 'peer', new Uint8Array(70_000))).toBe(true);
  });

  it('a frame refused for its sender frees its room through the one forget', async () => {
    const processIncomingMessage = vi.fn(
      async (_groupId: string, _bytes: Uint8Array, _env: unknown, keepAs?: string) => {
        if (keepAs) noteStateLedgerHeldByState('u', keepAs, keptFrameValue('mallory:m', SEED));
        throw new SenderMismatchError('g-1', 'user');
      }
    );
    const ctx = registered({ processIncomingMessage });
    proto.registerDistributionGroup.call(ctx, channelScope('ws-1', 'c-2'), 'g-2');
    ctx.keyGroupsWaitingForRoom.add('g-2');
    noteUnackedFrame('g-2', 'kept-frames-full');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const fetched = vi.fn().mockResolvedValue(undefined);
    ctx.fetchPendingMessages = fetched;

    expect(await route(ctx, 'g-1', 'peer', FRAME)).toBe(true);

    expect(keptFrameIds('u')).toEqual([]);
    expect(fetched).toHaveBeenCalledWith(['g-2']);
    expect(ctx.keyGroupsWaitingForRoom.size).toBe(0);
  });

  it('opens a frame past a group share WITHOUT keeping: a commit applies, an application frame is terminal', async () => {
    const huge = new Uint8Array(KEPT_FRAME_MAX_BYTES);
    expect(roomToKeep('u', huge.length)).toBe('too-large');

    // A bulk add carries every key package and no plaintext: acknowledged unread, the group would
    // stay behind for good.
    const commitMls = vi.fn().mockResolvedValue(null);
    const committing = registered({ processIncomingMessage: commitMls });
    expect(await route(committing, 'g-1', 'peer', huge)).toBe(true);
    expect(commitMls).toHaveBeenCalledWith('g-1', huge, expect.anything(), undefined);

    // An application frame that large comes from no honest client: never handled, never counted.
    const handler = vi.fn().mockResolvedValue(undefined);
    const ctx = registered({
      processIncomingMessage: vi.fn().mockResolvedValue({ plaintext: SEED, author: 'unsigned' }),
      distributionFrameHandler: handler,
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await route(ctx, 'g-1', 'peer', huge)).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('can never be handled'));
    expect(keptFrameIds('u')).toEqual([]);
    expect(noteKeyGroupFrameLost).not.toHaveBeenCalled();
  });

  it('holds the largest honest frame - one full bundle page - in a group share', () => {
    // A page budget raised past the share would refuse real answers as `too-large`.
    const page = GRAINE_BUNDLE_PAGE_MAX_BYTES + 4 * 1024;
    expect(roomToKeep('u', page)).toBe('room');
  });

  it('forgets the kept frames of a community left, through the leave path, and keeps them for a re-join', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    // What each drop's checkpoint exports: the kept frames as they stand when the tree goes.
    const keptAtDrop: string[][] = [];
    const ctx = registered({
      processIncomingMessage: spendingMls(),
      distributionFrameHandler: vi.fn().mockRejectedValue(new Error('seed store write failed')),
      getLocalGroups: vi.fn().mockReturnValue(['g-1', 'g-2']),
      forgetGroup: vi.fn(() => keptAtDrop.push(keptFrameIds('u').map((id) => id.groupId))),
      persistCheckpoint: vi.fn().mockResolvedValue(undefined),
    });
    proto.registerDistributionGroup.call(ctx, SALON, 'g-2');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await route(ctx, 'g-1', 'peer', FRAME)).toBe(false);
    expect(await route(ctx, 'g-2', 'peer', LATER)).toBe(false);
    expect(keptFrameIds('u')).toHaveLength(2);

    // A re-join of the salon's group keeps its frame - its seed is still the community's - and its
    // row, which is what spares the frame at an opening a kill lands on before the join.
    const store = makeStore([
      { groupId: 'g-1', workspaceId: 'ws-1', channelId: null },
      { groupId: 'g-2', workspaceId: 'ws-1', channelId: 'chan-1' },
    ]);
    ctx.distributionGroupStore = store;
    await proto.forgetDistributionGroupById.call(
      ctx,
      'g-2',
      'own leaf removed from the key group',
      {
        rejoining: true,
      }
    );
    expect(keptFrameIds('u').map((id) => id.groupId)).toEqual(['g-1', 'g-2']);
    expect(store.rows.has('g-2')).toBe(true);

    // Leaving the community (`forgetCommunityGraine` asks this for each of its scopes).
    expect(await proto.forgetDistributionGroup.call(ctx, WS)).toBe('g-1');
    // Staged BEFORE the drop, so the checkpoint the drop awaits carries the deletion.
    expect(keptAtDrop).toEqual([['g-1', 'g-2'], ['g-2']]);
    expect(keptFrameIds('u').map((id) => id.groupId)).toEqual(['g-2']);
    expect(store.rows.has('g-1')).toBe(false);
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('forgotten with it (distribution group left)')
    );
  });

  it('drops at error, once the held groups are listed, a kept frame whose group the state no longer holds', async () => {
    noteStateLedgerHeldByState('u', keptFrameKey('g-held', '1:a'), keptFrameValue('p:d', SEED));
    noteStateLedgerHeldByState('u', keptFrameKey('g-gone', '1:b'), keptFrameValue('p:d', SEED));
    // A re-join killed between its drop and its join: the tree is gone, its row is not.
    noteStateLedgerHeldByState('u', keptFrameKey('g-rejoin', '1:c'), keptFrameValue('p:d', SEED));
    const ctx = makeCtx({
      getLocalGroups: vi.fn().mockReturnValue(['g-held']),
      distributionGroupStore: makeStore([
        { groupId: 'g-rejoin', workspaceId: 'ws-1', channelId: null },
      ]),
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await proto.hydrateDistributionGroups.call(ctx);

    expect(keptFrameIds('u').map((id) => id.groupId)).toEqual(['g-held', 'g-rejoin']);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('1 kept key-group frame(s) of 1 group(s) this state no longer holds')
    );
    // That opening deleted the stale row: a re-join that never came is judged at the next one.
    await proto.hydrateDistributionGroups.call(
      makeCtx({
        getLocalGroups: vi.fn().mockReturnValue(['g-held']),
        distributionGroupStore: makeStore([]),
      })
    );
    expect(keptFrameIds('u').map((id) => id.groupId)).toEqual(['g-held']);

    // Not judged without the listing: nothing is dropped then.
    noteStateLedgerHeldByState('u', keptFrameKey('g-gone', '1:b'), keptFrameValue('p:d', SEED));
    await proto.hydrateDistributionGroups.call(
      makeCtx({ heldGroupsKnown: () => false, distributionGroupStore: makeStore([]) })
    );
    expect(keptFrameIds('u')).toHaveLength(2);
  });
  describe('the epoch check of a key group held behind a kept frame', () => {
    /** A group at `epoch`, its server ahead with commits in the log, a kept frame of its own. */
    function heldBehind(epoch: number, serverEpoch: number) {
      const tree = { epoch };
      const listener = vi.fn();
      const ctx = registered({
        processIncomingMessage: spendingMls(),
        distributionFrameHandler: vi
          .fn()
          .mockRejectedValueOnce(new Error('seed store write failed'))
          .mockResolvedValue(undefined),
        getLocalGroups: vi.fn().mockReturnValue(['g-1']),
        getEpoch: vi.fn(() => tree.epoch),
        fetchCommitsSince: vi.fn(async () => ({
          commits: [{ baseEpoch: epoch, proto: 'AA==' }],
          activeEpoch: serverEpoch,
          belowFloor: false,
        })),
        distributionGapListener: listener,
      });
      return { ctx, tree, listener };
    }

    beforeEach(() => resetEpochGapRegistry());

    it('runs no replay and no re-join after a complete drain, and seals nothing at the stale epoch', async () => {
      const { ctx, listener } = heldBehind(4, 6);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      expect(await route(ctx, 'g-1', 'peer', FRAME)).toBe(false);

      // The drain is complete (`whenGroupDrained` resolves) and the server is ahead: deferred.
      expect(await proto.verifyDistributionEpoch.call(ctx, 'g-1', 6)).toBe('deferred');
      expect(await proto.verifyDistributionEpoch.call(ctx, 'g-1', 6)).toBe('deferred');
      expect(ctx.fetchCommitsSince).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
      // Said once for the episode, with what the group keeps.
      const deferrals = info.mock.calls.filter((c) =>
        String(c[0]).includes('epoch check of key group')
      );
      expect(deferrals).toHaveLength(1);
      expect(String(deferrals[0][0])).toContain('1 frame(s), 1 failed run(s)');
      // No seed and no request is sealed at epoch 4 meanwhile.
      expect(isInEpochGap('g-1')).toBe(true);
      expect(distributionEpochFor(ctx as never, WS)).toBeNull();
    });

    it('runs the check once the kept frame is handled - after the frames it held back', async () => {
      const { ctx, tree, listener } = heldBehind(4, 6);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.spyOn(console, 'info').mockImplementation(() => undefined);
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      expect(await route(ctx, 'g-1', 'peer', FRAME)).toBe(false);
      expect(await proto.verifyDistributionEpoch.call(ctx, 'g-1', 6)).toBe('deferred');
      // The drain of the re-fetch the release asks for, settled by hand.
      let settle!: () => void;
      const drained = new Promise<void>((r) => {
        settle = r;
      });
      const whenGroupDrained = vi.fn(() => drained);
      ctx.whenGroupDrained = whenGroupDrained;

      // The redelivery handles it; the frames it held back come in and carry the group to 6.
      expect(await route(ctx, 'g-1', 'peer', FRAME)).toBe(true);
      expect(whenGroupDrained).toHaveBeenCalledWith('g-1');
      expect(isInEpochGap('g-1')).toBe(true);
      tree.epoch = 6;
      settle();
      await flushMacrotask();

      expect(ctx.fetchCommitsSince).not.toHaveBeenCalled();
      // The gap the deferral armed is closed by the epoch reaching its target, and said.
      expect(isInEpochGap('g-1')).toBe(false);
      expect(listener).toHaveBeenCalledWith('g-1', 'caught-up');
      expect(distributionEpochFor(ctx as never, WS)).toBe(6);
    });

    it('replays from the log once released, when what it held back did not reach the server', async () => {
      const { ctx, tree, listener } = heldBehind(4, 5);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.spyOn(console, 'info').mockImplementation(() => undefined);
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      // The replayed commit moves the tree.
      ctx.processIncomingMessage = vi.fn(async (_g: string, bytes: Uint8Array) => {
        if (bytes === FRAME) throw new Error('SecretReuseError: already-consumed generation');
        tree.epoch += 1;
        return null;
      });
      noteStateLedgerHeldByState(
        'u',
        keptFrameKey('g-1', frameFingerprint(FRAME)),
        keptFrameValue('peer:peer-phone', SEED)
      );
      expect(await proto.verifyDistributionEpoch.call(ctx, 'g-1', 5)).toBe('deferred');

      ctx.distributionFrameHandler = vi.fn().mockResolvedValue(undefined);
      expect(await route(ctx, 'g-1', 'peer', FRAME)).toBe(true);
      await flushMacrotask();

      expect(ctx.fetchCommitsSince).toHaveBeenCalled();
      expect(tree.epoch).toBe(5);
      expect(listener).toHaveBeenCalledWith('g-1', 'caught-up');
    });
  });
});
