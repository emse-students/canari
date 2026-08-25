import type { IStorage, StoredGraineSession } from '$lib/db/types';
import { canari } from '$lib/proto/canari';
import { DELIVERY } from '$lib/mls-client/frameDelivery';
import { workspaceScope } from '$lib/mls-client/distributionScope';
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
import {
  registerCommunityHistoryVisibility,
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

vi.mock('./graineMirror', () => ({ mirrorGraineSeed: vi.fn().mockResolvedValue(undefined) }));

/** Where each session becomes readable for the asker - computed by the server, never here. */
const graineHistoryFloor = vi.fn();
vi.mock('$lib/services/ChannelService', () => ({
  ChannelService: class {
    graineHistoryFloor(...args: unknown[]) {
      return graineHistoryFloor(...args);
    }
  },
}));

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

  it('tells the UI the salon became readable, not only a repair bundle does', async () => {
    const { storage } = fakeStorage();
    wire(storage);
    const repaired: string[][] = [];
    setGraineRepairListener((ids) => repaired.push(ids));

    await handleDistributionFrame(frame());

    // A seed reaches a device by TWO paths - its sender distributing it, and the distribution
    // group's durable log replaying it on reconnect - and only the second races the salon's own
    // history load. Losing that race dropped the rows as unreadable, and while only the bundle path
    // announced, nothing ever went back for them: a device that reconnected into an open salon sat
    // in front of a blank history whose seed it was already holding.
    expect(repaired).toEqual([['chan-1']]);
    setGraineRepairListener(null);
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

  beforeEach(() => {
    // These rows are about WHAT IS HELD, not about who may read the past, so the community shares
    // it. Left unregistered it would fail closed, and every one of them would measure the boundary
    // instead of the thing it is named after.
    registerCommunityHistoryVisibility('ws-1', 'shared');
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

    expect(sendMessage.mock.calls[0][3]).toBe(DELIVERY.keyMaterial);
  });

  it('sends an answer that carries only declines as transport, keeping the capped log for seeds', async () => {
    // The other half of the same rule. A decline restates a fact the requester can derive and holds
    // no key material, so it must not spend a distribution group's log - the argument that makes
    // the seed above durable is the argument that keeps this one transport.
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

    expect(sendMessage.mock.calls[0][3]).toBe(DELIVERY.transport);
    warn.mockRestore();
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
  function historyFrame() {
    return {
      scope: workspaceScope('ws-1'),
      workspaceId: 'ws-1',
      groupId: 'g-1',
      sender: 'newcomer',
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

  function wireWithSessions(sessions: StoredGraineSession[]) {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    setGraineRuntime({
      storage: {
        getGraineSession: async () => null,
        saveGraineSession: async () => undefined,
        getGraineSessionsForWorkspace: async () => sessions,
      } as unknown as IStorage,
      deviceKeyB64: 'device-key',
      userId: 'alice',
      mlsService: { sendMessage } as never,
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
  });

  it('sends nothing when the community is set to joined, and says why', async () => {
    const sendMessage = wireWithSessions(community);
    registerCommunityHistoryVisibility('ws-1', 'joined');
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await handleDistributionFrame(historyFrame());

    // The rule is enforced HERE because here is the only place a seed leaves a device - the server
    // holds no key and could not enforce it.
    expect(sendMessage).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalled();
    info.mockRestore();
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
          seeds: [
            { channelId: 'chan-1', sessionId: 's-a', seed: SEED, firstIndex: 0, createdAt: 1 },
            { channelId: 'chan-2', sessionId: 's-b', seed: SEED, firstIndex: 3, createdAt: 1 },
          ],
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
});
