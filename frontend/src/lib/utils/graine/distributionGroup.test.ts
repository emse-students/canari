import { ensureCommunityDistributionGroup } from './distributionGroup';
import { ChannelApiError } from '$lib/services/ChannelService';
import { setGraineRuntime } from './runtime';
import { workspaceScope } from '$lib/mls-client/distributionScope';

const reconcile = vi.fn().mockResolvedValue([]);
vi.mock('./rosterReconcile', () => ({
  reconcileDistributionGroupRoster: (...args: unknown[]) => reconcile(...args),
}));

beforeEach(() => reconcile.mockClear());

/**
 * The seam between the two services, on the client.
 *
 * What matters here is that the three ways this can fail stay three: a community with no
 * distribution group at all (a server-side gap somebody has to fix), a refusal (this user is not a
 * member any more), and transport. They are told apart by the server's `code`, never by the
 * sentence in the message - a distinction carried in prose is one exactly one call site ever makes.
 */

function makeMls(overrides: Record<string, unknown> = {}) {
  return {
    distributionGroupFor: vi.fn().mockReturnValue(null),
    getLocalGroups: vi.fn().mockReturnValue([]),
    ensureDistributionGroup: vi.fn().mockResolvedValue({ joined: true }),
    // The published base matches the group's epoch in every case here, so nothing republishes; the
    // stale-base repair has its own describe block below and sets these itself.
    getEpoch: vi.fn().mockReturnValue(7),
    refreshGroupInfo: vi.fn().mockResolvedValue(undefined),
    forgetDistributionGroup: vi.fn().mockReturnValue('g-1'),
    forgetDistributionGroupById: vi.fn().mockReturnValue(true),
    registerDistributionGroup: vi.fn(),
    getDeviceId: vi.fn().mockReturnValue('dev-me'),
    // The checkpoint's landing place: with no session persister registered, a structural checkpoint
    // falls back to the MLS service the caller was handed - so counting calls here counts the
    // writes to disk.
    persistCheckpoint: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** A device that holds the group locally - the state a re-grant used to strand for ever. */
function makeHeldMls(overrides: Record<string, unknown> = {}) {
  return makeMls({
    distributionGroupFor: vi.fn().mockReturnValue('g-1'),
    getLocalGroups: vi.fn().mockReturnValue(['g-1']),
    ...overrides,
  });
}

function makeChannels(overrides: Record<string, unknown> = {}) {
  return {
    getDistributionGroup: vi
      .fn()
      .mockResolvedValue({ groupId: 'g-1', groupInfo: 'c29j', baseEpoch: 7, activeEpoch: 7 }),
    ...overrides,
  };
}

const run = (mls: unknown, channels: unknown, log: (m: string) => void = () => {}) =>
  ensureCommunityDistributionGroup(mls as never, channels as never, 'ws-1', log);

describe('ensureCommunityDistributionGroup - concurrent callers share one join', () => {
  /**
   * TWO CALLERS ON ONE GESTURE, which is what production did.
   *
   * Creating a private salon initialises its MLS state, and the workspace refetch that puts the new
   * salon in the sidebar walks every private channel and enters its group - so one click reaches this
   * seam twice for the same scope. Measured 2026-08-21: both calls read a group with no roster row,
   * both created and published epoch 0, and the second then saw a group held locally that the server
   * named no row for - the signature of an eviction - so it FORGOT the tree the first call had just
   * built and joined again, costing an epoch and leaving a leaf behind.
   *
   * A race that heals is still a defect, so what is pinned is the absence of the overlap: one
   * execution, whatever the number of callers.
   */
  it('runs the join once when two callers arrive together', async () => {
    let release: (v: unknown) => void = () => {};
    const gate = new Promise((r) => (release = r));
    const mls = makeMls();
    const channels = makeChannels({
      getDistributionGroup: vi.fn(async () => {
        await gate;
        return {
          groupId: 'g-1',
          groupInfo: 'c29j',
          baseEpoch: 7,
          activeEpoch: 7,
          memberDevices: [],
        };
      }),
    });

    const both = Promise.all([run(mls, channels), run(mls, channels)]);
    release(null);
    expect(await both).toEqual([true, true]);

    // The read, the join and the reconciliation each happen ONCE - not once per caller.
    expect(channels.getDistributionGroup).toHaveBeenCalledTimes(1);
    expect(mls.ensureDistributionGroup).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('says so, so a caller that waited is not indistinguishable from one that did the work', async () => {
    let release: (v: unknown) => void = () => {};
    const gate = new Promise((r) => (release = r));
    const lines: string[] = [];
    const mls = makeMls();
    const channels = makeChannels({
      getDistributionGroup: vi.fn(async () => {
        await gate;
        return {
          groupId: 'g-1',
          groupInfo: 'c29j',
          baseEpoch: 7,
          activeEpoch: 7,
          memberDevices: [],
        };
      }),
    });

    const both = Promise.all([
      run(mls, channels, (m) => lines.push(m)),
      run(mls, channels, (m) => lines.push(m)),
    ]);
    release(null);
    await both;

    expect(lines.some((l) => l.includes('a join is already in flight'))).toBe(true);
  });

  it('holds nothing after it settles, so a later join runs for real', async () => {
    // The entry is removed in `finally`. Without that, the FIRST join of a session would answer
    // every later one - including the re-join a revoke makes necessary, which is the one that must
    // not be skipped.
    const mls = makeMls();
    const channels = makeChannels({
      getDistributionGroup: vi.fn().mockResolvedValue({
        groupId: 'g-1',
        groupInfo: 'c29j',
        baseEpoch: 7,
        activeEpoch: 7,
        memberDevices: [],
      }),
    });

    await run(mls, channels);
    await run(mls, channels);

    expect(channels.getDistributionGroup).toHaveBeenCalledTimes(2);
    expect(mls.ensureDistributionGroup).toHaveBeenCalledTimes(2);
  });

  it('shares a REJECTION too, and leaves nothing behind for the next caller', async () => {
    // A failed join must not poison the map: the next attempt has to be a real attempt.
    const mls = makeMls();
    let attempts = 0;
    const channels = makeChannels({
      getDistributionGroup: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new ChannelApiError(503, null, 'the gateway is down');
        return {
          groupId: 'g-1',
          groupInfo: 'c29j',
          baseEpoch: 7,
          activeEpoch: 7,
          memberDevices: [],
        };
      }),
    });

    expect(await Promise.all([run(mls, channels), run(mls, channels)])).toEqual([false, false]);
    expect(await run(mls, channels)).toBe(true);
    expect(attempts).toBe(2);
  });
});

describe('ensureCommunityDistributionGroup', () => {
  it('re-joins nothing when the group is held AND the server routes to this device', async () => {
    const mls = makeHeldMls();
    const channels = makeChannels({
      getDistributionGroup: vi.fn().mockResolvedValue({
        groupId: 'g-1',
        groupInfo: null,
        baseEpoch: 7,
        activeEpoch: 7,
        memberDevices: ['dev-me'],
      }),
    });

    expect(await run(mls, channels)).toBe(true);
    // Held is a MEMORY of having joined; the rows are the fact. Asking is what tells them apart, so
    // the ask happens on this branch too - it just changes nothing when the two agree.
    expect(channels.getDistributionGroup).toHaveBeenCalledWith(workspaceScope('ws-1'));
    expect(mls.forgetDistributionGroupById).not.toHaveBeenCalled();
    expect(mls.ensureDistributionGroup).not.toHaveBeenCalled();
  });

  it('records the scope-group pair on the branch that joins nothing', async () => {
    // The join used to be the only thing that registered it, and the join is reached only when one
    // is owed - so a device holding the group with a registration that did not name it returned
    // true while every scope-keyed reader saw nothing. Measured on production 2026-08-21 as
    // `no distribution group held for ... - roster not reconciled`, on every community, every load.
    const mls = makeHeldMls();
    const channels = makeChannels({
      getDistributionGroup: vi.fn().mockResolvedValue({
        groupId: 'g-1',
        groupInfo: null,
        baseEpoch: 7,
        activeEpoch: 7,
        memberDevices: ['dev-me'],
      }),
    });

    expect(await run(mls, channels)).toBe(true);
    expect(mls.ensureDistributionGroup).not.toHaveBeenCalled();
    expect(mls.registerDistributionGroup).toHaveBeenCalledWith(workspaceScope('ws-1'), 'g-1');
  });

  it('re-joins when the group is registered but no longer held locally', async () => {
    const mls = makeMls({ distributionGroupFor: vi.fn().mockReturnValue('g-1') });
    const channels = makeChannels();

    expect(await run(mls, channels)).toBe(true);
    expect(channels.getDistributionGroup).toHaveBeenCalledWith(workspaceScope('ws-1'));
    expect(mls.ensureDistributionGroup).toHaveBeenCalledWith(workspaceScope('ws-1'), {
      groupId: 'g-1',
      groupInfo: 'c29j',
      baseEpoch: 7,
      activeEpoch: 7,
    });
  });

  it('names a community that has no distribution group at all', async () => {
    const log = vi.fn();
    const channels = makeChannels({
      getDistributionGroup: vi
        .fn()
        .mockRejectedValue(
          new ChannelApiError(404, 'WORKSPACE_HAS_NO_DISTRIBUTION_GROUP', 'no group')
        ),
    });
    const mls = makeMls();

    expect(await run(mls, channels, log)).toBe(false);
    expect(log.mock.calls.flat().join(' ')).toMatch(/NO distribution group/);
    expect(mls.ensureDistributionGroup).not.toHaveBeenCalled();
  });

  it('calls a 403 what it is - an answer - and not a read that failed', async () => {
    // THIS TEST USED TO ASSERT THE DEFECT. It required the `could not read` line, which is the
    // sentence written for transport, so a 403 - the one refusal that settles entitlement - was
    // pinned as indistinguishable from a lost packet.
    const log = vi.fn();
    const channels = makeChannels({
      getDistributionGroup: vi
        .fn()
        .mockRejectedValue(new ChannelApiError(403, null, 'Not a member of this workspace')),
    });

    expect(await run(makeMls(), channels, log)).toBe(false);
    const said = log.mock.calls.flat().join(' ');
    expect(said).toMatch(/NOT entitled/);
    expect(said).toMatch(/no retry can help/);
    // Neither of the two lines it must not be: this community HAS a group, and the read did answer.
    expect(said).not.toMatch(/NO distribution group/);
    expect(said).not.toMatch(/could not read/);
  });

  it('reports a join that failed, rather than returning success', async () => {
    const log = vi.fn();
    const mls = makeMls({
      ensureDistributionGroup: vi
        .fn()
        .mockResolvedValue({ joined: false, reason: 'refused', serverReason: 'epoch_mismatch' }),
    });

    expect(await run(mls, makeChannels(), log)).toBe(false);
    expect(log.mock.calls.flat().join(' ')).toMatch(/could not join/);
  });
});

/**
 * WP-REGRANT-1, measured on production 2026-08-21: a member removed from a private salon and then
 * let back in was never routed again. The eviction deletes the delivery rows at once while the MLS
 * removal is committed later by a remaining member - published to a group the leaver is no longer
 * routed from - so the leaver never learns it was removed and keeps a live local group for ever.
 * Held-therefore-member then took the early return on every subsequent load, and the join, which is
 * the ONLY writer of delivery rows, never ran again.
 */
describe('ensureCommunityDistributionGroup - a held group the server routes nothing to', () => {
  const heldButUnrouted = () =>
    makeChannels({
      getDistributionGroup: vi.fn().mockResolvedValue({
        groupId: 'g-1',
        groupInfo: 'c29j',
        baseEpoch: 7,
        activeEpoch: 7,
        memberDevices: [],
      }),
    });

  it('forgets it and re-joins, so the rows are written back', async () => {
    const mls = makeHeldMls();

    expect(await run(mls, heldButUnrouted())).toBe(true);
    // In this order, and the order is the fix: `ensureDistributionGroup` returns early on a group
    // it already holds, so re-joining without forgetting first would be a no-op.
    // BY GROUP ID: the scope registration is the layer that may be wrong, and resolving through it
    // would forget nothing and leave the join to early-return on the tree it left standing.
    expect(mls.forgetDistributionGroupById).toHaveBeenCalledWith('g-1');
    expect(mls.ensureDistributionGroup).toHaveBeenCalledWith(workspaceScope('ws-1'), {
      groupId: 'g-1',
      groupInfo: 'c29j',
      baseEpoch: 7,
      activeEpoch: 7,
      memberDevices: [],
    });
  });

  it('accuses, because a repair with no report is a defect nobody counts', async () => {
    const log = vi.fn();

    expect(await run(makeHeldMls(), heldButUnrouted(), log)).toBe(true);
    expect(log.mock.calls.flat().join(' ')).toMatch(/holds NO row for it/);
  });

  it('keeps another device of the same user from counting as this one', async () => {
    // The server answers with THIS user's devices in the group. A second, still-routed device of
    // the same user says nothing about whether this one is routed.
    const mls = makeHeldMls();
    const channels = makeChannels({
      getDistributionGroup: vi.fn().mockResolvedValue({
        groupId: 'g-1',
        groupInfo: 'c29j',
        baseEpoch: 7,
        activeEpoch: 7,
        memberDevices: ['dev-other'],
      }),
    });

    expect(await run(mls, channels)).toBe(true);
    expect(mls.forgetDistributionGroupById).toHaveBeenCalledWith('g-1');
  });

  it('leaves an UNPUBLISHED group alone, because its empty roster is not an eviction', async () => {
    // `groupInfo: null` is "the row exists but no client has initialised the MLS group yet", so no
    // delivery row has been written for anyone and an empty roster is the state before an answer.
    // Measured on production 2026-08-25: the heal fired on a salon the same run had just created.
    const mls = makeHeldMls();
    const channels = makeChannels({
      getDistributionGroup: vi.fn().mockResolvedValue({
        groupId: 'g-1',
        groupInfo: null,
        baseEpoch: null,
        activeEpoch: 0,
        memberDevices: [],
      }),
    });

    expect(await run(mls, channels)).toBe(true);
    expect(mls.forgetDistributionGroupById).not.toHaveBeenCalled();
  });

  it('says why it left it alone, so the race is not repaired in silence', async () => {
    const log = vi.fn();
    const channels = makeChannels({
      getDistributionGroup: vi.fn().mockResolvedValue({
        groupId: 'g-1',
        groupInfo: null,
        baseEpoch: null,
        activeEpoch: 0,
        memberDevices: [],
      }),
    });

    expect(await run(makeHeldMls(), channels, log)).toBe(true);
    const said = log.mock.calls.flat().join(' ');
    expect(said).toMatch(/not published yet/);
    // AND NOT THE ACCUSING ONE: the whole point is that this is no longer read as an eviction.
    expect(said).not.toMatch(/holds NO row for it/);
  });

  it('changes nothing when the server did not answer the question, and SAYS so', async () => {
    // `undefined` is "nobody asked" and never "no devices" - an older server, or a caller that did
    // not pass the reader. Reading it as an eviction would forget a healthy group on every load.
    // Unchanged is not the same as unremarked: without the line, "the roster agreed" and "nobody
    // asked" reach a run log looking identical, which is how the first version of this fix shipped
    // and measured as a no-op on production.
    const mls = makeHeldMls();
    const log = vi.fn();

    expect(await run(mls, makeChannels(), log)).toBe(true);
    expect(mls.forgetDistributionGroupById).not.toHaveBeenCalled();
    expect(mls.ensureDistributionGroup).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join(' ')).toMatch(/named no devices for this user/);
  });

  it('checks the group the SERVER names, not the one the scope registration remembers', async () => {
    // The registration is a second copy of the same fact and it can lag. Here it names nothing at
    // all while the tree is held - the exact state that made the first version of this fix a no-op
    // on production, because it read `distributionGroupFor(scope)` and concluded "not held", while
    // `ensureDistributionGroup` early-returns on the GROUP ID and concluded "already in".
    const mls = makeMls({
      distributionGroupFor: vi.fn().mockReturnValue(null),
      getLocalGroups: vi.fn().mockReturnValue(['g-1']),
    });

    expect(await run(mls, heldButUnrouted())).toBe(true);
    expect(mls.forgetDistributionGroupById).toHaveBeenCalledWith('g-1');
    expect(mls.ensureDistributionGroup).toHaveBeenCalled();
  });

  it('keeps a held group when the read itself failed', async () => {
    // A transport failure is not the server saying this device is out. The fetch used to happen
    // only when the group was NOT held, so it could never break a healthy load; now that it always
    // happens, a throw has to leave that path exactly as it was.
    const mls = makeHeldMls();
    const channels = makeChannels({
      getDistributionGroup: vi.fn().mockRejectedValue(new Error('network')),
    });
    const log = vi.fn();

    expect(await run(mls, channels, log)).toBe(true);
    expect(mls.forgetDistributionGroupById).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join(' ')).toMatch(/keeping the one this device holds/);
  });

  it('does NOT keep a held group on the strength of a 403, which is the server answering', async () => {
    // THE ORDER WAS THE DEFECT. This branch was reached before anything classified the refusal, so
    // a revoked member holding the tree reported `keeping the one this device holds` - a claim about
    // transport - and then reconciled and asked for history on a scope it had just been refused.
    const mls = makeHeldMls();
    const channels = makeChannels({
      getDistributionGroup: vi
        .fn()
        .mockRejectedValue(new ChannelApiError(403, null, 'Not a member of this workspace')),
    });
    const log = vi.fn();

    expect(await run(mls, channels, log)).toBe(false);
    const said = log.mock.calls.flat().join(' ');
    expect(said).toMatch(/NOT entitled/);
    expect(said).not.toMatch(/keeping the one this device holds/);
    // AND NOTHING DESTRUCTIVE EITHER: dropping key material on one answer is its own decision.
    expect(mls.forgetDistributionGroupById).not.toHaveBeenCalled();
  });
});

describe('ensureCommunityDistributionGroup - reconciling the tree with the roster', () => {
  it('reconciles on the branch that was already in the group', async () => {
    const mls = makeMls({
      distributionGroupFor: vi.fn().mockReturnValue('g-1'),
      getLocalGroups: vi.fn().mockReturnValue(['g-1']),
    });

    expect(await run(mls, makeChannels())).toBe(true);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('reconciles on the branch that has just joined', async () => {
    // The device that just joined can carry a departure as well as one that has been in the group
    // for a week; a pass that only ran on the other branch would leave a community whose members
    // all reconnect fresh with a tree nobody ever prunes.
    expect(await run(makeMls(), makeChannels())).toBe(true);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('reconciles nothing when the group could not be joined', async () => {
    const mls = makeMls({
      ensureDistributionGroup: vi
        .fn()
        .mockResolvedValue({ joined: false, reason: 'refused', serverReason: 'epoch_mismatch' }),
    });

    expect(await run(mls, makeChannels())).toBe(false);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('still loads the community when the reconciliation fails', async () => {
    // A tree still holding a departed leaf works for every message from now on, badly. Refusing to
    // load the community over it would only mean nobody ever prunes it.
    reconcile.mockRejectedValueOnce(new Error('commit rejected'));
    const lines: string[] = [];

    expect(await run(makeMls(), makeChannels(), (m) => lines.push(m))).toBe(true);
    expect(lines.some((l) => l.includes('roster reconciliation failed'))).toBe(true);
  });
});

/**
 * A TREE THAT MOVED IN MEMORY ONLY IS A TREE THE NEXT LOAD WALKS BACK INTO (WP-REGRANT-2).
 *
 * The re-join above forgets a stale group and joins again. Neither half was ever written to disk:
 * the walk that loads a community does not checkpoint, the MLS layer's join path does not, and the
 * roster reconciliation that runs immediately afterwards persists only when it actually removed a
 * leaf. So the failure mode was not the join failing - it was the FORGET not surviving. A device
 * that forgot a stale tree and then failed to re-join reloaded straight back into the tree it had
 * just dropped, took the early return every time after that, and read nothing from the salon again.
 *
 * Measured on production 2026-08-25: one second after `could not join the distribution group`, the
 * same device logged `[SYNC] WASM kept` for the group it had just forgotten.
 *
 * These pin the checkpoint on both outcomes AND its absence when nothing moved - an unconditional
 * one would cost an Argon2 pass per salon on every load, which is what the early return above
 * exists to avoid.
 */
describe('ensureCommunityDistributionGroup - a tree that moved is written to disk', () => {
  /** Published, and naming no device of this user: the signature of an eviction. */
  const evicted = () =>
    makeChannels({
      getDistributionGroup: vi.fn().mockResolvedValue({
        groupId: 'g-1',
        groupInfo: 'c29j',
        baseEpoch: 7,
        activeEpoch: 7,
        memberDevices: [],
      }),
    });

  /** Published, and naming this device: nothing to repair. */
  const routed = () =>
    makeChannels({
      getDistributionGroup: vi.fn().mockResolvedValue({
        groupId: 'g-1',
        groupInfo: 'c29j',
        baseEpoch: 7,
        activeEpoch: 7,
        memberDevices: ['dev-me'],
      }),
    });

  /**
   * The runtime is what the checkpoint travels through, so it is installed rather than mocked: the
   * degrade branch is a case of its own below and must be reachable by ABSENCE, not by a stub.
   */
  beforeEach(() => {
    setGraineRuntime({
      storage: {} as never,
      deviceKeyB64: 'device-key',
      userId: 'alice',
      mlsService: {} as never,
    });
  });
  afterEach(() => setGraineRuntime(null));

  it('writes the forget to disk when the re-join then fails - the state that used to strand a device', async () => {
    const mls = makeHeldMls({
      ensureDistributionGroup: vi
        .fn()
        .mockResolvedValue({ joined: false, reason: 'refused', serverReason: 'epoch_mismatch' }),
    });

    expect(await run(mls, evicted())).toBe(false);

    // ONE checkpoint, and it carries the session's device key: the forget is on disk before the
    // caller is told the join failed, so the next load finds no group held and asks again.
    expect(mls.forgetDistributionGroupById).toHaveBeenCalledWith('g-1');
    expect(mls.persistCheckpoint).toHaveBeenCalledTimes(1);
    expect(mls.persistCheckpoint).toHaveBeenCalledWith('device-key');
  });

  it('says what the checkpoint bought, so the give-up line is not the last word on a dead salon', async () => {
    const mls = makeHeldMls({
      ensureDistributionGroup: vi
        .fn()
        .mockResolvedValue({ joined: false, reason: 'refused', serverReason: 'epoch_mismatch' }),
    });
    const lines: string[] = [];

    await run(mls, evicted(), (m) => lines.push(m));

    const giveUp = lines.find((l) => l.includes('could not join the distribution group'));
    expect(giveUp).toContain('the next load asks again');
  });

  it('writes a successful re-join too, so the epoch it cost is not paid again next load', async () => {
    const mls = makeHeldMls();

    expect(await run(mls, evicted())).toBe(true);

    expect(mls.persistCheckpoint).toHaveBeenCalledTimes(1);
  });

  it('writes a first join, so the leaf it minted is not left behind by the next one', async () => {
    const mls = makeMls();

    expect(await run(mls, makeChannels())).toBe(true);

    expect(mls.forgetDistributionGroupById).not.toHaveBeenCalled();
    expect(mls.persistCheckpoint).toHaveBeenCalledTimes(1);
  });

  /**
   * THE COST GUARD. A device already in the group takes the early return, and on a community with
   * twenty private salons an unconditional checkpoint would be twenty Argon2 passes per load for a
   * tree nothing touched.
   */
  it('does not checkpoint a load that changed nothing', async () => {
    const mls = makeHeldMls();

    expect(await run(mls, routed())).toBe(true);

    expect(mls.persistCheckpoint).not.toHaveBeenCalled();
  });

  /**
   * A JOIN THAT FAILED WITHOUT FORGETTING ANYTHING left memory and disk agreeing that this device
   * holds nothing - which is already the truth, and already the state the next trigger repairs.
   */
  it('does not checkpoint a failed first join', async () => {
    const mls = makeMls({
      ensureDistributionGroup: vi
        .fn()
        .mockResolvedValue({ joined: false, reason: 'refused', serverReason: 'epoch_mismatch' }),
    });

    expect(await run(mls, makeChannels())).toBe(false);

    expect(mls.persistCheckpoint).not.toHaveBeenCalled();
  });

  /**
   * DEGRADES, AND ACCUSES. A checkpoint that cannot be written must not fail the join it describes,
   * but silence here would mean a device stranded exactly as before with nothing saying why.
   */
  it('says so when there is no session to checkpoint through', async () => {
    setGraineRuntime(null);
    const mls = makeHeldMls({
      ensureDistributionGroup: vi
        .fn()
        .mockResolvedValue({ joined: false, reason: 'refused', serverReason: 'epoch_mismatch' }),
    });
    const lines: string[] = [];

    expect(await run(mls, evicted(), (m) => lines.push(m))).toBe(false);

    expect(mls.persistCheckpoint).not.toHaveBeenCalled();
    expect(lines.some((l) => l.includes('changed in memory only'))).toBe(true);
  });
});

/**
 * The repair for COMM-8, measured on production 2026-08-25.
 *
 * The external-join base is minted by the device whose commit was just accepted, in a follow-up
 * call, and NOTHING else ever mints one. Lose that call and the group's epoch advances while the
 * published base does not - and the commit gate accepts a base equal to the active epoch and
 * nothing else, so from that moment every device without local MLS state is refused, for ever. A
 * distribution group has no peer-Welcome fallback by construction, so that is a permanent lockout
 * from a salon the user is entitled to.
 *
 * The trigger pinned here is a HOLDER's ordinary read - not a timer, not a sweep - and the
 * termination condition is the server's own `baseEpoch >= activeEpoch`.
 */
describe('ensureCommunityDistributionGroup - a published base the group has outrun', () => {
  /** Published at 5 while the group is at 7: no stateless device can get in. */
  const stale = () =>
    makeChannels({
      getDistributionGroup: vi.fn().mockResolvedValue({
        groupId: 'g-1',
        groupInfo: 'c29j',
        baseEpoch: 5,
        activeEpoch: 7,
        memberDevices: ['dev-me'],
      }),
    });

  it('republishes from the tree this device holds', async () => {
    const mls = makeHeldMls({ getEpoch: vi.fn().mockReturnValue(7) });

    expect(await run(mls, stale())).toBe(true);

    expect(mls.refreshGroupInfo).toHaveBeenCalledWith('g-1');
    // The repair rides an early return that joins nothing, so it must not perturb the rest of it.
    expect(mls.ensureDistributionGroup).not.toHaveBeenCalled();
  });

  it('accuses when it repairs, because the rate is what says whether the loss is rare', async () => {
    const mls = makeHeldMls({ getEpoch: vi.fn().mockReturnValue(7) });
    const lines: string[] = [];

    await run(mls, stale(), (m) => lines.push(m));

    // The three numbers and the accusation are what this asserts; the sentence itself moved to
    // `chat/staleBase.ts` on 2026-09-04, when the connect-time repair for ordinary conversations
    // started reading the same predicate. What stays Graine's is the scope label.
    const said = lines.find((l) => l.includes('the published base is at epoch 5'));
    expect(said).toContain('group is at 7');
    expect(said).toContain('republishing');
    expect(said).toContain('[GRAINE]');
  });

  it('publishes nothing from a device whose own tree is behind the group', async () => {
    // Its export would be refused by the same gate, so publishing it would replace one unusable
    // base with another and report success. Some other member will be current.
    const mls = makeHeldMls({ getEpoch: vi.fn().mockReturnValue(6) });
    const lines: string[] = [];

    expect(await run(mls, stale(), (m) => lines.push(m))).toBe(true);

    expect(mls.refreshGroupInfo).not.toHaveBeenCalled();
    const said = lines.find((l) => l.includes("this device's tree is at 6"));
    expect(said).toContain('cannot mint a');
    // Still labelled, so a salon's lockout stays legible in a run log full of other groups.
    expect(said).toContain('[GRAINE]');
  });

  it('sends nothing in the common case, where the two epochs already agree', async () => {
    const mls = makeHeldMls();

    expect(await run(mls, makeChannels())).toBe(true);

    expect(mls.refreshGroupInfo).not.toHaveBeenCalled();
  });

  it('leaves an UNPUBLISHED base alone - absent is not stale', async () => {
    // `activeEpoch` defaults to the base on an older build, and a group with no base at all has
    // nothing to republish: the first device in publishes it through the create path instead.
    const mls = makeHeldMls();
    const channels = makeChannels({
      getDistributionGroup: vi.fn().mockResolvedValue({
        groupId: 'g-1',
        groupInfo: null,
        baseEpoch: null,
        activeEpoch: 0,
        memberDevices: ['dev-me'],
      }),
    });

    await run(mls, channels);

    expect(mls.refreshGroupInfo).not.toHaveBeenCalled();
  });
});
