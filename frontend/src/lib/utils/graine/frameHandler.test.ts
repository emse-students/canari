import type { IStorage, StoredGraineSession } from '$lib/db/types';
import { encodeAppMessage, mkGraine, mkGraineRequest } from '$lib/proto/codec';
import { toBase64 } from '$lib/utils/hex';
import { handleDistributionFrame } from './frameHandler';
import { setGraineRuntime } from './runtime';

/**
 * What arriving on a community's distribution group DOES (WP-32, inbound half).
 *
 * The rule worth a test is the one nothing else would ever complain about: a seed frame is DURABLE,
 * so this device meets its own seed again on every fresh start, and writing it back would drop the
 * `sentCount` that decides the next message index and the 100-message rotation.
 */

vi.mock('./graineMirror', () => ({ mirrorGraineSeed: vi.fn().mockResolvedValue(undefined) }));

const SEED = new Uint8Array(32).fill(3);

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
    deviceKeyB64: 'device-key',
    userId: 'alice',
    mlsService: {} as never,
  });
}

afterEach(() => setGraineRuntime(null));

describe('a seed arriving on the distribution group', () => {
  it('is stored under its SENDER, lower-cased, with no counters of ours', async () => {
    const { storage, saved } = fakeStorage();
    wire(storage);

    await handleDistributionFrame(frame());

    expect(saved[0]).toMatchObject({
      workspaceId: 'ws-1',
      channelId: 'chan-1',
      sessionId: 'sess-1',
      senderId: 'bob',
      firstIndex: 0,
    });
    // Neither is ours to invent: `sentCount` is what marks a session as THIS device's outbound
    // one, and the roster it was minted under is a judgement only its sender may make.
    expect(saved[0].sentCount).toBeUndefined();
    expect(saved[0].distributionEpoch).toBeUndefined();
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
      workspaceId: 'ws-1',
      groupId: 'g-1',
      sender: 'bob',
      plaintext: encodeAppMessage(mkGraineRequest({ workspaceId: 'ws-1', requestId: 'r-1' })),
    });

    // A peer speaking a protocol this bundle does not answer is a version skew worth naming; the
    // alternative reads exactly like nothing having arrived.
    expect(saved).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
