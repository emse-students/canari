import type { IStorage, StoredGraineSession } from '$lib/db/types';
import { byNewestSession } from '$lib/db/graineCodec';
import { openWithGraine } from '$lib/crypto/graine';
import { fromBase64, toBase64 } from '$lib/utils/hex';
import {
  GraineBelowFirstIndexError,
  GraineSessionUnavailableError,
  GraineUnknownChannelError,
  openChannelMessage,
  sealChannelMessage,
} from './channelSeal';
import { GraineDistributionUnavailableError } from './seedDistribution';
import { registerChannelWorkspace, setGraineRuntime } from './runtime';
import type { DistributionScope } from '$lib/mls-client/distributionScope';

/**
 * The seam that replaced the server-derived epoch key (WP-31/32).
 *
 * What is pinned: a message is sealed under a session the community can actually READ (the seal is
 * refused otherwise, rather than producing a row nobody can open), the round trip really works
 * against the pure crypto rather than against a stub of itself, and every unreadability is a TYPE -
 * because a missing seed is repairable, a message below the handover floor is the protocol working,
 * and rendering both as "no message" is the silence this whole rework exists to remove.
 */

vi.mock('./graineMirror', () => ({ mirrorGraineSeed: vi.fn().mockResolvedValue(undefined) }));

const WS = 'ws-1';
const CHANNEL = 'chan-1';

function fakeStorage(seed: StoredGraineSession[] = []) {
  const rows = new Map(seed.map((s) => [s.sessionId, s]));
  return {
    rows,
    storage: {
      getGraineSessions: async (channelId: string) =>
        [...rows.values()].filter((s) => s.channelId === channelId).sort(byNewestSession),
      getGraineSession: async (sessionId: string) => rows.get(sessionId) ?? null,
      saveGraineSession: async (s: StoredGraineSession) => {
        rows.set(s.sessionId, s);
      },
    } as unknown as IStorage,
  };
}

/**
 * An MLS service holding the distribution groups at `epoch`, or holding none.
 *
 * BOTH SCOPES, because the salon's group is the whole point: a stub that only answered for the
 * community would let a seal meant for a private salon fall back to the community's group and the
 * test would still pass, which is exactly the defect.
 */
function fakeMls(epoch: number | null) {
  const sent: { groupId: string; bytes: Uint8Array }[] = [];
  return {
    sent,
    mls: {
      distributionGroupFor: (scope: DistributionScope) => {
        if (scope.kind === 'workspace') return scope.workspaceId === WS ? 'g-1' : null;
        return scope.channelId === CHANNEL ? 'g-salon' : null;
      },
      getLocalGroups: () => (epoch === null ? [] : ['g-1', 'g-salon']),
      getEpoch: () => epoch ?? 0,
      sendMessage: async (groupId: string, bytes: Uint8Array) => {
        sent.push({ groupId, bytes });
        return new Uint8Array();
      },
    } as never,
  };
}

function wire(storage: IStorage, mls: ReturnType<typeof fakeMls>['mls'], isPrivate = false): void {
  setGraineRuntime({ storage, deviceKeyB64: 'device-key', userId: 'alice', mlsService: mls });
  registerChannelWorkspace(CHANNEL, WS, isPrivate);
}

afterEach(() => setGraineRuntime(null));

describe('sealing', () => {
  it('seals, distributes the seed, and names the session and index on the wire', async () => {
    const { storage } = fakeStorage();
    const { mls, sent } = fakeMls(4);
    wire(storage, mls);

    const sealed = await sealChannelMessage(CHANNEL, new Uint8Array([1, 2, 3]));

    expect(sealed.senderSessionId).toBeTruthy();
    expect(sealed.messageIndex).toBe(0);
    // One frame on the community's distribution group: O(1), whatever the member count.
    expect(sent).toHaveLength(1);
    expect(sent[0].groupId).toBe('g-1');
  });

  it('refuses a channel belonging to no community this session loaded', async () => {
    const { storage } = fakeStorage();
    const { mls } = fakeMls(4);
    setGraineRuntime({ storage, deviceKeyB64: 'k', userId: 'alice', mlsService: mls });

    // Without the community there is no distribution group, so the seed would reach nobody.
    await expect(sealChannelMessage(CHANNEL, new Uint8Array([1]))).rejects.toBeInstanceOf(
      GraineUnknownChannelError
    );
  });

  it('refuses to seal when the distribution group is not in hand', async () => {
    const { storage } = fakeStorage();
    const { mls } = fakeMls(null);
    wire(storage, mls);

    // Refused HERE rather than discovered separately by every reader of an unreadable message.
    await expect(sealChannelMessage(CHANNEL, new Uint8Array([1]))).rejects.toBeInstanceOf(
      GraineDistributionUnavailableError
    );
  });

  it('produces a ciphertext the pure crypto opens at the index it named', async () => {
    const { storage, rows } = fakeStorage();
    const { mls } = fakeMls(4);
    wire(storage, mls);

    const sealed = await sealChannelMessage(CHANNEL, new Uint8Array([7, 7, 7]));
    const session = rows.get(sealed.senderSessionId)!;

    // Against `openWithGraine` itself, not against a mirror of the seal: a round trip through one
    // implementation proves it agrees with itself and nothing more.
    const opened = await openWithGraine(
      fromBase64(session.seedB64),
      sealed.senderSessionId,
      sealed.messageIndex,
      { ciphertext: sealed.ciphertext, nonce: sealed.nonce }
    );
    expect([...opened]).toEqual([7, 7, 7]);
  });
});

describe('opening', () => {
  const SEED = toBase64(new Uint8Array(32).fill(9));

  function held(overrides: Partial<StoredGraineSession> = {}): StoredGraineSession {
    return {
      workspaceId: WS,
      channelId: CHANNEL,
      sessionId: 'sess-1',
      senderId: 'bob',
      seedB64: SEED,
      firstIndex: 0,
      createdAt: 1,
      ...overrides,
    };
  }

  it('reports a missing seed as its own type, so a repair can be addressed', async () => {
    const { storage } = fakeStorage();
    wire(storage, fakeMls(4).mls);

    const err = await openChannelMessage(CHANNEL, {
      ciphertext: 'x',
      nonce: 'y',
      senderSessionId: 'sess-unknown',
      messageIndex: 0,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(GraineSessionUnavailableError);
    expect(err.sessionId).toBe('sess-unknown');
  });

  it('reports a row that names no session as a missing seed, not as an empty message', async () => {
    const { storage } = fakeStorage();
    wire(storage, fakeMls(4).mls);

    await expect(
      openChannelMessage(CHANNEL, {
        ciphertext: 'x',
        nonce: null,
        senderSessionId: null,
        messageIndex: null,
      })
    ).rejects.toBeInstanceOf(GraineSessionUnavailableError);
  });

  it('separates the handover floor from a missing seed, because one must NOT be repaired', async () => {
    const { storage } = fakeStorage([held({ firstIndex: 40 })]);
    wire(storage, fakeMls(4).mls);

    const err = await openChannelMessage(CHANNEL, {
      ciphertext: 'x',
      nonce: 'y',
      senderSessionId: 'sess-1',
      messageIndex: 12,
    }).catch((e) => e);

    // Asking a peer would return the identical seed with the identical floor, for ever.
    expect(err).toBeInstanceOf(GraineBelowFirstIndexError);
    expect(err.firstIndex).toBe(40);
  });

  it('opens exactly at the floor, which is a message this member IS entitled to', async () => {
    const { storage, rows } = fakeStorage();
    const { mls } = fakeMls(4);
    wire(storage, mls);
    const sealed = await sealChannelMessage(CHANNEL, new Uint8Array([5]));
    const mine = rows.get(sealed.senderSessionId)!;
    rows.set(mine.sessionId, { ...mine, firstIndex: sealed.messageIndex });

    const opened = await openChannelMessage(CHANNEL, {
      ciphertext: sealed.ciphertext,
      nonce: sealed.nonce,
      senderSessionId: sealed.senderSessionId,
      messageIndex: sealed.messageIndex,
    });

    // An off-by-one here hides the FIRST message of every handed-over session.
    expect([...opened]).toEqual([5]);
  });
});

describe('a private salon seals on its OWN group', () => {
  it('sends the seed to the salon group, never the community one', async () => {
    const { storage } = fakeStorage();
    const { mls, sent } = fakeMls(4);
    wire(storage, mls, true);

    await sealChannelMessage(CHANNEL, new Uint8Array([1, 2, 3]));

    // The one line that makes a private salon's guarantee cryptographic rather than the server
    // declining to serve its ciphertext: the seed is never even sent to the community's roster.
    expect(sent).toHaveLength(1);
    expect(sent[0].groupId).toBe('g-salon');
  });

  it('refuses to seal when the salon group is not in hand, rather than using the community one', async () => {
    const { storage } = fakeStorage();
    const { mls, sent } = fakeMls(4);
    // Community group held, salon group not.
    const mlsWithoutSalon = {
      ...(mls as unknown as Record<string, unknown>),
      getLocalGroups: () => ['g-1'],
    } as never;
    wire(storage, mlsWithoutSalon, true);

    await expect(sealChannelMessage(CHANNEL, new Uint8Array([1]))).rejects.toBeInstanceOf(
      GraineDistributionUnavailableError
    );
    expect(sent).toHaveLength(0);
  });
});
