import protobuf from 'protobufjs';
import type { IStorage, StoredGraineSession } from '$lib/db/types';
import { canari } from '$lib/proto/canari';
import { addressedKeyMaterial } from '$lib/mls-client/frameDelivery';
import {
  channelScope,
  workspaceScope,
  type DistributionScope,
} from '$lib/mls-client/distributionScope';
import {
  decodeAppMessage,
  encodeAppMessage,
  mkGraine,
  mkGraineBundle,
  mkGraineRequest,
  mkText,
} from '$lib/proto/codec';
import { toBase64 } from '$lib/utils/hex';
import { encodeGraineEndorsementV2, graineSeedCommitment } from '$lib/crypto/graineV2';
import { GRAINE_BUNDLE_PAGE_MAX_BYTES } from '$lib/crypto/graineConstants';
import { ed25519PublicKeyOf, webCryptoEngine } from '$lib/crypto/graineV2.testEngine';
import {
  encodeAdmissionVoucher,
  encodeDirectAdmission,
  mintInviteLinkGrant,
  redeemInviteLinkGrant,
} from '$lib/crypto/graineAdmission';
import type { DeviceSignatureKeys } from '$lib/mls-client/deviceKeyPackage';
import { handleDistributionFrame } from './frameHandler';
import { clearParkedAsks, MAX_PARKED_ASKS, parkedAskCount } from './parkedAsks';
import { BaseMlsService } from '$lib/services/BaseMlsService';
import type { MlsPerGroupScheduler } from '$lib/mls-client/mlsPerGroupScheduler';
import {
  announceGraineRepair,
  graineRepairHoldObserver,
  holdGraineRepairs,
  markCommunityListed,
  registerChannelWorkspace,
  registerCommunityHistoryVisibility,
  releaseGraineRepairs,
  setGraineRepairListener,
  setGraineRuntime,
} from './runtime';

/**
 * What arriving on a community's distribution group DOES (WP-32, inbound half).
 *
 * The rule worth a test is the one nothing else would ever complain about: a seed frame is DURABLE,
 * so this device meets its own seed again on every fresh start, and writing it back would drop the
 * `sentCount` that decides the next message index and the 100-message rotation.
 */

// The real walk, observed: the id the bundle quotes must reach it, or a decline never advances it.
const noteSeedUnavailableSpy = vi.fn();
const noteHistoryHeldNothingSpy = vi.fn();
vi.mock('./repair', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./repair')>();
  return {
    ...actual,
    noteHistoryHeldNothing: (...args: Parameters<typeof actual.noteHistoryHeldNothing>) => {
      noteHistoryHeldNothingSpy(...args);
      return actual.noteHistoryHeldNothing(...args);
    },
    noteSeedUnavailable: (...args: Parameters<typeof actual.noteSeedUnavailable>) => {
      noteSeedUnavailableSpy(...args);
      return actual.noteSeedUnavailable(...args);
    },
  };
});

vi.mock('./graineMirror', () => ({ mirrorGraineSeed: vi.fn().mockResolvedValue(undefined) }));

/** Where each session becomes readable for the asker - computed by the server, never here. */
const graineHistoryFloor = vi.fn();
/** The community's roster - arrival dates, creator mark and admission vouchers (section 25). */
const listWorkspaceMembers = vi.fn();
vi.mock('$lib/services/ChannelService', () => ({
  ChannelService: class {
    graineHistoryFloor(...args: unknown[]) {
      return graineHistoryFloor(...args);
    }
    listWorkspaceMembers(...args: unknown[]) {
      return listWorkspaceMembers(...args);
    }
  },
}));

/** An arrival before the admission proof existed: such a member is admitted by their date. */
const BEFORE_THE_PROOF = '2026-01-01T00:00:00.000Z';
/** An arrival after it: such a member needs a voucher. */
const AFTER_THE_PROOF = '2026-12-01T00:00:00.000Z';

/** A roster row as `listWorkspaceMembers` serves it. */
function member(
  userId: string,
  joinedAt = BEFORE_THE_PROOF,
  extra: { isCreator?: boolean; admissionVoucher?: string | null } = {}
) {
  return { id: `m-${userId}`, userId, role: 'member', joinedAt, ...extra };
}

beforeEach(() => {
  // Every member admitted before the proof existed, so every row that is not about admission sees
  // the past handed over exactly as before. The roots a device records are per account, durable.
  localStorage.clear();
  listWorkspaceMembers.mockReset();
  listWorkspaceMembers.mockResolvedValue(
    ['alice', 'bob', 'carol', 'newcomer'].map((id) => member(id))
  );
});

const SEED = new Uint8Array(32).fill(3);

/** carol's device credential key, and the session key she minted - real Ed25519, so G2-4 checks bite. */
const CAROL_DEVICE_SECRET = Uint8Array.from({ length: 32 }, (_, i) => 100 + i);
const SESSION_SECRET = Uint8Array.from({ length: 32 }, (_, i) => 50 + i);
let CAROL_DEVICE_PK: Uint8Array;

/**
 * The five v2 fields of a seed minted by carol on dev-c, endorsed over `frame()`'s channel, session,
 * seed and date. Built once: Ed25519 is deterministic, so every test sees the same bytes.
 */
let V2_WIRE: {
  version: number;
  minterUserId: string;
  minterDeviceId: string;
  signingPublicKey: Uint8Array;
  endorsement: Uint8Array;
};

beforeAll(async () => {
  CAROL_DEVICE_PK = await ed25519PublicKeyOf(CAROL_DEVICE_SECRET);
  const signingPublicKey = await ed25519PublicKeyOf(SESSION_SECRET);
  const descriptor = encodeGraineEndorsementV2({
    channelId: 'chan-1',
    sessionId: 'sess-1',
    minterUserId: 'carol',
    minterDeviceId: 'dev-c',
    signingPublicKey,
    seedCommitment: await graineSeedCommitment(SEED),
    createdAt: 1_700_000_000_000,
  });
  V2_WIRE = {
    version: 2,
    minterUserId: 'carol',
    minterDeviceId: 'dev-c',
    signingPublicKey,
    endorsement: await webCryptoEngine.signWithSessionKey(CAROL_DEVICE_SECRET, descriptor),
  };
});

/** carol's endorsed v2 fields for any salon and session - what a relayed bundle seed must carry. */
async function v2SeedFor(channelId: string, sessionId: string, firstIndex: number) {
  const descriptor = encodeGraineEndorsementV2({
    channelId,
    sessionId,
    minterUserId: 'carol',
    minterDeviceId: 'dev-c',
    signingPublicKey: V2_WIRE.signingPublicKey,
    seedCommitment: await graineSeedCommitment(SEED),
    createdAt: 1,
  });
  return {
    channelId,
    sessionId,
    seed: SEED,
    firstIndex,
    createdAt: 1,
    ...V2_WIRE,
    endorsement: await webCryptoEngine.signWithSessionKey(CAROL_DEVICE_SECRET, descriptor),
  };
}

/**
 * The key group's tree, as `memberSignatureKey` reads it, and the server's published history for
 * a device that has left it. carol:dev-c is in the tree unless a test takes her out.
 */
const tree = new Map<string, Uint8Array>();
/**
 * The leaves of the community's key group, as the admission gate observes them (section 25): every
 * member of the default roster has a device in it, so each is rooted the first time it is read.
 */
let leaves: string[] = [];
/**
 * The trees are KEYED BY GROUP, as the MLS layer's are: `leaves` and `tree` are the COMMUNITY's key
 * group (`communityGroup`), a private salon's own group (`g-private`) holds `salonLeaves` alone.
 * A gate that read a salon's tree as the community's would see different members here.
 */
let communityGroup = 'g-1';
let salonLeaves: string[] = [];
/** Departures per group then user (`removalEpochs`), as #2268 records them. */
const departuresByGroup = new Map<string, Map<string, number[]>>();
let published: DeviceSignatureKeys = { kind: 'keys', keys: [] };
function graineMls(extra: Record<string, unknown> = {}) {
  const leavesOf = (groupId: string) =>
    groupId === communityGroup ? leaves : groupId === 'g-private' ? salonLeaves : [];
  return {
    distributionGroupFor: (scope: DistributionScope) =>
      scope.kind === 'workspace' ? communityGroup : 'g-private',
    memberSignatureKey: async (groupId: string, identity: string) =>
      leavesOf(groupId).includes(identity) || groupId === communityGroup
        ? (tree.get(identity) ?? null)
        : null,
    getGroupMemberIdentities: async (groupId: string) => [...leavesOf(groupId)],
    getEpoch: () => 5,
    // Every group drained: a held commit is admissionGate.test.ts's row.
    isGroupDrained: () => true,
    whenGroupDrained: async () => undefined,
    pinnedSignatureKeys: async () => null,
    removalEpochs: async (groupId: string, userId: string) =>
      departuresByGroup.get(groupId)?.get(userId) ?? [],
    fetchDeviceSignatureKeys: async () => published,
    graineSignatureEngine: () => webCryptoEngine,
    getDeviceId: () => 'alice-laptop',
    ...extra,
  } as never;
}
beforeEach(() => {
  tree.clear();
  tree.set('carol:dev-c', CAROL_DEVICE_PK);
  leaves = ['alice:alice-laptop', 'bob:dev-b', 'carol:dev-c', 'newcomer:newcomer-web'];
  communityGroup = 'g-1';
  salonLeaves = [];
  departuresByGroup.clear();
  published = { kind: 'keys', keys: [] };
});
function fakeStorage(seed: StoredGraineSession[] = []) {
  const rows = new Map(seed.map((s) => [s.sessionId, s]));
  const saved: StoredGraineSession[] = [];
  return {
    rows,
    saved,
    storage: {
      getGraineSession: async (sessionId: string) => rows.get(sessionId) ?? null,
      saveGraineSession: async (s: StoredGraineSession) => {
        rows.set(s.sessionId, s);
        saved.push(s);
      },
    } as unknown as IStorage,
  };
}

function frame(overrides: Record<string, unknown> = {}) {
  return {
    scope: workspaceScope('ws-1'),
    workspaceId: 'ws-1',
    groupId: 'g-1',
    sender: 'Bob',
    plaintext: encodeAppMessage({
      ...mkGraine({
        channelId: 'chan-1',
        sessionId: 'sess-1',
        seed: SEED,
        firstIndex: 0,
        createdAt: 1_700_000_000_000,
        ...overrides,
      }),
    }),
  };
}

function wire(storage: IStorage) {
  setGraineRuntime({
    storage,
    deviceKey: () => 'device-key',
    userId: 'alice',
    mlsService: graineMls(),
  });
}

/**
 * Closes every repair hold a test left open. The hold depth is module state that `setGraineRuntime`
 * deliberately keeps, since in production the MLS service closes what it opened. A test interrupted
 * between its hold and its release (a timeout under suite load) used to leave the depth at 1, and
 * every later test expecting an announcement then failed: one timeout became six failures. The probe
 * is announced through the public path, and releases go on until it is delivered, which is the
 * moment the depth is back to 0.
 */
function closeLeftoverHolds() {
  let delivered = false;
  setGraineRepairListener(() => {
    delivered = true;
  });
  announceGraineRepair(['probe']);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  for (let closed = 0; !delivered; closed++) {
    if (closed === 16) throw new Error('a repair hold could not be closed after 16 releases');
    releaseGraineRepairs();
  }
  warn.mockRestore();
}

afterEach(() => {
  closeLeftoverHolds();
  setGraineRuntime(null);
});

describe('a seed arriving on the distribution group', () => {
  it('is stored with no counters of ours', async () => {
    const { storage, saved } = fakeStorage();
    wire(storage);

    await handleDistributionFrame(frame(V2_WIRE));

    // Under the MINTER its endorsement names, never the relaying sender ('Bob' here).
    expect(saved[0]).toMatchObject({
      workspaceId: 'ws-1',
      channelId: 'chan-1',
      sessionId: 'sess-1',
      senderId: 'carol',
      firstIndex: 0,
    });
    // Neither is ours to invent: `sentCount` is what marks a session as THIS device's outbound
    // one, and the roster it was minted under is a judgement only its sender may make.
    expect(saved[0].sentCount).toBeUndefined();
    expect(saved[0].distributionEpoch).toBeUndefined();
  });

  // Section 21.7: since `minClientVersion` is the v2 writer, no honest client mints a v1 seed, and
  // accepting one would let its sender post under any member's name.
  it('REFUSES a new v1 seed: nothing stored, mirrored or announced, and says so', async () => {
    const { mirrorGraineSeed } = await import('./graineMirror');
    vi.mocked(mirrorGraineSeed).mockClear();
    const { storage, saved } = fakeStorage();
    wire(storage);
    const repaired: string[][] = [];
    setGraineRepairListener((ids) => repaired.push(ids));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await handleDistributionFrame(frame());

    expect(saved).toHaveLength(0);
    expect(mirrorGraineSeed).not.toHaveBeenCalled();
    expect(repaired).toEqual([]);
    expect(String(warn.mock.calls.at(-1)?.[0])).toContain('REFUSED v1 seed sess-1 from Bob');
    // A warn: the durable log still replays v1 frames honest clients sent before the floor moved.
    expect(error).not.toHaveBeenCalled();
    setGraineRepairListener(null);
    warn.mockRestore();
    error.mockRestore();
  });

  it('does NOT overwrite a session of its own when the durable copy comes back', async () => {
    const mine: StoredGraineSession = {
      workspaceId: 'ws-1',
      channelId: 'chan-1',
      sessionId: 'sess-1',
      senderId: 'alice',
      seedB64: toBase64(SEED),
      firstIndex: 0,
      createdAt: 1,
      sentCount: 42,
      distributionEpoch: 4,
    };
    const { storage, saved } = fakeStorage([mine]);
    wire(storage);

    await handleDistributionFrame({ ...frame(), sender: 'alice' });

    // Writing it would reset `sentCount` to absent: the next send would hand out index 0 again,
    // re-using a key already used 42 times over, with no symptom at either end.
    expect(saved).toHaveLength(0);
    expect(storage.getGraineSession).toBeDefined();
  });

  it('lowers a handover floor, because a lower floor is strictly more history', async () => {
    const { storage, saved } = fakeStorage([
      {
        workspaceId: 'ws-1',
        channelId: 'chan-1',
        sessionId: 'sess-1',
        senderId: 'bob',
        seedB64: toBase64(SEED),
        firstIndex: 40,
        createdAt: 1,
      },
    ]);
    wire(storage);

    await handleDistributionFrame(frame({ firstIndex: 0 }));

    expect(saved[0].firstIndex).toBe(0);
  });

  it('keeps the session under whoever it was recorded under when an ANSWERER lowers the floor', async () => {
    const { storage, saved } = fakeStorage([
      {
        workspaceId: 'ws-1',
        channelId: 'chan-1',
        sessionId: 'sess-1',
        senderId: 'bob',
        seedB64: toBase64(SEED),
        firstIndex: 40,
        createdAt: 1,
      },
    ]);
    wire(storage);

    // A repair bundle is sent by whoever answered, not by the session's sender.
    await handleDistributionFrame({ ...frame({ firstIndex: 0 }), sender: 'Carol' });

    expect(saved[0]).toMatchObject({ senderId: 'bob', firstIndex: 0, createdAt: 1 });
  });

  it('refuses a held session re-sent with OTHER BYTES, and says so', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { storage, saved, rows } = fakeStorage([
      {
        workspaceId: 'ws-1',
        channelId: 'chan-1',
        sessionId: 'sess-1',
        senderId: 'bob',
        seedB64: toBase64(SEED),
        firstIndex: 40,
        createdAt: 1,
      },
    ]);
    wire(storage);

    // A lower floor is what a genuine repair carries, so it must not be the way past the check.
    await handleDistributionFrame({
      ...frame({ firstIndex: 0, seed: new Uint8Array(32).fill(9) }),
      sender: 'Mallory',
    });

    expect(saved).toHaveLength(0);
    expect(rows.get('sess-1')?.seedB64).toBe(toBase64(SEED));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('REFUSED seed replacement'));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('different seed'));
    error.mockRestore();
  });

  it('refuses a held session re-sent for ANOTHER SALON', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { storage, saved } = fakeStorage([
      {
        workspaceId: 'ws-1',
        channelId: 'chan-1',
        sessionId: 'sess-1',
        senderId: 'bob',
        seedB64: toBase64(SEED),
        firstIndex: 40,
        createdAt: 1,
      },
    ]);
    wire(storage);

    await handleDistributionFrame(frame({ firstIndex: 0, channelId: 'chan-2' }));

    expect(saved).toHaveLength(0);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('different salon'));
    error.mockRestore();
  });

  it('refuses a replacement of its OWN session too, rather than reading it as a durable replay', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { storage, saved } = fakeStorage([
      {
        workspaceId: 'ws-1',
        channelId: 'chan-1',
        sessionId: 'sess-1',
        senderId: 'alice',
        seedB64: toBase64(SEED),
        firstIndex: 0,
        createdAt: 1,
        sentCount: 3,
      },
    ]);
    wire(storage);

    await handleDistributionFrame(frame({ seed: new Uint8Array(32).fill(9) }));

    expect(saved).toHaveLength(0);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('REFUSED seed replacement'));
    error.mockRestore();
  });

  it('ignores a replay that would raise the floor', async () => {
    const { storage, saved } = fakeStorage([
      {
        workspaceId: 'ws-1',
        channelId: 'chan-1',
        sessionId: 'sess-1',
        senderId: 'bob',
        seedB64: toBase64(SEED),
        firstIndex: 0,
        createdAt: 1,
      },
    ]);
    wire(storage);

    await handleDistributionFrame(frame({ firstIndex: 40 }));

    // Accepting it would hide 40 messages this device can already read.
    expect(saved).toHaveLength(0);
  });

  it('tells the UI the salon became readable, not only a repair bundle does', async () => {
    const { storage } = fakeStorage();
    wire(storage);
    const repaired: string[][] = [];
    setGraineRepairListener((ids) => repaired.push(ids));

    await handleDistributionFrame(frame(V2_WIRE));

    // A seed reaches a device by TWO paths - its sender distributing it, and the distribution
    // group's durable log replaying it on reconnect - and only the second races the salon's own
    // history load. Losing that race dropped the rows as unreadable, and while only the bundle path
    // announced, nothing ever went back for them: a device that reconnected into an open salon sat
    // in front of a blank history whose seed it was already holding.
    expect(repaired).toEqual([['chan-1']]);
    setGraineRepairListener(null);
  });

  // Production web console 2026-10-12 (v1.2.5): 26 new seeds for 3 salons in one drain became 26
  // history reloads (52 requests). Inside a drain the announcement waits for the drain's end.
  it('inside a drain, announces each salon ONCE at its end, however many seeds it brought', async () => {
    const { storage } = fakeStorage();
    wire(storage);
    const repaired: string[][] = [];
    setGraineRepairListener((ids) => repaired.push(ids));

    // Signed BEFORE the hold: 26 endorsements are the heaviest work in this file, and a test cut off
    // by a timeout should not be cut off holding the drain open.
    const salons = ['chan-1', 'chan-2', 'chan-3'];
    const seeds = await Promise.all(
      Array.from({ length: 26 }, (_, i) => v2SeedFor(salons[i % 3], `sess-${i}`, 0))
    );
    holdGraineRepairs();
    for (const seed of seeds) await handleDistributionFrame(frame(seed));
    // Twenty-six seeds stored, nothing re-read yet: the drain still has frames to read.
    expect(repaired).toEqual([]);

    releaseGraineRepairs();

    expect(repaired).toHaveLength(1);
    expect([...repaired[0]].sort()).toEqual(salons);
    setGraineRepairListener(null);
  });

  it('a nested drain releases at the OUTERMOST end, and an unmatched release changes nothing', async () => {
    const { storage } = fakeStorage();
    wire(storage);
    const repaired: string[][] = [];
    setGraineRepairListener((ids) => repaired.push(ids));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    holdGraineRepairs();
    holdGraineRepairs();
    await handleDistributionFrame(frame(await v2SeedFor('chan-1', 'sess-a', 0)));
    releaseGraineRepairs();
    expect(repaired).toEqual([]);
    releaseGraineRepairs();
    expect(repaired).toEqual([['chan-1']]);

    // The depth never goes negative: an announcement after a stray release is still delivered at once.
    releaseGraineRepairs();
    expect(warn).toHaveBeenCalledWith(
      '[GRAINE] repair hold released without a matching hold - ignored'
    );
    await handleDistributionFrame(frame(await v2SeedFor('chan-2', 'sess-b', 0)));
    expect(repaired).toEqual([['chan-1'], ['chan-2']]);
    warn.mockRestore();
    setGraineRepairListener(null);
  });

  // A history restore is a bulk-ingest window too, and the startup one spans every conversation's
  // replay. Holding on it kept a live seed's salon blank until all of them had been replayed.
  it('only the queue drain holds: a history-restore window announces at once', async () => {
    const { storage } = fakeStorage();
    wire(storage);
    const repaired: string[][] = [];
    setGraineRepairListener((ids) => repaired.push(ids));
    const restore = { bufferUi: false, showOverlay: false };
    const drain = { bufferUi: true, showOverlay: true };

    graineRepairHoldObserver.onBulkIngestStart(restore);
    await handleDistributionFrame(frame(await v2SeedFor('chan-1', 'sess-r', 0)));
    expect(repaired).toEqual([['chan-1']]);

    graineRepairHoldObserver.onBulkIngestStart(drain);
    await handleDistributionFrame(frame(await v2SeedFor('chan-2', 'sess-d', 0)));
    expect(repaired).toEqual([['chan-1']]);
    await graineRepairHoldObserver.onBulkIngestEnd(drain);
    expect(repaired).toEqual([['chan-1'], ['chan-2']]);
    await graineRepairHoldObserver.onBulkIngestEnd(restore);
    expect(repaired).toEqual([['chan-1'], ['chan-2']]);
    setGraineRepairListener(null);
  });

  // Graine v2 (channel-encryption section 21): a relayed seed is recorded under the minter its
  // endorsement NAMES, never under whoever relayed it - and it keeps every v2 field as sent.
  it('records a v2 seed under its MINTER, even when somebody else relayed it', async () => {
    const { storage, saved } = fakeStorage();
    wire(storage);

    await handleDistributionFrame(frame(V2_WIRE));

    expect(saved[0].senderId).toBe('carol');
    expect(saved[0].v2).toEqual({
      minterDeviceId: 'dev-c',
      signingPublicKeyB64: toBase64(V2_WIRE.signingPublicKey),
      endorsementB64: toBase64(V2_WIRE.endorsement),
    });
  });

  it('refuses a held v2 session re-sent WITHOUT its endorsement - a downgrade, not a copy', async () => {
    const { storage, saved } = fakeStorage();
    wire(storage);
    await handleDistributionFrame(frame(V2_WIRE));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await handleDistributionFrame(frame({ firstIndex: 0 }));
    await handleDistributionFrame(frame({ ...V2_WIRE, minterUserId: 'mallory' }));

    expect(saved).toHaveLength(1);
    expect(error).toHaveBeenCalledTimes(2);
    expect(String(error.mock.calls[0][0])).toContain('different endorsement');
    error.mockRestore();
  });

  // WP-G2-4: a NEW v2 session is stored only once its minter's device is shown to have endorsed
  // this key and this seed.
  describe('the endorsement of a new v2 seed', () => {
    it('refuses a seed whose endorsement another device signed, and stores nothing', async () => {
      const { storage, saved } = fakeStorage();
      wire(storage);
      tree.set('carol:dev-c', await ed25519PublicKeyOf(SESSION_SECRET));
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      await handleDistributionFrame(frame(V2_WIRE));

      expect(saved).toHaveLength(0);
      expect(String(error.mock.calls.at(-1)?.[0])).toContain('REFUSED v2 seed sess-1');
      error.mockRestore();
    });

    it('refuses a substituted seed, since the endorsement commits to the real one', async () => {
      const { storage, saved } = fakeStorage();
      wire(storage);
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      await handleDistributionFrame(frame({ ...V2_WIRE, seed: new Uint8Array(32).fill(8) }));

      expect(saved).toHaveLength(0);
      error.mockRestore();
    });

    it('refuses a v2 seed stripped of its endorsement fields rather than reading it as v1', async () => {
      const { storage, saved } = fakeStorage();
      wire(storage);
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      await handleDistributionFrame(frame({ ...V2_WIRE, endorsement: new Uint8Array(0) }));

      expect(saved).toHaveLength(0);
      expect(String(error.mock.calls.at(-1)?.[0])).toContain(
        'without its minter, key or endorsement'
      );
      error.mockRestore();
    });

    it('refuses a version-2 seed whose endorsement fields are ALL empty as v2, never as v1', async () => {
      const { storage, saved } = fakeStorage();
      wire(storage);
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // `seedFromWire` keeps `version = 2` a v2 seed with every field empty, so the refusal is the
      // endorsement's (ERROR), not the v1 one (WARN): a stripped v2 seed must not pass for an old one.
      await handleDistributionFrame(
        frame({
          version: 2,
          minterUserId: '',
          minterDeviceId: '',
          signingPublicKey: new Uint8Array(0),
          endorsement: new Uint8Array(0),
        })
      );

      expect(saved).toHaveLength(0);
      expect(String(error.mock.calls.at(-1)?.[0])).toContain('REFUSED v2 seed sess-1');
      expect(warn.mock.calls.some((c) => String(c[0]).includes('v1 seed'))).toBe(false);
      error.mockRestore();
      warn.mockRestore();
    });

    it('checks a minter who has LEFT the tree against the keys the server published', async () => {
      const { storage, saved } = fakeStorage();
      wire(storage);
      tree.clear();
      published = { kind: 'keys', keys: [new Uint8Array(32).fill(1), CAROL_DEVICE_PK] };

      await handleDistributionFrame(frame(V2_WIRE));

      expect(saved[0]?.senderId).toBe('carol');
    });

    it('stores nothing, and refuses nothing, when the server cannot be asked', async () => {
      const { storage, saved } = fakeStorage();
      wire(storage);
      tree.clear();
      published = { kind: 'unanswered', detail: 'HTTP 503' };
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      await handleDistributionFrame(frame(V2_WIRE));

      expect(saved).toHaveLength(0);
      expect(error).not.toHaveBeenCalled();
      expect(String(warn.mock.calls.at(-1)?.[0])).toContain('NOT stored yet');
      warn.mockRestore();
      error.mockRestore();
    });
  });

  it('declines a malformed seed and says so', async () => {
    const { storage, saved } = fakeStorage();
    wire(storage);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await handleDistributionFrame(frame({ seed: new Uint8Array() }));

    expect(saved).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('names a frame kind it does not answer rather than falling silent', async () => {
    const { storage, saved } = fakeStorage();
    wire(storage);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await handleDistributionFrame({
      scope: workspaceScope('ws-1'),
      workspaceId: 'ws-1',
      groupId: 'g-1',
      sender: 'bob',
      plaintext: encodeAppMessage(mkText('a body has no business on this group')),
    });

    // A peer speaking a protocol this bundle does not answer is a version skew worth naming; the
    // alternative reads exactly like nothing having arrived.
    expect(saved).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('a seed request arriving on the distribution group (WP-33)', () => {
  function requestFrame(request: Parameters<typeof mkGraineRequest>[0]) {
    return {
      scope: workspaceScope('ws-1'),
      workspaceId: 'ws-1',
      groupId: 'g-1',
      sender: 'bob',
      senderDeviceId: 'bob-phone',
      plaintext: encodeAppMessage(mkGraineRequest(request)),
    };
  }

  function heldSeed(sessionId: string, firstIndex = 7): StoredGraineSession {
    return {
      workspaceId: 'ws-1',
      channelId: 'chan-1',
      sessionId,
      senderId: 'alice',
      seedB64: toBase64(SEED),
      firstIndex,
      createdAt: 5,
      sentCount: 3,
      distributionEpoch: 2,
    };
  }

  function wireWithMls(storage: IStorage) {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    setGraineRuntime({
      storage,
      deviceKey: () => 'device-key',
      userId: 'alice',
      mlsService: graineMls({ sendMessage }),
    });
    return sendMessage;
  }

  beforeEach(() => {
    // These rows are about WHAT IS HELD, not about who may read the past, so the community shares
    // it. Left unregistered it would fail closed, and every one of them would measure the boundary
    // instead of the thing it is named after.
    registerCommunityHistoryVisibility('ws-1', 'shared');
    // A public salon, listed: its seeds ride the community's group (see 'the salon scope of an answer').
    registerChannelWorkspace('chan-1', 'ws-1', false);
    graineHistoryFloor.mockReset();
  });

  it('ignores a request addressed to somebody else', async () => {
    const { storage } = fakeStorage([heldSeed('sess-1')]);
    const sendMessage = wireWithMls(storage);

    await handleDistributionFrame(
      requestFrame({
        workspaceId: 'ws-1',
        kind: canari.GraineRequestKind.GRAINE_REQUEST_KIND_SESSIONS,
        sessionIds: ['sess-1'],
        answererUserId: 'carol',
        requestId: 'r-1',
      })
    );

    // Every member of the community receives the frame and every member but one must ignore it:
    // answering anyway is how a salon of three hundred pays three hundred bundles for one seed.
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('relays a v2 session with its endorsement untouched, and never its secret', async () => {
    const minted: StoredGraineSession = {
      ...heldSeed('sess-v2', 0),
      v2: {
        minterDeviceId: 'dev-a',
        signingPublicKeyB64: toBase64(V2_WIRE.signingPublicKey),
        endorsementB64: toBase64(V2_WIRE.endorsement),
        signingSecretKeyB64: toBase64(new Uint8Array(32).fill(9)),
      },
    };
    const { storage } = fakeStorage([minted]);
    const sendMessage = wireWithMls(storage);

    await handleDistributionFrame(
      requestFrame({
        workspaceId: 'ws-1',
        kind: canari.GraineRequestKind.GRAINE_REQUEST_KIND_SESSIONS,
        sessionIds: ['sess-v2'],
        answererUserId: 'Alice',
        requestId: 'r-v2',
      })
    );

    const seed = decodeAppMessage(sendMessage.mock.calls[0][1])?.graineBundle?.seeds?.[0];
    expect(Number(seed?.version)).toBe(2);
    expect(seed?.minterUserId).toBe('alice');
    expect(seed?.minterDeviceId).toBe('dev-a');
    expect(Uint8Array.from(seed?.signingPublicKey ?? [])).toEqual(V2_WIRE.signingPublicKey);
    expect(Uint8Array.from(seed?.endorsement ?? [])).toEqual(V2_WIRE.endorsement);
    expect(JSON.stringify(sendMessage.mock.calls[0][1])).not.toContain(
      toBase64(new Uint8Array(32).fill(9))
    );
  });

  it('answers with the seeds it holds, at the floor it holds them at', async () => {
    const { storage } = fakeStorage([heldSeed('sess-1', 12)]);
    const sendMessage = wireWithMls(storage);

    await handleDistributionFrame(
      requestFrame({
        workspaceId: 'ws-1',
        kind: canari.GraineRequestKind.GRAINE_REQUEST_KIND_SESSIONS,
        sessionIds: ['sess-1'],
        answererUserId: 'Alice',
        requestId: 'r-1',
      })
    );

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [groupId, payload] = sendMessage.mock.calls[0];
    expect(groupId).toBe('g-1');
    const answer = decodeAppMessage(payload);
    expect(answer?.graineBundle?.requestId).toBe('r-1');
    expect(answer?.graineBundle?.seeds).toHaveLength(1);
    // The floor travels as OURS: a member cannot hand over more history than they were given, and
    // this is what stops a repair from widening access.
    expect(Number(answer?.graineBundle?.seeds?.[0].firstIndex)).toBe(12);
    expect(answer?.graineBundle?.truncated).toBeFalsy();
  });

  it('sends an answer that CARRIES SEEDS as key material, so no presence read can drop it', async () => {
    // THE DEFECT THIS ROW EXISTS FOR, measured by COMM-18 on 2026-08-25. The answer went out as
    // `DELIVERY.transport`, which the server delivers only to recipients presence reports online -
    // and a device that cold-starts has authenticated HTTP long before it has a socket, so it asks
    // in a window where it is unreachable by that measure. The answer was dropped for good.
    const { storage } = fakeStorage([heldSeed('sess-1', 0)]);
    const sendMessage = wireWithMls(storage);

    await handleDistributionFrame(
      requestFrame({
        workspaceId: 'ws-1',
        kind: canari.GraineRequestKind.GRAINE_REQUEST_KIND_SESSIONS,
        sessionIds: ['sess-1'],
        answererUserId: 'alice',
        requestId: 'r-1',
      })
    );

    expect(sendMessage.mock.calls[0][3]).toEqual(addressedKeyMaterial('bob:bob-phone'));
  });

  it('sends an answer that carries only declines as KEY MATERIAL too, so a decline is never dropped for an offline requester', async () => {
    // THE STRANDING (user decision, 2026-10-10). A pure decline used to go out as `DELIVERY.transport`,
    // which the server delivers only to recipients presence reports online and never appends to the
    // log. A requester that asked from a cold start has no socket yet, so the decline was dropped
    // for good - and a decline is the one fact that sends the requester to the NEXT member, so
    // nothing re-asked and the session stayed unreadable. An answer is ONE message whatever it
    // carries: same delivery, same retry, same heal.
    const { storage } = fakeStorage();
    const sendMessage = wireWithMls(storage);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await handleDistributionFrame(
      requestFrame({
        workspaceId: 'ws-1',
        kind: canari.GraineRequestKind.GRAINE_REQUEST_KIND_SESSIONS,
        sessionIds: ['sess-9'],
        answererUserId: 'alice',
        requestId: 'r-1',
      })
    );

    expect(sendMessage.mock.calls[0][3]).toEqual(addressedKeyMaterial('bob:bob-phone'));
    expect(sendMessage.mock.calls[0][3].durable).toBe(true);
    warn.mockRestore();
  });

  describe('answers from the named devices, to one device (section 23)', () => {
    const sessionsRequest = (extra: Partial<Parameters<typeof mkGraineRequest>[0]> = {}) =>
      requestFrame({
        workspaceId: 'ws-1',
        kind: canari.GraineRequestKind.GRAINE_REQUEST_KIND_SESSIONS,
        sessionIds: ['sess-1'],
        answererUserId: 'alice',
        requestId: 'r-1',
        ...extra,
      });

    it('addresses the answer to the device that asked, and to nobody else in the key group', async () => {
      // On production 2026-10-12 an answer was queued for every seat of a 112-seat key group: ~42
      // rows per seed bundle, 70 % of that group's queued bytes, for seeds nobody else had asked for.
      const { storage } = fakeStorage([heldSeed('sess-1', 0)]);
      const sendMessage = wireWithMls(storage);

      await handleDistributionFrame(sessionsRequest());

      expect(sendMessage.mock.calls[0][3].recipients).toEqual(['bob:bob-phone']);
    });

    it('stays silent, and says so at debug, when the request names only OTHER devices of this user', async () => {
      // Every device of the elected user used to answer - one bundle per device online (finding G).
      const { storage } = fakeStorage([heldSeed('sess-1', 0)]);
      const sendMessage = wireWithMls(storage);

      const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);

      await handleDistributionFrame(
        sessionsRequest({ answererDeviceIds: ['alice-phone', 'alice-tablet'] })
      );

      expect(sendMessage).not.toHaveBeenCalled();
      expect(debug.mock.calls.flat().join(' ')).toContain(
        'names alice-phone,alice-tablet, not this device'
      );
      debug.mockRestore();
    });

    it('answers when THIS device is among those named', async () => {
      const { storage } = fakeStorage([heldSeed('sess-1', 0)]);
      const sendMessage = wireWithMls(storage);

      await handleDistributionFrame(
        sessionsRequest({ answererDeviceIds: ['alice-phone', 'alice-laptop'] })
      );

      expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    it('answers when the request names no device, as every requester before 1.2.5 sends it', async () => {
      const { storage } = fakeStorage([heldSeed('sess-1', 0)]);
      const sendMessage = wireWithMls(storage);

      await handleDistributionFrame(sessionsRequest());

      expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    it('refuses out loud, rather than answering the whole group, when the envelope named no device', async () => {
      const { storage } = fakeStorage([heldSeed('sess-1', 0)]);
      const sendMessage = wireWithMls(storage);
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await handleDistributionFrame({ ...sessionsRequest(), senderDeviceId: undefined });

      expect(sendMessage).not.toHaveBeenCalled();
      expect(String(error.mock.calls[0]?.[0])).toContain('named no device');
      error.mockRestore();
    });
  });

  it('hands the request id of an inbound decline to the repair walk', async () => {
    const { storage } = fakeStorage();
    wireWithMls(storage);
    noteSeedUnavailableSpy.mockClear();

    await handleDistributionFrame({
      scope: workspaceScope('ws-1'),
      workspaceId: 'ws-1',
      groupId: 'g-1',
      sender: 'bob',
      senderDeviceId: 'bob-phone',
      plaintext: encodeAppMessage(
        mkGraineBundle({
          workspaceId: 'ws-1',
          requestId: 'r-7',
          seeds: [],
          missingSessionIds: ['sess-9'],
          truncated: false,
        })
      ),
    });

    // Dropping or emptying the id here would make every decline a no-op in the walk, and the device
    // is what the walk counts a named device's "no" by (section 23).
    expect(noteSeedUnavailableSpy).toHaveBeenCalledWith('sess-9', 'bob', 'r-7', 'bob-phone');
  });

  it('says which sessions it does not hold, rather than answering an empty hand with silence', async () => {
    const { storage } = fakeStorage();
    const sendMessage = wireWithMls(storage);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await handleDistributionFrame(
      requestFrame({
        workspaceId: 'ws-1',
        kind: canari.GraineRequestKind.GRAINE_REQUEST_KIND_SESSIONS,
        sessionIds: ['sess-9'],
        answererUserId: 'alice',
        requestId: 'r-1',
      })
    );

    // Chosen as the holder and not being one is either a roster that moved under the requester or a
    // seed lost on this side - both worth naming locally.
    expect(warn.mock.calls.flat().join(' ')).toContain('sess-9');

    // AND WORTH A BUNDLE. The answerer is elected deterministically, so every device would elect
    // this same one again: answering with silence is what once left the session unreadable for the
    // whole app session. An empty hand is a fact, and it is the fact that sends the requester on.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const answer = decodeAppMessage(sendMessage.mock.calls[0][1]);
    expect(answer?.graineBundle?.seeds ?? []).toHaveLength(0);
    expect(answer?.graineBundle?.missingSessionIds).toEqual(['sess-9']);
    warn.mockRestore();
  });

  it('hands a spanning session over from the index the asker arrived at (WP-34)', async () => {
    // THE DEFECT THIS ROW EXISTS FOR, AND THE SHAPE THE FIRST FIX GOT WRONG. `joined` refused the
    // join-time bundle and nothing refused this, so a newcomer read the past one session id at a
    // time. Withholding the session whole was not the answer either: rotation is decided by the
    // SENDER when it notices the epoch moved, and a join is an external commit it learns of late,
    // so one session carries messages from both sides of the arrival. Only a floor separates them.
    registerCommunityHistoryVisibility('ws-1', 'joined');
    graineHistoryFloor.mockResolvedValue({ spanning: 4 });
    const { storage } = fakeStorage([heldSeed('spanning', 0), heldSeed('entirely-before', 0)]);
    const sendMessage = wireWithMls(storage);

    await handleDistributionFrame(
      requestFrame({
        workspaceId: 'ws-1',
        kind: canari.GraineRequestKind.GRAINE_REQUEST_KIND_SESSIONS,
        sessionIds: ['spanning', 'entirely-before'],
        answererUserId: 'alice',
        requestId: 'r-1',
      })
    );

    expect(graineHistoryFloor).toHaveBeenCalledWith('chan-1', 'bob', [
      'spanning',
      'entirely-before',
    ]);
    const answer = decodeAppMessage(sendMessage.mock.calls[0][1]);
    expect(answer?.graineBundle?.seeds?.map((x) => x.sessionId)).toEqual(['spanning']);
    expect(Number(answer?.graineBundle?.seeds?.[0].firstIndex)).toBe(4);
    // ABSENT FROM BOTH LISTS. Reported as missing it would mean "elect somebody else", and every
    // other member applies the same rule - so the requester would walk the whole roster to reach
    // the answer it was handed first.
    expect(answer?.graineBundle?.missingSessionIds ?? []).toEqual([]);
  });

  it('never lowers a floor it was given itself', async () => {
    // A member cannot hand over more than they were given. A server floor BELOW ours would widen
    // access on every hop, which is the leak this path exists to close.
    registerCommunityHistoryVisibility('ws-1', 'joined');
    graineHistoryFloor.mockResolvedValue({ 'sess-1': 2 });
    const { storage } = fakeStorage([heldSeed('sess-1', 12)]);
    const sendMessage = wireWithMls(storage);

    await handleDistributionFrame(
      requestFrame({
        workspaceId: 'ws-1',
        kind: canari.GraineRequestKind.GRAINE_REQUEST_KIND_SESSIONS,
        sessionIds: ['sess-1'],
        answererUserId: 'alice',
        requestId: 'r-1',
      })
    );

    const answer = decodeAppMessage(sendMessage.mock.calls[0][1]);
    expect(Number(answer?.graineBundle?.seeds?.[0].firstIndex)).toBe(12);
  });

  it('hands the same seeds over untouched when the community shares its past', async () => {
    // The positive control the rows above need: without it, a refusal cannot be told apart from a
    // repair path that answers nothing at all. And it must not ask the server anything - a
    // community that shares its past has no boundary to place.
    registerCommunityHistoryVisibility('ws-1', 'shared');
    const { storage } = fakeStorage([heldSeed('sess-old', 3)]);
    const sendMessage = wireWithMls(storage);

    await handleDistributionFrame(
      requestFrame({
        workspaceId: 'ws-1',
        kind: canari.GraineRequestKind.GRAINE_REQUEST_KIND_SESSIONS,
        sessionIds: ['sess-old'],
        answererUserId: 'alice',
        requestId: 'r-1',
      })
    );

    const answer = decodeAppMessage(sendMessage.mock.calls[0][1]);
    expect(answer?.graineBundle?.seeds?.map((x) => x.sessionId)).toEqual(['sess-old']);
    expect(Number(answer?.graineBundle?.seeds?.[0].firstIndex)).toBe(3);
    expect(graineHistoryFloor).not.toHaveBeenCalled();
  });

  it('hands over nothing when the floors cannot be established', async () => {
    // Fail-closed, like every other reading of this rule: a boundary nobody can place is not a
    // boundary, and guessing it wide is the expensive half of the asymmetry.
    registerCommunityHistoryVisibility('ws-1', 'joined');
    graineHistoryFloor.mockRejectedValue(new Error('offline'));
    const { storage } = fakeStorage([heldSeed('sess-1')]);
    const sendMessage = wireWithMls(storage);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await handleDistributionFrame(
      requestFrame({
        workspaceId: 'ws-1',
        kind: canari.GraineRequestKind.GRAINE_REQUEST_KIND_SESSIONS,
        sessionIds: ['sess-1'],
        answererUserId: 'alice',
        requestId: 'r-1',
      })
    );

    expect(sendMessage).not.toHaveBeenCalled();
    // A member whose repairs silently stop working has no other symptom.
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('declines a request whose kind is not SESSIONS rather than guessing at it', async () => {
    const { storage } = fakeStorage([heldSeed('sess-1')]);
    const sendMessage = wireWithMls(storage);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await handleDistributionFrame(
      requestFrame({
        workspaceId: 'ws-1',
        sessionIds: ['sess-1'],
        answererUserId: 'alice',
        requestId: 'r-1',
      })
    );

    // "repair these" and "send me everything" would otherwise be one message with an empty field.
    expect(sendMessage).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('a history request from a joiner (WP-34)', () => {
  beforeEach(() => {
    // Two public salons, listed: their seeds ride the community's group.
    registerChannelWorkspace('chan-1', 'ws-1', false);
    registerChannelWorkspace('chan-2', 'ws-1', false);
  });

  function historyFrame() {
    return {
      scope: workspaceScope('ws-1'),
      workspaceId: 'ws-1',
      groupId: 'g-1',
      sender: 'newcomer',
      senderDeviceId: 'newcomer-web',
      plaintext: encodeAppMessage(
        mkGraineRequest({
          workspaceId: 'ws-1',
          kind: canari.GraineRequestKind.GRAINE_REQUEST_KIND_HISTORY,
          answererUserId: 'alice',
          requestId: 'r-h',
        })
      ),
    };
  }

  /**
   * @param rows The community's ROWS in the store, decryptable or not - `sessions` is what the
   *   device key opens of them, so a larger count is rows sealed under another key.
   */
  function wireWithSessions(sessions: StoredGraineSession[], rows = sessions.length) {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    setGraineRuntime({
      storage: {
        getGraineSession: async () => null,
        saveGraineSession: async () => undefined,
        getGraineSessionsForWorkspace: async () => sessions,
        countGraineSessionsForWorkspace: async () => rows,
      } as unknown as IStorage,
      deviceKey: () => 'device-key',
      userId: 'alice',
      mlsService: graineMls({ sendMessage }),
    });
    return sendMessage;
  }

  const community: StoredGraineSession[] = [
    {
      workspaceId: 'ws-1',
      channelId: 'chan-1',
      sessionId: 's-1',
      senderId: 'alice',
      seedB64: toBase64(SEED),
      firstIndex: 0,
      createdAt: 1,
    },
    {
      workspaceId: 'ws-1',
      channelId: 'chan-2',
      sessionId: 's-2',
      senderId: 'bob',
      seedB64: toBase64(SEED),
      firstIndex: 5,
      createdAt: 2,
    },
  ];

  it('sends every seed of the community in ONE bundle when the rule is shared', async () => {
    const sendMessage = wireWithSessions(community);
    registerCommunityHistoryVisibility('ws-1', 'shared');

    await handleDistributionFrame(historyFrame());

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const bundle = decodeAppMessage(sendMessage.mock.calls[0][1])?.graineBundle;
    expect(bundle?.requestId).toBe('r-h');
    expect(bundle?.seeds?.map((s) => s.sessionId)).toEqual(['s-1', 's-2']);
    expect(bundle?.truncated).toBeFalsy();
    expect(bundle?.holdsNothing).toBeFalsy();
  });

  it('pages a history larger than the byte bound, every page to the device that asked', async () => {
    // A v2 seed is ~330 bytes, so the 8 000-seed cap was ~2.6 MB in ONE message - over the pending
    // page an offline device catches up in (dm-vs-community-encryption, "the history bundle").
    const many: StoredGraineSession[] = Array.from({ length: 3000 }, (_, i) => ({
      workspaceId: 'ws-1',
      channelId: `chan-${i % 7}`,
      sessionId: `s-${String(i).padStart(24, '0')}`,
      senderId: 'carol'.repeat(12),
      seedB64: toBase64(SEED),
      firstIndex: 0,
      createdAt: i + 1,
      v2: {
        minterDeviceId: 'd'.repeat(83),
        signingPublicKeyB64: toBase64(V2_WIRE.signingPublicKey),
        endorsementB64: toBase64(V2_WIRE.endorsement),
      },
    }));
    const sendMessage = wireWithSessions(many);
    registerCommunityHistoryVisibility('ws-1', 'shared');
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await handleDistributionFrame(historyFrame());

    expect(sendMessage.mock.calls.length).toBeGreaterThan(1);
    const pages = sendMessage.mock.calls.map(([, payload]) => {
      expect((payload as Uint8Array).length).toBeLessThanOrEqual(GRAINE_BUNDLE_PAGE_MAX_BYTES);
      return decodeAppMessage(payload)?.graineBundle;
    });
    for (const [, , , delivery] of sendMessage.mock.calls) {
      expect(delivery).toEqual(addressedKeyMaterial('newcomer:newcomer-web'));
    }
    expect(new Set(pages.map((p) => p?.requestId))).toEqual(new Set(['r-h']));
    expect(pages.map((p) => p?.pageIndex)).toEqual(pages.map((_, i) => i));
    expect(new Set(pages.flatMap((p) => (p?.seeds ?? []).map((s) => s.sessionId))).size).toBe(3000);
    expect(info.mock.calls.flat().join(' ')).toContain(`in ${pages.length} page(s)`);
    info.mockRestore();
  });

  it('SAYS it holds nothing rather than falling silent, addressed to the device that asked (section 24)', async () => {
    const sendMessage = wireWithSessions([]);
    registerCommunityHistoryVisibility('ws-1', 'shared');
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await handleDistributionFrame(historyFrame());

    // A silence here was the one answer the requester could not record: it asked at every launch.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [, payload, , delivery] = sendMessage.mock.calls[0];
    const bundle = decodeAppMessage(payload)?.graineBundle;
    expect(bundle?.requestId).toBe('r-h');
    expect(bundle?.holdsNothing).toBe(true);
    expect(bundle?.seeds ?? []).toHaveLength(0);
    expect(delivery).toEqual(addressedKeyMaterial('newcomer:newcomer-web'));
    expect(delivery.recipients).toEqual(['newcomer:newcomer-web']);
    info.mockRestore();
  });

  it('does NOT say it holds nothing when it holds rows its key cannot open - it stays silent, as before', async () => {
    // A PIN change re-sealing the store, or backup rows sealed under another key: the read skips
    // every row, and "nothing opened" is not "nothing held". A durable "nothing" at the requester
    // here would end its walk while the past sits on this device.
    const sendMessage = wireWithSessions([], 3);
    registerCommunityHistoryVisibility('ws-1', 'shared');
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await handleDistributionFrame(historyFrame());

    expect(sendMessage).not.toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(' ')).toContain('none opens with this device');
    info.mockRestore();
    warn.mockRestore();
  });

  it('sends nothing when the community is set to joined, and says why - an empty hand included', async () => {
    for (const held of [community, []]) {
      const sendMessage = wireWithSessions(held);
      registerCommunityHistoryVisibility('ws-1', 'joined');
      const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

      await handleDistributionFrame(historyFrame());

      // The rule is enforced HERE because here is the only place a seed leaves a device - the server
      // holds no key and could not enforce it. An empty hand does not say "I hold nothing" either:
      // the requester knows the rule (section 24).
      expect(sendMessage).not.toHaveBeenCalled();
      expect(info).toHaveBeenCalled();
      info.mockRestore();
    }
  });

  it('refuses to hand the past over when this session never learned the rule', async () => {
    const sendMessage = wireWithSessions(community);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await handleDistributionFrame(historyFrame());

    // Fail-closed and loudly: refusing costs a newcomer some history, guessing 'shared' costs a
    // community the privacy it asked for. Those are not symmetrical.
    expect(sendMessage).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('a bundle saying "I hold nothing" (section 24)', () => {
  beforeEach(() => {
    noteHistoryHeldNothingSpy.mockClear();
    noteSeedUnavailableSpy.mockClear();
  });

  function holdsNothingFrame(seeds: canari.GraineMsg.$Properties[] = []) {
    return {
      scope: workspaceScope('ws-1'),
      workspaceId: 'ws-1',
      groupId: 'g-1',
      sender: 'Bob',
      senderDeviceId: 'web-bob',
      plaintext: encodeAppMessage(
        mkGraineBundle({ workspaceId: 'ws-1', requestId: 'r-h', seeds, holdsNothing: true })
      ),
    };
  }

  it('hands the answer, its request id and its device to the history ask', async () => {
    const { storage } = fakeStorage();
    wire(storage);

    await handleDistributionFrame(holdsNothingFrame());

    expect(noteHistoryHeldNothingSpy).toHaveBeenCalledWith('ws-1', 'Bob', 'r-h', 'web-bob');
  });

  it('ignores the claim, out loud, when the same bundle carries seeds', async () => {
    const { storage, saved } = fakeStorage();
    wire(storage);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await handleDistributionFrame(holdsNothingFrame([await v2SeedFor('chan-1', 's-a', 0)]));

    expect(saved.map((s) => s.sessionId)).toEqual(['s-a']);
    expect(noteHistoryHeldNothingSpy).not.toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(' ')).toContain('the claim is ignored');
    warn.mockRestore();
  });

  /**
   * THE CONDITION THE USER SET ON THIS FIELD (2026-10-18): a reader that predates it must ignore it
   * without an error. Such a reader decodes with a schema that has no field 6, so it sees an empty
   * bundle - which is what this decodes the new bytes with, then hands to the handler exactly as
   * every reader since 1.0.3 handles it (`absorbSeedBundle`, unchanged on this branch): no seed
   * stored, no decline walked, no salon re-read, nothing above debug.
   *
   * WHAT THIS PROVES, AND WHAT IT DOES NOT: it runs no old code. It proves (1) that the NEW bytes,
   * decoded by a hand-written schema without field 6, come out as an empty bundle with the request
   * id intact and no trace of the field; and (2) that THIS branch's handler, given a bundle without
   * the field, does nothing and logs nothing above debug. That (2) stands for the old reader rests on
   * `absorbSeedBundle`'s empty-bundle path being the same since 1.0.3 - read from the history, not
   * executed here.
   */
  it('reads, to a schema without the field, as an empty bundle that changes nothing and says nothing above debug', async () => {
    const oldSchema = protobuf.Root.fromJSON({
      nested: {
        GraineBundleMsg: {
          fields: {
            workspaceId: { type: 'string', id: 1 },
            requestId: { type: 'string', id: 2 },
            seeds: { rule: 'repeated', type: 'bytes', id: 3 },
            truncated: { type: 'bool', id: 4 },
            missingSessionIds: { rule: 'repeated', type: 'string', id: 5 },
          },
        },
        AppMessage: {
          oneofs: { kind: { oneof: ['graineBundle'] } },
          fields: { graineBundle: { type: 'GraineBundleMsg', id: 12 } },
        },
      },
    });
    const AppMessageV0 = oldSchema.lookupType('AppMessage');
    const newBytes = holdsNothingFrame().plaintext;
    const old = AppMessageV0.toObject(AppMessageV0.decode(newBytes), { defaults: true }) as {
      graineBundle: { requestId: string; seeds: unknown[]; missingSessionIds: unknown[] };
    };
    expect(old.graineBundle.requestId).toBe('r-h');
    expect(old.graineBundle.seeds).toHaveLength(0);
    expect(old.graineBundle.missingSessionIds).toHaveLength(0);
    expect('holdsNothing' in old.graineBundle).toBe(false);

    // What that reader then does with it: the same bundle with the field absent.
    const { storage, saved } = fakeStorage();
    wire(storage);
    const repaired: string[][] = [];
    setGraineRepairListener((ids) => repaired.push(ids));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await handleDistributionFrame({
      ...holdsNothingFrame(),
      plaintext: encodeAppMessage(mkGraineBundle({ workspaceId: 'ws-1', requestId: 'r-h' })),
    });

    expect(saved).toHaveLength(0);
    expect(repaired).toHaveLength(0);
    expect(noteSeedUnavailableSpy).not.toHaveBeenCalled();
    expect(noteHistoryHeldNothingSpy).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
    info.mockRestore();
  });
});

describe('a bundle answering our own request (WP-33)', () => {
  it('stores every seed and tells the UI which salons became readable', async () => {
    const { storage, saved } = fakeStorage();
    wire(storage);
    const repaired: string[][] = [];
    setGraineRepairListener((ids) => repaired.push(ids));

    await handleDistributionFrame({
      scope: workspaceScope('ws-1'),
      workspaceId: 'ws-1',
      groupId: 'g-1',
      sender: 'Bob',
      plaintext: encodeAppMessage(
        mkGraineBundle({
          workspaceId: 'ws-1',
          requestId: 'r-1',
          seeds: [await v2SeedFor('chan-1', 's-a', 0), await v2SeedFor('chan-2', 's-b', 3)],
        })
      ),
    });

    expect(saved.map((s) => s.sessionId)).toEqual(['s-a', 's-b']);
    // Without this the rows stay dropped until the user happens to leave and re-enter the salon.
    expect(repaired).toEqual([['chan-1', 'chan-2']]);
  });

  describe('a paged answer (one request, several bundles)', () => {
    function pageFrame(
      seeds: canari.GraineMsg.$Properties[],
      pageIndex: number,
      pageCount: number,
      extra: Partial<canari.GraineBundleMsg.$Properties> = {}
    ) {
      return {
        scope: workspaceScope('ws-1'),
        workspaceId: 'ws-1',
        groupId: 'g-1',
        sender: 'bob',
        senderDeviceId: 'bob-phone',
        plaintext: encodeAppMessage(
          mkGraineBundle({
            workspaceId: 'ws-1',
            requestId: 'r-p',
            seeds,
            pageIndex,
            pageCount,
            ...extra,
          })
        ),
      };
    }

    it('stores every seed whatever order the pages arrive in, and names each page in its line', async () => {
      const { storage, saved } = fakeStorage();
      wire(storage);
      const repaired: string[][] = [];
      setGraineRepairListener((ids) => repaired.push(ids));
      const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
      const pages = [
        [await v2SeedFor('chan-1', 's-a', 0), await v2SeedFor('chan-1', 's-b', 0)],
        [await v2SeedFor('chan-2', 's-c', 0)],
        [await v2SeedFor('chan-3', 's-d', 0)],
      ];

      for (const index of [2, 0, 1])
        await handleDistributionFrame(pageFrame(pages[index], index, 3));

      expect(saved.map((s) => s.sessionId).sort()).toEqual(['s-a', 's-b', 's-c', 's-d']);
      expect(repaired).toEqual([['chan-3'], ['chan-1'], ['chan-2']]);
      const said = debug.mock.calls.flat().join(' ');
      // A gap in this sequence is a lost page, visible in the log; the rows it carried ask again
      // one session at a time, which is what makes losing one harmless.
      for (const n of [1, 2, 3]) expect(said).toContain(`page ${n}/3 of request r-p`);
      debug.mockRestore();
    });

    it('treats a duplicated page as what it is - nothing new stored, no salon re-read', async () => {
      const { storage, saved } = fakeStorage();
      wire(storage);
      const repaired: string[][] = [];
      setGraineRepairListener((ids) => repaired.push(ids));
      const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
      const page = pageFrame([await v2SeedFor('chan-1', 's-a', 0)], 0, 2);

      await handleDistributionFrame(page);
      await handleDistributionFrame(page);

      expect(saved.map((s) => s.sessionId)).toEqual(['s-a']);
      expect(repaired).toEqual([['chan-1']]);
      expect(debug.mock.calls.flat().join(' ')).toContain('absorbed 0/1 seed(s) (1 already held');
      debug.mockRestore();
    });

    /**
     * WHAT A READER BEFORE PAGES DOES WITH ONE. It decodes with a schema that has no field 7 or 8,
     * so a page reads as an ordinary bundle carrying its own seeds - the shape every reader since
     * 1.0.3 absorbs seed by seed (`absorbSeedBundle`). As in the section 24 row below, this runs no
     * old code: it proves the new bytes decode to that bundle, seeds and request id intact.
     */
    it('reads, to a schema without page numbers, as an ordinary bundle with its seeds', async () => {
      const oldSchema = protobuf.Root.fromJSON({
        nested: {
          GraineMsg: { fields: { sessionId: { type: 'string', id: 2 } } },
          GraineBundleMsg: {
            fields: {
              workspaceId: { type: 'string', id: 1 },
              requestId: { type: 'string', id: 2 },
              seeds: { rule: 'repeated', type: 'GraineMsg', id: 3 },
              truncated: { type: 'bool', id: 4 },
              missingSessionIds: { rule: 'repeated', type: 'string', id: 5 },
              holdsNothing: { type: 'bool', id: 6 },
            },
          },
          AppMessage: {
            oneofs: { kind: { oneof: ['graineBundle'] } },
            fields: { graineBundle: { type: 'GraineBundleMsg', id: 12 } },
          },
        },
      });
      const AppMessageV0 = oldSchema.lookupType('AppMessage');
      const page = pageFrame(
        [await v2SeedFor('chan-1', 's-a', 0), await v2SeedFor('chan-1', 's-b', 0)],
        1,
        3,
        { truncated: true }
      );
      const old = AppMessageV0.toObject(AppMessageV0.decode(page.plaintext), {
        defaults: true,
      }) as {
        graineBundle: { requestId: string; truncated: boolean; seeds: { sessionId: string }[] };
      };

      expect(old.graineBundle.requestId).toBe('r-p');
      expect(old.graineBundle.seeds.map((s) => s.sessionId)).toEqual(['s-a', 's-b']);
      expect(old.graineBundle.truncated).toBe(true);
      expect('pageIndex' in old.graineBundle).toBe(false);
      expect('pageCount' in old.graineBundle).toBe(false);
    });

    it('absorbs a page whose numbering is impossible, and says so - the numbers decide nothing', async () => {
      const { storage, saved } = fakeStorage();
      wire(storage);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await handleDistributionFrame(pageFrame([await v2SeedFor('chan-1', 's-a', 0)], 4, 2));

      expect(saved.map((s) => s.sessionId)).toEqual(['s-a']);
      expect(warn.mock.calls.flat().join(' ')).toContain('page 5 of 2');
      warn.mockRestore();
    });
  });

  it('says out loud what it absorbed, because a repair that worked left no trace at all', async () => {
    const { storage } = fakeStorage();
    wire(storage);
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);

    await handleDistributionFrame({
      scope: workspaceScope('ws-1'),
      workspaceId: 'ws-1',
      groupId: 'g-1',
      sender: 'bob',
      plaintext: encodeAppMessage(
        mkGraineBundle({
          workspaceId: 'ws-1',
          requestId: 'r-1',
          seeds: [await v2SeedFor('chan-1', 's-a', 0), await v2SeedFor('chan-2', 's-b', 3)],
        })
      ),
    });

    // The ask and the answer were both audible and this was not, so a member who was granted access
    // to a salon started reading it with nothing anywhere saying the seed had landed - and a bundle
    // whose seeds were ALL refused looked exactly the same. The counts are what separate them.
    const said = debug.mock.calls.flat().join(' ');
    expect(said).toContain('absorbed 2/2 seed(s)');
    expect(said).toContain('chan-1');
    expect(said).toContain('chan-2');
    debug.mockRestore();
  });

  // Mi 9T, 2026-10-13: a sign-in printed 496 `[GRAINE] v2 endorsement ... verified` lines, one per
  // seed admitted, beside the line that already said each seed was stored. The verification is
  // said ONCE, in the line that reports what it stored, with which key proved it.
  it('says the endorsements it verified in its ONE line, never one line per seed', async () => {
    const { storage } = fakeStorage();
    wire(storage);
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const seeds = [];
    for (let i = 0; i < 20; i++) seeds.push(await v2SeedFor(`chan-${i}`, `s-${i}`, 0));

    await handleDistributionFrame({
      scope: workspaceScope('ws-1'),
      workspaceId: 'ws-1',
      groupId: 'g-1',
      sender: 'bob',
      plaintext: encodeAppMessage(mkGraineBundle({ workspaceId: 'ws-1', requestId: 'r-1', seeds })),
    });

    const graineLines = debug.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('[GRAINE]'));
    expect(graineLines).toHaveLength(1);
    expect(graineLines[0]).toContain('absorbed 20/20 seed(s)');
    expect(graineLines[0]).toContain('20 from the tree, 0 from the server');
    debug.mockRestore();
  });

  it("names a seed checked against the server's published keys, in the stored-seed line", async () => {
    const { storage, saved } = fakeStorage();
    wire(storage);
    tree.clear();
    published = { kind: 'keys', keys: [CAROL_DEVICE_PK] };
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);

    await handleDistributionFrame(frame(V2_WIRE));

    expect(saved).toHaveLength(1);
    const graineLines = debug.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('[GRAINE]'));
    expect(graineLines).toHaveLength(1);
    expect(graineLines[0]).toContain("from the server's published keys");
    debug.mockRestore();
  });

  it('says out loud that a bundle was truncated, because a short list means nothing on its own', async () => {
    const { storage } = fakeStorage();
    wire(storage);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await handleDistributionFrame({
      scope: workspaceScope('ws-1'),
      workspaceId: 'ws-1',
      groupId: 'g-1',
      sender: 'bob',
      plaintext: encodeAppMessage(
        mkGraineBundle({
          workspaceId: 'ws-1',
          requestId: 'r-1',
          seeds: [
            { channelId: 'chan-1', sessionId: 's-a', seed: SEED, firstIndex: 0, createdAt: 1 },
          ],
          truncated: true,
        })
      ),
    });

    // "this is all there is" and "this is all I could send" are different facts, and only one of
    // them means ask again.
    expect(warn.mock.calls.flat().join(' ')).toContain('TRUNCATED');
    warn.mockRestore();
  });

  it('stores the v2 seeds of a bundle and refuses its v1 seeds in ONE line (section 21.7)', async () => {
    const { storage, saved } = fakeStorage();
    wire(storage);
    const repaired: string[][] = [];
    setGraineRepairListener((ids) => repaired.push(ids));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    // An honest answerer relays every session it holds, v1 ones included: a joiner's history
    // bundle is where most v1 seeds arrive now, and per-seed lines would be one per session.
    await handleDistributionFrame({
      scope: workspaceScope('ws-1'),
      workspaceId: 'ws-1',
      groupId: 'g-1',
      sender: 'bob',
      plaintext: encodeAppMessage(
        mkGraineBundle({
          workspaceId: 'ws-1',
          requestId: 'r-1',
          seeds: [
            await v2SeedFor('chan-1', 's-a', 0),
            { channelId: 'chan-2', sessionId: 'v1-a', seed: SEED, firstIndex: 0, createdAt: 1 },
            { channelId: 'chan-2', sessionId: 'v1-b', seed: SEED, firstIndex: 0, createdAt: 1 },
          ],
        })
      ),
    });

    expect(saved.map((x) => x.sessionId)).toEqual(['s-a']);
    expect(repaired).toEqual([['chan-1']]);
    const refusals = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('v1 seed'));
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain('REFUSED 2 v1 seed(s) relayed by bob');
    expect(refusals[0]).toContain('v1-a, v1-b');
    setGraineRepairListener(null);
    warn.mockRestore();
  });

  it('keeps its OWN held v1 session when a bundle relays it back: held, untouched, not refused', async () => {
    const mine: StoredGraineSession = {
      workspaceId: 'ws-1',
      channelId: 'chan-2',
      sessionId: 'v1-mine',
      senderId: 'alice',
      seedB64: toBase64(SEED),
      firstIndex: 4,
      createdAt: 1,
      sentCount: 12,
      distributionEpoch: 3,
    };
    const { storage, saved, rows } = fakeStorage([mine]);
    wire(storage);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);

    await handleDistributionFrame({
      scope: workspaceScope('ws-1'),
      workspaceId: 'ws-1',
      groupId: 'g-1',
      sender: 'bob',
      plaintext: encodeAppMessage(
        mkGraineBundle({
          workspaceId: 'ws-1',
          requestId: 'r-1',
          seeds: [
            { channelId: 'chan-2', sessionId: 'v1-mine', seed: SEED, firstIndex: 0, createdAt: 1 },
          ],
        })
      ),
    });

    // Held is not arriving: no refusal line, counted as ALREADY HELD (not absorbed - it repairs
    // nothing), and NOT rewritten - a write would
    // drop `sentCount` and re-use message keys.
    expect(saved).toHaveLength(0);
    expect(rows.get('v1-mine')).toEqual(mine);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('v1 seed'))).toBe(false);
    expect(debug.mock.calls.flat().join(' ')).toContain('absorbed 0/1 seed(s) (1 already held)');
    warn.mockRestore();
    debug.mockRestore();
  });

  it('still lowers the floor of a v1 session it ALREADY holds - held is not arriving', async () => {
    const { storage, saved } = fakeStorage([
      {
        workspaceId: 'ws-1',
        channelId: 'chan-2',
        sessionId: 'v1-held',
        senderId: 'bob',
        seedB64: toBase64(SEED),
        firstIndex: 9,
        createdAt: 1,
      },
    ]);
    wire(storage);

    await handleDistributionFrame({
      scope: workspaceScope('ws-1'),
      workspaceId: 'ws-1',
      groupId: 'g-1',
      sender: 'carol',
      plaintext: encodeAppMessage(
        mkGraineBundle({
          workspaceId: 'ws-1',
          requestId: 'r-1',
          seeds: [
            { channelId: 'chan-2', sessionId: 'v1-held', seed: SEED, firstIndex: 2, createdAt: 1 },
          ],
        })
      ),
    });

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ sessionId: 'v1-held', senderId: 'bob', firstIndex: 2 });
  });
});

/**
 * WHAT AN UNDECODABLE FRAME DOES, AND THE ANSWER IS CARRIED BY RETURNING RATHER THAN BY A VALUE.
 *
 * This handler answers `void`, so the ACK is decided one layer up: {@link BaseMlsService} treats a
 * normal return as acknowledged and a THROW as "not acknowledged, redeliver" - deliberately, because
 * a throw means the seed did not land and key material nobody can ask for again must not be dropped.
 *
 * The consequence is that the two outcomes are one `throw` apart, and nothing here said which one an
 * undecodable frame took. A frame that is not acknowledged is re-fetched on every reconnect for the
 * ninety days of the retention window - and bytes that would not decode once will not decode on the
 * hundredth delivery either, so that loop has no exit but the retention sweep.
 *
 * It acknowledges today. These tests are what keep it that way: the failure they catch is a future
 * `throw` added to this path, which would turn one bad frame into a permanent redelivery loop with
 * no symptom beyond a backlog that never shrinks.
 */
describe('a frame whose payload will not decode', () => {
  it('is acknowledged - it returns rather than throwing, which is how the ACK is expressed', async () => {
    const { storage, saved } = fakeStorage();
    wire(storage);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    // Not a truncated AppMessage and not an empty one: bytes that are not protobuf at all, which is
    // what a corrupted frame or a future wire format looks like arriving at today's decoder.
    await expect(
      handleDistributionFrame({
        scope: workspaceScope('ws-1'),
        workspaceId: 'ws-1',
        groupId: 'g-1',
        sender: 'bob',
        plaintext: new Uint8Array([0xff, 0xff, 0xff, 0xff]),
      })
    ).resolves.toBeUndefined();

    // Nothing was stored, which is the whole reason acknowledging has to be a DECISION rather than
    // an accident: the frame is dropped, and it is dropped because no redelivery could ever help.
    expect(saved).toHaveLength(0);
    warn.mockRestore();
  });

  it('says so, because a seed silently dropped surfaces weeks later as an unreadable salon', async () => {
    const { storage } = fakeStorage();
    wire(storage);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await handleDistributionFrame({
      scope: workspaceScope('ws-1'),
      workspaceId: 'ws-1',
      groupId: 'g-1',
      sender: 'bob',
      plaintext: new Uint8Array([0xff, 0xff, 0xff, 0xff]),
    });

    expect(warn.mock.calls.flat().join(' ')).toContain('undecodable frame');
    warn.mockRestore();
  });
});

/**
 * A bundle travels on the community's distribution group, so EVERY member receives the answer to
 * ANY member's request. Re-reading a salon is owed only for what the frame made readable - a new
 * session or a lower floor - never for a copy of what is held: that re-read was a full history
 * refetch on every online member, per answer (18 refetches of one salon in three minutes on a web
 * client that had asked for nothing, production console 2026-10-12).
 */
describe('a seed this device already holds', () => {
  const held = (firstIndex: number): StoredGraineSession => ({
    workspaceId: 'ws-1',
    channelId: 'chan-1',
    sessionId: 'sess-1',
    senderId: 'bob',
    seedB64: toBase64(SEED),
    firstIndex,
    createdAt: 1_700_000_000_000,
  });

  function bundleOf(firstIndex: number) {
    return {
      ...frame(),
      sender: 'carol',
      plaintext: encodeAppMessage(
        mkGraineBundle({
          workspaceId: 'ws-1',
          requestId: 'r-of-somebody-else',
          seeds: [
            {
              channelId: 'chan-1',
              sessionId: 'sess-1',
              seed: SEED,
              firstIndex,
              createdAt: 1_700_000_000_000,
            },
          ],
        })
      ),
    };
  }

  function listen(): string[][] {
    const repaired: string[][] = [];
    setGraineRepairListener((ids) => repaired.push(ids));
    return repaired;
  }

  afterEach(() => setGraineRepairListener(null));

  it('re-reads no salon when a bundle carries only seeds already held', async () => {
    const { storage, saved } = fakeStorage([held(0)]);
    wire(storage);
    const repaired = listen();
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);

    await handleDistributionFrame(bundleOf(0));

    expect(saved).toHaveLength(0);
    expect(repaired).toEqual([]);
    // "absorbed 0" alone would read as a bundle whose seeds were all REFUSED; the held count is what
    // tells the two apart.
    expect(debug.mock.calls.flat().join(' ')).toContain('absorbed 0/1 seed(s) (1 already held)');
    debug.mockRestore();
  });

  it('reads a held session from the store ONCE, however many copies arrive (2026-10-13)', async () => {
    // A store phone read `graine` 358 times in its first 30 s: one row read and decrypted per
    // arriving copy of a seed it already held.
    const { storage } = fakeStorage([held(0)]);
    const reads = vi.spyOn(storage, 'getGraineSession');
    wire(storage);
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);

    for (let i = 0; i < 5; i++) await handleDistributionFrame(bundleOf(0));
    await handleDistributionFrame(frame());

    expect(reads).toHaveBeenCalledTimes(1);
    debug.mockRestore();
  });

  it('re-reads no salon when the distributed copy of a held seed comes back', async () => {
    const { storage } = fakeStorage([held(0)]);
    wire(storage);
    const repaired = listen();

    await handleDistributionFrame(frame());

    expect(repaired).toEqual([]);
  });

  it('still re-reads the salon when the copy LOWERS the floor - more history became readable', async () => {
    const { storage, saved } = fakeStorage([held(40)]);
    wire(storage);
    const repaired = listen();

    await handleDistributionFrame(bundleOf(0));

    expect(saved[0].firstIndex).toBe(0);
    expect(repaired).toEqual([['chan-1']]);
  });
});

describe('the past goes only to an admission this device can verify (section 25)', () => {
  /** dave joined after the proof existed, with no voucher, and his device is in the tree. */
  const DAVE_DEVICE_SECRET = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);
  let DAVE_DEVICE_PK: Uint8Array;
  beforeAll(async () => {
    DAVE_DEVICE_PK = await ed25519PublicKeyOf(DAVE_DEVICE_SECRET);
  });
  beforeEach(() => {
    tree.set('dave:dev-d', DAVE_DEVICE_PK);
    leaves.push('dave:dev-d');
    registerCommunityHistoryVisibility('ws-1', 'shared');
    // A public salon this device listed (#2262): what is withheld here is the admission alone.
    registerChannelWorkspace('chan-1', 'ws-1', false);
    graineHistoryFloor.mockReset();
  });

  const community: StoredGraineSession[] = [
    {
      workspaceId: 'ws-1',
      channelId: 'chan-1',
      sessionId: 's-1',
      senderId: 'alice',
      seedB64: toBase64(SEED),
      firstIndex: 0,
      createdAt: 1,
    },
  ];

  function wireAnswerer() {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    setGraineRuntime({
      storage: {
        getGraineSession: async (id: string) => community.find((c) => c.sessionId === id) ?? null,
        saveGraineSession: async () => undefined,
        getGraineSessionsForWorkspace: async () => community,
        countGraineSessionsForWorkspace: async () => community.length,
      } as unknown as IStorage,
      deviceKey: () => 'device-key',
      userId: 'alice',
      mlsService: graineMls({ sendMessage }),
    });
    return sendMessage;
  }

  function ask(kind: 'history' | 'sessions') {
    return {
      scope: workspaceScope('ws-1'),
      workspaceId: 'ws-1',
      groupId: 'g-1',
      sender: 'newcomer',
      senderDeviceId: 'newcomer-web',
      plaintext: encodeAppMessage(
        mkGraineRequest({
          workspaceId: 'ws-1',
          kind:
            kind === 'history'
              ? canari.GraineRequestKind.GRAINE_REQUEST_KIND_HISTORY
              : canari.GraineRequestKind.GRAINE_REQUEST_KIND_SESSIONS,
          sessionIds: kind === 'sessions' ? ['s-1'] : [],
          answererUserId: 'alice',
          requestId: 'r-a',
        })
      ),
    };
  }

  /** A direct voucher: `signer` admitted `subject`, signed with `secret`. */
  async function directVoucher(
    subject: string,
    signer: { userId: string; deviceId: string },
    secret: Uint8Array,
    workspaceId = 'ws-1'
  ) {
    const statement = {
      workspaceId,
      subjectUserId: subject,
      signer,
      place: { keyGroupId: 'g-1', epoch: 5 },
      issuedAt: 1_800_000_000_000,
    };
    return encodeAdmissionVoucher({
      kind: 'direct',
      ...statement,
      signature: await webCryptoEngine.signWithSessionKey(secret, encodeDirectAdmission(statement)),
    });
  }

  /** The roster with `newcomer` arrived after the proof existed, carrying `voucher`. */
  function newcomerArrives(voucher: string | null) {
    listWorkspaceMembers.mockResolvedValue([
      member('alice'),
      member('carol'),
      member('dave', AFTER_THE_PROOF),
      member('newcomer', AFTER_THE_PROOF, { admissionVoucher: voucher }),
    ]);
  }

  const carolDevice = { userId: 'carol', deviceId: 'dev-c' };

  it('hands no past to a newcomer whose admission carries no proof, and says why', async () => {
    newcomerArrives(null);
    const sendMessage = wireAnswerer();
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await handleDistributionFrame(ask('history'));

    // The community SHARES its past - and this member's admission is the server's word alone.
    expect(sendMessage).not.toHaveBeenCalled();
    expect(info.mock.calls.flat().join(' ')).toContain('admission is not proven');
    info.mockRestore();
  });

  it('hands the past to a newcomer a rooted member admitted directly', async () => {
    newcomerArrives(await directVoucher('newcomer', carolDevice, CAROL_DEVICE_SECRET));
    const sendMessage = wireAnswerer();

    await handleDistributionFrame(ask('history'));

    const bundle = decodeAppMessage(sendMessage.mock.calls[0][1])?.graineBundle;
    expect(bundle?.seeds?.map((x) => x.sessionId)).toEqual(['s-1']);
  });

  it('hands the past to a newcomer who followed a link a rooted member stood behind', async () => {
    const grant = await mintInviteLinkGrant(
      'ws-1',
      carolDevice,
      { keyGroupId: 'g-1', epoch: 5 },
      1_800_000_000_000,
      // An expiry no run of this suite reaches - the expiry itself is admissionGate.test.ts's row.
      4_000_000_000_000,
      webCryptoEngine,
      (m) => webCryptoEngine.signWithSessionKey(CAROL_DEVICE_SECRET, m)
    );
    newcomerArrives(
      encodeAdmissionVoucher(await redeemInviteLinkGrant(grant, 'newcomer', webCryptoEngine))
    );
    const sendMessage = wireAnswerer();

    await handleDistributionFrame(ask('history'));

    expect(decodeAppMessage(sendMessage.mock.calls[0][1])?.graineBundle?.seeds).toHaveLength(1);
  });

  it('refuses a voucher signed by a member whose own admission is not proven', async () => {
    // dave is in the tree with a real key and signs a real voucher: the chain still has no root.
    newcomerArrives(
      await directVoucher('newcomer', { userId: 'dave', deviceId: 'dev-d' }, DAVE_DEVICE_SECRET)
    );
    const sendMessage = wireAnswerer();
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await handleDistributionFrame(ask('history'));

    expect(sendMessage).not.toHaveBeenCalled();
    info.mockRestore();
  });

  it('accepts a chain: a voucher signed by a member who was admitted by a rooted one', async () => {
    listWorkspaceMembers.mockResolvedValue([
      member('alice'),
      member('carol'),
      member('dave', AFTER_THE_PROOF, {
        admissionVoucher: await directVoucher('dave', carolDevice, CAROL_DEVICE_SECRET),
      }),
      member('newcomer', AFTER_THE_PROOF, {
        admissionVoucher: await directVoucher(
          'newcomer',
          { userId: 'dave', deviceId: 'dev-d' },
          DAVE_DEVICE_SECRET
        ),
      }),
    ]);
    const sendMessage = wireAnswerer();

    await handleDistributionFrame(ask('history'));

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('refuses a voucher that admits somebody else, copied onto the newcomer row', async () => {
    newcomerArrives(await directVoucher('dave', carolDevice, CAROL_DEVICE_SECRET));
    const sendMessage = wireAnswerer();
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await handleDistributionFrame(ask('history'));

    expect(sendMessage).not.toHaveBeenCalled();
    info.mockRestore();
    warn.mockRestore();
  });

  it('refuses a voucher for another community, or one whose signature does not hold', async () => {
    for (const voucher of [
      await directVoucher('newcomer', carolDevice, CAROL_DEVICE_SECRET, 'ws-other'),
      await directVoucher('newcomer', carolDevice, DAVE_DEVICE_SECRET),
    ]) {
      localStorage.clear();
      newcomerArrives(voucher);
      const sendMessage = wireAnswerer();
      const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await handleDistributionFrame(ask('history'));

      expect(sendMessage).not.toHaveBeenCalled();
      expect(warn.mock.calls.flat().join(' ')).toContain('REFUSED admission voucher');
      info.mockRestore();
      warn.mockRestore();
    }
  });

  it('answers an unproven repair as joined: the seed floored at the newcomer arrival', async () => {
    newcomerArrives(null);
    graineHistoryFloor.mockResolvedValue({ 's-1': 4 });
    const sendMessage = wireAnswerer();
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await handleDistributionFrame(ask('sessions'));

    // They still read everything from their arrival on: the server places that floor.
    expect(graineHistoryFloor).toHaveBeenCalledWith('chan-1', 'newcomer', ['s-1']);
    const seeds = decodeAppMessage(sendMessage.mock.calls[0][1])?.graineBundle?.seeds;
    expect(Number(seeds?.[0].firstIndex)).toBe(4);
    info.mockRestore();
  });

  it('keeps the roots it recorded first: a later backdated arrival does not make a member rooted', async () => {
    newcomerArrives(null);
    wireAnswerer();
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await handleDistributionFrame(ask('history'));

    // The server now claims the newcomer arrived before the proof existed.
    listWorkspaceMembers.mockResolvedValue([
      member('alice'),
      member('carol'),
      member('newcomer', BEFORE_THE_PROOF),
    ]);
    const sendMessage = wireAnswerer();
    await handleDistributionFrame(ask('history'));

    expect(sendMessage).not.toHaveBeenCalled();
    info.mockRestore();
  });

  it('roots the creator of the community, the one member nobody else admitted', async () => {
    listWorkspaceMembers.mockResolvedValue([
      member('alice', AFTER_THE_PROOF),
      member('newcomer', AFTER_THE_PROOF, { isCreator: true }),
    ]);
    const sendMessage = wireAnswerer();
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await handleDistributionFrame(ask('history'));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    info.mockRestore();
  });

  /**
   * THE ASK ARRIVES ON THE KEY GROUP, SO IT IS THAT GROUP'S CURRENT WORK: the gate run inside it never
   * sees the group drained, and a voucher not observed before the ask would stay unobserved until a
   * restart. The ask is parked instead and decided again by the drain that follows it.
   */
  describe('an ask that arrives before its voucher could be observed', () => {
    let drained = false;
    let drainWaiters: Array<() => void> = [];
    beforeEach(() => {
      drained = false;
      drainWaiters = [];
    });
    afterEach(() => {
      clearParkedAsks();
      vi.restoreAllMocks();
    });

    /** The answerer, with its key group not drained until {@link drainNow}. */
    function wireUndrainedAnswerer() {
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      setGraineRuntime({
        storage: {
          getGraineSession: async (id: string) => community.find((c) => c.sessionId === id) ?? null,
          saveGraineSession: async () => undefined,
          getGraineSessionsForWorkspace: async () => community,
          countGraineSessionsForWorkspace: async () => community.length,
        } as unknown as IStorage,
        deviceKey: () => 'device-key',
        userId: 'alice',
        mlsService: graineMls({
          sendMessage,
          isGroupDrained: () => drained,
          whenGroupDrained: () =>
            drained ? Promise.resolve() : new Promise<void>((wake) => drainWaiters.push(wake)),
        }),
      });
      return sendMessage;
    }
    function drainNow() {
      drained = true;
      const woken = drainWaiters;
      drainWaiters = [];
      for (const wake of woken) wake();
    }

    it('answers a newcomer who asked at once, after the drain, with no restart', async () => {
      newcomerArrives(await directVoucher('newcomer', carolDevice, CAROL_DEVICE_SECRET));
      const sendMessage = wireUndrainedAnswerer();
      const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

      await handleDistributionFrame(ask('history'));
      // Inside the ask's own frame: nothing observed, nothing answered, nothing refused.
      expect(sendMessage).not.toHaveBeenCalled();
      expect(parkedAskCount()).toBe(1);

      drainNow();
      await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
      const bundle = decodeAppMessage(sendMessage.mock.calls[0][1])?.graineBundle;
      expect(bundle?.seeds?.map((x) => x.sessionId)).toEqual(['s-1']);
      expect(parkedAskCount()).toBe(0);
      info.mockRestore();
    });

    it('keeps refusing after the drain a voucher whose signer was removed before the observation', async () => {
      // carol was removed at epoch 4; this device observes at epoch 5.
      departuresByGroup.set('g-1', new Map([['carol', [4]]]));
      newcomerArrives(await directVoucher('newcomer', carolDevice, CAROL_DEVICE_SECRET));
      const sendMessage = wireUndrainedAnswerer();
      const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

      await handleDistributionFrame(ask('history'));
      expect(parkedAskCount()).toBe(1);

      drainNow();
      await vi.waitFor(() =>
        expect(info.mock.calls.flat().join(' ')).toContain('not sending history to newcomer')
      );
      const said = info.mock.calls.flat().join(' ');
      expect(said).toContain('deciding 1 parked ask(s) again');
      expect(said).toContain(
        'its signer carol was not admitted here when this device first saw it'
      );
      expect(sendMessage).not.toHaveBeenCalled();
      expect(parkedAskCount()).toBe(0);
      info.mockRestore();
    });

    it('keeps one ask per asking device, and drops the oldest past the bound, out loud', async () => {
      newcomerArrives(await directVoucher('newcomer', carolDevice, CAROL_DEVICE_SECRET));
      wireUndrainedAnswerer();
      const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await handleDistributionFrame(ask('history'));
      await handleDistributionFrame(ask('history'));
      expect(parkedAskCount()).toBe(1);

      for (let i = 0; i < MAX_PARKED_ASKS; i += 1) {
        await handleDistributionFrame({ ...ask('history'), senderDeviceId: `newcomer-${i}` });
      }
      expect(parkedAskCount()).toBe(MAX_PARKED_ASKS);
      expect(warn.mock.calls.flat().join(' ')).toContain(
        'DROPPED the parked ask of newcomer:newcomer-web'
      );
      info.mockRestore();
      warn.mockRestore();
    });

    it('parks a HISTORY ask and a SESSIONS repair of one device side by side, and answers both', async () => {
      newcomerArrives(await directVoucher('newcomer', carolDevice, CAROL_DEVICE_SECRET));
      const sendMessage = wireUndrainedAnswerer();
      const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

      await handleDistributionFrame(ask('history'));
      await handleDistributionFrame(ask('sessions'));
      expect(parkedAskCount()).toBe(2);

      drainNow();
      await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
      info.mockRestore();
    });

    it('answers at once a repair naming only sessions it does not hold - "missing" needs no gate', async () => {
      newcomerArrives(await directVoucher('newcomer', carolDevice, CAROL_DEVICE_SECRET));
      const sendMessage = wireUndrainedAnswerer();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const repair = ask('sessions');
      repair.plaintext = encodeAppMessage(
        mkGraineRequest({
          workspaceId: 'ws-1',
          kind: canari.GraineRequestKind.GRAINE_REQUEST_KIND_SESSIONS,
          sessionIds: ['s-unknown'],
          answererUserId: 'alice',
          requestId: 'r-b',
        })
      );

      await handleDistributionFrame(repair);

      expect(parkedAskCount()).toBe(0);
      const bundle = decodeAppMessage(sendMessage.mock.calls[0][1])?.graineBundle;
      expect(bundle?.missingSessionIds).toEqual(['s-unknown']);
      warn.mockRestore();
    });

    it('forgets every parked ask at sign-out: the drain that follows answers nothing', async () => {
      newcomerArrives(await directVoucher('newcomer', carolDevice, CAROL_DEVICE_SECRET));
      const sendMessage = wireUndrainedAnswerer();
      const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      await handleDistributionFrame(ask('history'));
      expect(parkedAskCount()).toBe(1);

      clearParkedAsks();
      setGraineRuntime(null);
      expect(parkedAskCount()).toBe(0);

      drainNow();
      await Promise.resolve();
      await Promise.resolve();
      expect(sendMessage).not.toHaveBeenCalled();
      info.mockRestore();
    });

    /**
     * THE JUNCTION, with no hand-fired drain: the ask is applied by the REAL scheduler of a real
     * service, parks inside its own frame, and the scheduler finishing that frame is what answers it.
     */
    it('answers through the real scheduler: the ask parks in its frame, the frame ending answers it', async () => {
      newcomerArrives(await directVoucher('newcomer', carolDevice, CAROL_DEVICE_SECRET));
      vi.spyOn(console, 'info').mockImplementation(() => undefined);
      vi.spyOn(console, 'debug').mockImplementation(() => undefined);
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      abstract class Harness extends BaseMlsService {}
      const svc = new (Harness as unknown as new (platform: 'web' | 'tauri') => BaseMlsService)(
        'web'
      );
      // The last pull emptied the mailbox and the socket is open: only the scheduler decides.
      Object.assign(svc, { mailboxEmptiedByAPull: true, isWsOpen: () => true });
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      setGraineRuntime({
        storage: {
          getGraineSession: async (id: string) => community.find((c) => c.sessionId === id) ?? null,
          saveGraineSession: async () => undefined,
          getGraineSessionsForWorkspace: async () => community,
          countGraineSessionsForWorkspace: async () => community.length,
        } as unknown as IStorage,
        deviceKey: () => 'device-key',
        userId: 'alice',
        mlsService: graineMls({
          sendMessage,
          isGroupDrained: (g: string) => svc.isGroupDrained(g),
          whenGroupDrained: (g: string) => svc.whenGroupDrained(g),
        }),
      });
      const scheduler = (svc as unknown as { messageScheduler: MlsPerGroupScheduler })
        .messageScheduler;
      scheduler.enqueue({
        senderId: 'newcomer',
        ciphertext: new Uint8Array(1),
        groupId: 'g-1',
        isWelcome: false,
        isCommit: false,
      });

      await scheduler.drain(async () => {
        await handleDistributionFrame(ask('history'));
        // Inside the frame: parked, unanswered.
        expect(parkedAskCount()).toBe(1);
        expect(sendMessage).not.toHaveBeenCalled();
      });

      await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
      const bundle = decodeAppMessage(sendMessage.mock.calls[0][1])?.graineBundle;
      expect(bundle?.seeds?.map((x) => x.sessionId)).toEqual(['s-1']);
      expect(parkedAskCount()).toBe(0);
    });
  });

  it('hands nothing over, out loud, when the roster cannot be read', async () => {
    listWorkspaceMembers.mockRejectedValue(new Error('offline'));
    const sendMessage = wireAnswerer();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await handleDistributionFrame(ask('history'));

    expect(sendMessage).not.toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(' ')).toContain('cannot verify');
    warn.mockRestore();
    info.mockRestore();
  });
});

/**
 * AN ANSWER CARRIES ONLY THE SEEDS OF THE SALONS ITS KEY GROUP MAY READ.
 *
 * Every seed is stored under its COMMUNITY, whichever key group it arrived on, so the store does not
 * say on its own which roster a seed was sealed to. A private salon has its own key group so that a
 * member outside it is never sent its seed - and an answer gathered from the community store and
 * sent on the COMMUNITY's group would hand that seed to whoever asked there. The scope the frame
 * arrived on is the roster the answer goes back to, so it filters the answer, on both answer paths;
 * and the receiver refuses a seed whose salon belongs to another roster than the group it arrived on.
 */
describe('the salon scope of an answer', () => {
  const PUBLIC = 'chan-pub';
  const PRIVATE = 'chan-priv';

  const sessionIn = (channelId: string, sessionId: string): StoredGraineSession => ({
    workspaceId: 'ws-1',
    channelId,
    sessionId,
    senderId: 'carol',
    seedB64: toBase64(SEED),
    firstIndex: 0,
    createdAt: 1,
  });
  const held = [sessionIn(PUBLIC, 's-pub'), sessionIn(PRIVATE, 's-priv')];

  beforeEach(() => {
    // The asker is a member admitted before the proof (a root, section 25): what these rows test
    // is the salon scope of the answer, never the admission.
    communityGroup = 'g-community';
    leaves.push('mallory:mallory-web');
    // The private salon's own key group: alice and mallory only.
    salonLeaves = ['alice:alice-laptop', 'mallory:mallory-web'];
    listWorkspaceMembers.mockResolvedValue(
      ['alice', 'bob', 'carol', 'mallory'].map((id) => member(id))
    );
  });

  it("judges admission on the COMMUNITY's key group, even when the first ask arrives on a salon's", async () => {
    // The first ledger write on this device comes from a SESSIONS ask on the private salon's own
    // group. The roots are the community's members, never that salon's: bob, in the community and
    // not in the salon, still gets the past when he asks on the community's group.
    const sendMessage = wireAnswerer(BOTH_LISTED);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await handleDistributionFrame(
      askOn(channelScope('ws-1', PRIVATE), {
        kind: canari.GraineRequestKind.GRAINE_REQUEST_KIND_SESSIONS,
        sessionIds: ['s-priv'],
      })
    );
    sendMessage.mockClear();

    await handleDistributionFrame({
      ...askOn(workspaceScope('ws-1'), {
        kind: canari.GraineRequestKind.GRAINE_REQUEST_KIND_HISTORY,
      }),
      sender: 'bob',
      senderDeviceId: 'dev-b',
    });

    expect(answered(sendMessage)).toEqual(['s-pub']);
    info.mockRestore();
  });

  it("a removal from a salon's own key group is no removal from the community", async () => {
    // mallory once left the salon's own group (epoch 3) and is back in it; the community never
    // removed her. Her ask on the salon's group is judged by the community's removals.
    departuresByGroup.set('g-private', new Map([['mallory', [3]]]));
    const sendMessage = wireAnswerer(BOTH_LISTED);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await handleDistributionFrame(
      askOn(channelScope('ws-1', PRIVATE), {
        kind: canari.GraineRequestKind.GRAINE_REQUEST_KIND_HISTORY,
      })
    );

    expect(answered(sendMessage)).toEqual(['s-priv']);
    expect(info.mock.calls.flat().join(' ')).not.toContain('not proven');
    info.mockRestore();
  });

  /** alice holds a seed of each salon; `listed` is what her community listing registered. */
  function wireAnswerer(listed: { channelId: string; isPrivate: boolean }[]) {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const rows = new Map(held.map((s) => [s.sessionId, s]));
    setGraineRuntime({
      storage: {
        getGraineSession: async (id: string) => rows.get(id) ?? null,
        saveGraineSession: async () => undefined,
        getGraineSessionsForWorkspace: async () => held,
        countGraineSessionsForWorkspace: async () => held.length,
      } as unknown as IStorage,
      deviceKey: () => 'device-key',
      userId: 'alice',
      mlsService: graineMls({ sendMessage }),
    });
    registerCommunityHistoryVisibility('ws-1', 'shared');
    for (const { channelId, isPrivate } of listed)
      registerChannelWorkspace(channelId, 'ws-1', isPrivate);
    return sendMessage;
  }
  const BOTH_LISTED = [
    { channelId: PUBLIC, isPrivate: false },
    { channelId: PRIVATE, isPrivate: true },
  ];

  function askOn(
    scope: DistributionScope,
    request: Partial<Parameters<typeof mkGraineRequest>[0]>
  ) {
    return {
      scope,
      workspaceId: 'ws-1',
      groupId: scope.kind === 'workspace' ? 'g-community' : 'g-private',
      sender: 'mallory',
      senderDeviceId: 'mallory-web',
      plaintext: encodeAppMessage(
        mkGraineRequest({
          workspaceId: 'ws-1',
          answererUserId: 'alice',
          requestId: 'r-s',
          ...request,
        })
      ),
    };
  }

  const bundleSent = (sendMessage: ReturnType<typeof vi.fn>) =>
    decodeAppMessage(sendMessage.mock.calls[0]?.[1])?.graineBundle;
  const answered = (sendMessage: ReturnType<typeof vi.fn>) =>
    (bundleSent(sendMessage)?.seeds ?? []).map((s) => String(s.sessionId));

  it("a HISTORY answer on the community's group carries no seed of a private salon", async () => {
    const sendMessage = wireAnswerer(BOTH_LISTED);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await handleDistributionFrame(
      askOn(workspaceScope('ws-1'), { kind: canari.GraineRequestKind.GRAINE_REQUEST_KIND_HISTORY })
    );

    expect(answered(sendMessage)).toEqual(['s-pub']);
    expect(info.mock.calls.flat().join(' ')).toContain('withholding 1 seed(s)');
    info.mockRestore();
  });

  it("a SESSIONS answer on the community's group withholds a private salon's session, without calling it missing", async () => {
    const sendMessage = wireAnswerer(BOTH_LISTED);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await handleDistributionFrame(
      askOn(workspaceScope('ws-1'), {
        kind: canari.GraineRequestKind.GRAINE_REQUEST_KIND_SESSIONS,
        sessionIds: ['s-pub', 's-priv'],
      })
    );

    expect(answered(sendMessage)).toEqual(['s-pub']);
    // "Missing" means "ask somebody else", and every honest member applies the same filter.
    expect(bundleSent(sendMessage)?.missingSessionIds ?? []).toEqual([]);
    info.mockRestore();
  });

  it("an answer on a private salon's own group carries that salon's seeds and no other", async () => {
    const sendMessage = wireAnswerer(BOTH_LISTED);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await handleDistributionFrame(
      askOn(channelScope('ws-1', PRIVATE), {
        kind: canari.GraineRequestKind.GRAINE_REQUEST_KIND_SESSIONS,
        sessionIds: ['s-pub', 's-priv'],
      })
    );

    expect(answered(sendMessage)).toEqual(['s-priv']);
    info.mockRestore();
  });

  it('withholds a seed whose salon this device has not listed - its roster is not known', async () => {
    const sendMessage = wireAnswerer([{ channelId: PUBLIC, isPrivate: false }]);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await handleDistributionFrame(
      askOn(workspaceScope('ws-1'), { kind: canari.GraineRequestKind.GRAINE_REQUEST_KIND_HISTORY })
    );

    expect(answered(sendMessage)).toEqual(['s-pub']);
    expect(info.mock.calls.flat().join(' ')).toContain('1 not listed on this device');
    info.mockRestore();
  });

  it('stays silent when every seed it holds belongs to another roster - never "I hold nothing"', async () => {
    const sendMessage = wireAnswerer([{ channelId: PRIVATE, isPrivate: true }]);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await handleDistributionFrame(
      askOn(workspaceScope('ws-1'), { kind: canari.GraineRequestKind.GRAINE_REQUEST_KIND_HISTORY })
    );

    // The public seed is unlisted and the private one is another roster's: nothing may travel, and
    // "I hold nothing" would be false - this device holds rows of the community.
    expect(sendMessage).not.toHaveBeenCalled();
    info.mockRestore();
  });

  /** A bundle on the community's group, carrying the seeds named. */
  async function oldAnswerersBundle(sessions: [string, string][]) {
    return {
      scope: workspaceScope('ws-1'),
      workspaceId: 'ws-1',
      groupId: 'g-community',
      sender: 'bob',
      senderDeviceId: 'bob-web',
      plaintext: encodeAppMessage(
        mkGraineBundle({
          workspaceId: 'ws-1',
          requestId: 'r-1',
          seeds: await Promise.all(sessions.map(([c, s]) => v2SeedFor(c, s, 0))),
        })
      ),
    };
  }

  it("an ADMIN's device, whose listing names the private salon, refuses its seed on the community's group", async () => {
    const { storage, saved } = fakeStorage();
    wire(storage);
    // The listing shows an administrator the private salons they have not joined.
    registerChannelWorkspace(PUBLIC, 'ws-1', false);
    registerChannelWorkspace(PRIVATE, 'ws-1', true);
    markCommunityListed('ws-1');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await handleDistributionFrame(
      await oldAnswerersBundle([
        [PUBLIC, 's-pub'],
        [PRIVATE, 's-priv'],
      ])
    );

    expect(saved.map((s) => s.sessionId)).toEqual(['s-pub']);
    // One warn per bundle, however many seeds it carries.
    const said = warn.mock.calls.flat().join(' ');
    expect(said).toContain('not storing 1 seed(s) relayed by bob');
    expect(said).toContain('(s-priv)');
    warn.mockRestore();
  });

  it("an ORDINARY non-member's device, whose listing never names the private salon, does not store its seed", async () => {
    // What social-service lists to a member who is not in a private salon: the public salons only.
    const { storage, saved } = fakeStorage();
    wire(storage);
    registerChannelWorkspace(PUBLIC, 'ws-1', false);
    markCommunityListed('ws-1');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await handleDistributionFrame(
      await oldAnswerersBundle([
        [PUBLIC, 's-pub'],
        [PRIVATE, 's-priv'],
      ])
    );

    expect(saved.map((s) => s.sessionId)).toEqual(['s-pub']);
    expect(warn.mock.calls.flat().join(' ')).toContain(
      "1 waiting unstored for a salon the community's listing did not name"
    );

    // Nothing ever registers it as public, and an event naming it private drops it for good.
    registerChannelWorkspace(PRIVATE, 'ws-1', true);
    await Promise.resolve();
    expect(saved.map((s) => s.sessionId)).toEqual(['s-pub']);
    expect(info.mock.calls.flat().join(' ')).toContain('it is a private salon');
    warn.mockRestore();
    info.mockRestore();
  });

  it("admits a seed that beat its salon's channel-created event, once the event registers it public", async () => {
    const { storage, saved } = fakeStorage();
    wire(storage);
    registerChannelWorkspace(PUBLIC, 'ws-1', false);
    markCommunityListed('ws-1');
    const repaired: string[][] = [];
    setGraineRepairListener((ids) => repaired.push(ids));
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await handleDistributionFrame({
      scope: workspaceScope('ws-1'),
      workspaceId: 'ws-1',
      groupId: 'g-community',
      sender: 'bob',
      plaintext: encodeAppMessage({ ...mkGraine(await v2SeedFor('chan-new', 's-new', 0)) }),
    });
    expect(saved).toHaveLength(0);

    registerChannelWorkspace('chan-new', 'ws-1', false);
    await vi.waitFor(() => expect(saved.map((s) => s.sessionId)).toEqual(['s-new']));
    await vi.waitFor(() => expect(repaired).toEqual([['chan-new']]));
    setGraineRepairListener(null);
    info.mockRestore();
  });

  it('says a distributed seed of a salon now private is not stored, without accusing its sender', async () => {
    // A salon made private keeps, in the community group's log, the seeds minted while it was public.
    const { storage, saved } = fakeStorage();
    wire(storage);
    registerChannelWorkspace(PRIVATE, 'ws-1', true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await handleDistributionFrame({
      scope: workspaceScope('ws-1'),
      workspaceId: 'ws-1',
      groupId: 'g-community',
      sender: 'bob',
      plaintext: encodeAppMessage({ ...mkGraine(await v2SeedFor(PRIVATE, 's-old', 0)) }),
    });

    expect(saved).toHaveLength(0);
    expect(error).not.toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(' ')).toContain('before it became private');
    warn.mockRestore();
    error.mockRestore();
  });

  it('keeps a seed whose salon is not listed yet on the community group - the answerer filtered it', async () => {
    const { storage, saved } = fakeStorage();
    wire(storage);

    await handleDistributionFrame({
      scope: workspaceScope('ws-1'),
      workspaceId: 'ws-1',
      groupId: 'g-community',
      sender: 'bob',
      plaintext: encodeAppMessage({ ...mkGraine(await v2SeedFor('chan-new', 's-new', 0)) }),
    });

    // BEFORE the community's listing has answered: a public salon's seeds arrive with the key group,
    // ahead of the listing that names it; refusing them would leave the salon unreadable.
    expect(saved.map((s) => s.sessionId)).toEqual(['s-new']);
  });

  it("refuses a seed of another salon arriving on a private salon's own group, listed or not", async () => {
    const { storage, saved } = fakeStorage();
    wire(storage);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await handleDistributionFrame({
      scope: channelScope('ws-1', PRIVATE),
      workspaceId: 'ws-1',
      groupId: 'g-private',
      sender: 'bob',
      plaintext: encodeAppMessage({ ...mkGraine(await v2SeedFor('chan-elsewhere', 's-x', 0)) }),
    });

    expect(saved).toHaveLength(0);
    expect(error.mock.calls.flat().join(' ')).toContain('REFUSED seed s-x');
    error.mockRestore();
  });
});
