// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/TauriMlsService', () => ({ TauriMlsService: class {} }));
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));

import { BaseMlsService } from './BaseMlsService';
import type { ExternalJoinOutcome } from '$lib/mls-client/IMlsService';
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
  routeDistributionFrame(groupId: string, sender: string, ciphertext: Uint8Array): Promise<boolean>;
  noteDistributionGroup(groupId: string): void;
  forgetDistributionGroupById(groupId: string): Promise<boolean>;
  hydrateDistributionGroups(): Promise<void>;
  refetchFramesLeftBehind(
    reasons: UnackedReason | readonly UnackedReason[],
    trigger: string,
    groupId?: string
  ): boolean;
  collectFramesLeftForKeyGroup(groupId: string): void;
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
};

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
    createGroup: vi.fn().mockResolvedValue(undefined),
    exportGroupInfo: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    getEpoch: vi.fn().mockReturnValue(0),
    forgetGroup: vi.fn(),
    externalJoin: vi.fn().mockResolvedValue({ joined: true }),
    processIncomingMessage: vi.fn().mockResolvedValue(new Uint8Array([9, 9])),
    // The durable half of the registry, and the net that collects what the drain refused - REAL,
    // because registering a group is what drives both.
    distributionGroupStore: null as ReturnType<typeof makeStore> | null,
    heldAtHydration: new Set<string>(),
    isWsOpen: vi.fn().mockReturnValue(true),
    fetchPendingMessages: vi.fn().mockResolvedValue(undefined),
    refetchFramesLeftBehind: proto.refetchFramesLeftBehind,
    collectFramesLeftForKeyGroup: proto.collectFramesLeftForKeyGroup,
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
    registerDistributionGroup: proto.registerDistributionGroup,
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

    expect(ctx.delivery.fetchGroupInfo).toHaveBeenCalledWith('g-plain');
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
    expect(ctx.externalJoin).toHaveBeenCalledWith('g-1');
    expect(ctx.createGroup).not.toHaveBeenCalled();
  });

  it('creates the group and publishes the base when this device is the first one in', async () => {
    const ctx = makeCtx();

    expect(await ensure(ctx, WS, REF_FRESH)).toEqual({ joined: true });
    expect(ctx.createGroup).toHaveBeenCalledWith('g-1');
    expect(ctx.distributionGroupInfo.publish).toHaveBeenCalledWith(WS, expect.any(String), 0, 'd');
    expect(ctx.externalJoin).not.toHaveBeenCalled();
    expect(ctx.forgetGroup).not.toHaveBeenCalled();
  });

  it('throws its own group away and joins the winner when it loses the first publish', async () => {
    const ctx = makeCtx();
    ctx.distributionGroupInfo.publish.mockResolvedValue({ stored: false });

    expect(await ensure(ctx, WS, REF_FRESH)).toEqual({ joined: true });
    // Keeping it would fork the community: two MLS groups under one id, each holding half the
    // seeds, with nothing on either side ever reporting it.
    expect(ctx.forgetGroup).toHaveBeenCalledWith('g-1', 0);
    expect(ctx.externalJoin).toHaveBeenCalledWith('g-1');
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

    expect(await proto.forgetDistributionGroupById.call(ctx, 'g-1')).toBe(true);

    expect(store.deleteDistributionGroup).toHaveBeenCalledWith('g-1');
    expect(store.rows.has('g-1')).toBe(false);
    log.mockRestore();
  });

  it('keeps the session registration when the store refuses the write, and says so', async () => {
    const { ctx, store } = wired();
    store.saveDistributionGroup.mockRejectedValueOnce(new Error('quota'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    proto.registerDistributionGroup.call(ctx, WS, 'g-1');
    await new Promise((r) => setTimeout(r, 0));

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
      processIncomingMessage: vi.fn().mockResolvedValue(plaintext),
    });
    await proto.hydrateDistributionGroups.call(ctx);

    expect(await route(ctx, 'g-salon', 'peer', new Uint8Array([1]))).toBe(true);
    expect(ctx.distributionFrameHandler).toHaveBeenCalledWith(
      expect.objectContaining({ scope: SALON, workspaceId: 'ws-1', plaintext })
    );
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
      initialDrain: new Promise<void>((r) => {
        settle = r;
      }),
      waitForGroupQueueIdle: vi.fn().mockResolvedValue(undefined),
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
        return seed;
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
