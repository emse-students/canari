// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/TauriMlsService', () => ({ TauriMlsService: class {} }));
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));

import { BaseMlsService } from './BaseMlsService';

/**
 * A community's Graine key-distribution group, on the client (WP-22).
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
  registerDistributionGroup(workspaceId: string, groupId: string): void;
  isDistributionGroup(groupId: string): boolean;
  distributionGroupFor(workspaceId: string): string | null;
  groupInfoChannel(groupId: string): {
    fetch(): Promise<{ groupInfo: string; baseEpoch: number } | null>;
    publish(groupInfo: string, baseEpoch: number): Promise<{ stored: boolean }>;
  };
  ensureDistributionGroup(
    workspaceId: string,
    ref: { groupId: string; groupInfo: string | null; baseEpoch: number | null }
  ): Promise<boolean>;
  routeDistributionFrame(groupId: string, sender: string, ciphertext: Uint8Array): Promise<boolean>;
};

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'u',
    deviceId: 'd',
    delivery: {
      fetchGroupInfo: vi.fn().mockResolvedValue({ groupInfo: 'ZGVs', baseEpoch: 3 }),
      storeGroupInfo: vi.fn().mockResolvedValue({ stored: true }),
      submitCommit: vi.fn(),
    },
    distributionWorkspaceByGroup: new Map<string, string>(),
    distributionGroupInfo: {
      fetch: vi.fn().mockResolvedValue({ groupInfo: 'c29j', baseEpoch: 7 }),
      publish: vi.fn().mockResolvedValue({ stored: true }),
    },
    distributionFrameHandler: vi.fn().mockResolvedValue(undefined),
    runUnderMlsLock: <T>(fn: () => Promise<T>) => fn(),
    getLocalGroups: vi.fn().mockReturnValue([]),
    createGroup: vi.fn().mockResolvedValue(undefined),
    exportGroupInfo: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    getEpoch: vi.fn().mockReturnValue(0),
    forgetGroup: vi.fn(),
    externalJoin: vi.fn().mockResolvedValue(true),
    processIncomingMessage: vi.fn().mockResolvedValue(new Uint8Array([9, 9])),
    registerDistributionGroup: proto.registerDistributionGroup,
    groupInfoChannel: proto.groupInfoChannel,
    ...overrides,
  };
}

const ensure = (
  ctx: Ctx,
  workspaceId: string,
  ref: Parameters<typeof proto.ensureDistributionGroup>[1]
) => proto.ensureDistributionGroup.call(ctx, workspaceId, ref);

const route = (ctx: Ctx, groupId: string, sender: string, bytes: Uint8Array) =>
  proto.routeDistributionFrame.call(ctx, groupId, sender, bytes);

describe('the registry', () => {
  it('answers both directions from one map, so the two cannot disagree', () => {
    const ctx = makeCtx();
    proto.registerDistributionGroup.call(ctx, 'ws-1', 'g-1');

    expect(proto.isDistributionGroup.call(ctx, 'g-1')).toBe(true);
    expect(proto.isDistributionGroup.call(ctx, 'g-other')).toBe(false);
    expect(proto.distributionGroupFor.call(ctx, 'ws-1')).toBe('g-1');
    expect(proto.distributionGroupFor.call(ctx, 'ws-other')).toBeNull();
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
    proto.registerDistributionGroup.call(ctx, 'ws-1', 'g-1');

    const channel = proto.groupInfoChannel.call(ctx, 'g-1');
    expect(await channel.fetch()).toEqual({ groupInfo: 'c29j', baseEpoch: 7 });
    await channel.publish('QUFB', 9);

    // Never chat-delivery: it gates on a `dm_group_members` row this group has none of.
    expect(ctx.delivery.fetchGroupInfo).not.toHaveBeenCalled();
    expect(ctx.delivery.storeGroupInfo).not.toHaveBeenCalled();
    expect(ctx.distributionGroupInfo.publish).toHaveBeenCalledWith('ws-1', 'QUFB', 9);
  });

  it('throws rather than falling back to chat-delivery when no transport is wired', () => {
    const ctx = makeCtx({ distributionGroupInfo: null });
    proto.registerDistributionGroup.call(ctx, 'ws-1', 'g-1');

    // Routing it to chat-delivery would produce a 403 that reads like a permission problem and
    // send the next reader to entirely the wrong place. A wiring bug must look like one.
    expect(() => proto.groupInfoChannel.call(ctx, 'g-1')).toThrow(/transport/i);
  });
});

describe('joining on first use', () => {
  const REF_PUBLISHED = { groupId: 'g-1', groupInfo: 'c29j', baseEpoch: 7 };
  const REF_FRESH = { groupId: 'g-1', groupInfo: null, baseEpoch: null };

  it('registers the group even when it is already held locally', async () => {
    const ctx = makeCtx({ getLocalGroups: vi.fn().mockReturnValue(['g-1']) });

    expect(await ensure(ctx, 'ws-1', REF_PUBLISHED)).toBe(true);
    // Registration is not a side effect of joining: the frame router needs it on every start,
    // including the one where there was nothing to join.
    expect(proto.isDistributionGroup.call(ctx, 'g-1')).toBe(true);
    expect(ctx.createGroup).not.toHaveBeenCalled();
    expect(ctx.externalJoin).not.toHaveBeenCalled();
  });

  it('external-joins a published base rather than creating anything', async () => {
    const ctx = makeCtx();

    expect(await ensure(ctx, 'ws-1', REF_PUBLISHED)).toBe(true);
    expect(ctx.externalJoin).toHaveBeenCalledWith('g-1');
    expect(ctx.createGroup).not.toHaveBeenCalled();
  });

  it('creates the group and publishes the base when this device is the first one in', async () => {
    const ctx = makeCtx();

    expect(await ensure(ctx, 'ws-1', REF_FRESH)).toBe(true);
    expect(ctx.createGroup).toHaveBeenCalledWith('g-1');
    expect(ctx.distributionGroupInfo.publish).toHaveBeenCalledWith('ws-1', expect.any(String), 0);
    expect(ctx.externalJoin).not.toHaveBeenCalled();
    expect(ctx.forgetGroup).not.toHaveBeenCalled();
  });

  it('throws its own group away and joins the winner when it loses the first publish', async () => {
    const ctx = makeCtx();
    ctx.distributionGroupInfo.publish.mockResolvedValue({ stored: false });

    expect(await ensure(ctx, 'ws-1', REF_FRESH)).toBe(true);
    // Keeping it would fork the community: two MLS groups under one id, each holding half the
    // seeds, with nothing on either side ever reporting it.
    expect(ctx.forgetGroup).toHaveBeenCalledWith('g-1');
    expect(ctx.externalJoin).toHaveBeenCalledWith('g-1');
  });

  it('discards a group whose base could not be published at all', async () => {
    const ctx = makeCtx();
    ctx.distributionGroupInfo.publish.mockRejectedValue(new Error('offline'));

    expect(await ensure(ctx, 'ws-1', REF_FRESH)).toBe(false);
    // A group held locally that nobody can join is worse than no group: the next call would find
    // it in `getLocalGroups` and return early, for ever.
    expect(ctx.forgetGroup).toHaveBeenCalledWith('g-1');
  });
});

describe('routing a frame that arrived on the group', () => {
  function registered(overrides: Record<string, unknown> = {}) {
    const ctx = makeCtx(overrides);
    proto.registerDistributionGroup.call(ctx, 'ws-1', 'g-1');
    return ctx;
  }

  it('hands the decrypted payload to the Graine handler and acknowledges', async () => {
    const ctx = registered();

    expect(await route(ctx, 'g-1', 'peer', new Uint8Array([1]))).toBe(true);
    expect(ctx.distributionFrameHandler).toHaveBeenCalledWith({
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
