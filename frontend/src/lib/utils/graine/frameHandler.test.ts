import type { IStorage, StoredGraineSession } from '$lib/db/types';
import { canari } from '$lib/proto/canari';
import {
  decodeAppMessage,
  encodeAppMessage,
  mkGraine,
  mkGraineBundle,
  mkGraineRequest,
  mkText,
} from '$lib/proto/codec';
import { toBase64 } from '$lib/utils/hex';
import { handleDistributionFrame } from './frameHandler';
import { setGraineRepairListener, setGraineRuntime } from './runtime';

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
      workspaceId: 'ws-1',
      groupId: 'g-1',
      sender: 'bob',
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
      deviceKeyB64: 'device-key',
      userId: 'alice',
      mlsService: { sendMessage } as never,
    });
    return sendMessage;
  }

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

  it('names the sessions it was asked for and does not hold, and sends nothing when it holds none', async () => {
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
    // seed lost on this side - both worth naming, neither worth an empty bundle.
    expect(warn.mock.calls.flat().join(' ')).toContain('sess-9');
    expect(sendMessage).not.toHaveBeenCalled();
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

describe('a bundle answering our own request (WP-33)', () => {
  it('stores every seed and tells the UI which salons became readable', async () => {
    const { storage, saved } = fakeStorage();
    wire(storage);
    const repaired: string[][] = [];
    setGraineRepairListener((ids) => repaired.push(ids));

    await handleDistributionFrame({
      workspaceId: 'ws-1',
      groupId: 'g-1',
      sender: 'Bob',
      plaintext: encodeAppMessage(
        mkGraineBundle({
          workspaceId: 'ws-1',
          requestId: 'r-1',
          seeds: [
            { channelId: 'chan-1', sessionId: 's-a', seed: SEED, firstIndex: 0, createdAt: 1 },
            { channelId: 'chan-2', sessionId: 's-b', seed: SEED, firstIndex: 3, createdAt: 1 },
          ],
        })
      ),
    });

    expect(saved.map((s) => s.sessionId)).toEqual(['s-a', 's-b']);
    // Without this the rows stay dropped until the user happens to leave and re-enter the salon.
    expect(repaired).toEqual([['chan-1', 'chan-2']]);
  });

  it('says out loud that a bundle was truncated, because a short list means nothing on its own', async () => {
    const { storage } = fakeStorage();
    wire(storage);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await handleDistributionFrame({
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
});
