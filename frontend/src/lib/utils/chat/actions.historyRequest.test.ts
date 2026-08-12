import type { Conversation } from '$lib/types';
import type { IStorage, StoredMessage } from '$lib/db';
import { createMlsServiceStub } from '$lib/mls-client/test/fixtures/mlsServiceStub';

// Mock only the outbound history senders so each can be asserted, keeping the rest of groupActions
// (persist helpers, `readHistoryEntries`) intact - the diff under test is computed from a REAL store
// read, so stubbing that too would leave nothing being tested.
const { sendFullHistoryBundle, sendHistoryBundleForIds, sendHistoryPull } = vi.hoisted(() => ({
  sendFullHistoryBundle: vi.fn().mockResolvedValue(undefined),
  sendHistoryBundleForIds: vi.fn().mockResolvedValue(undefined),
  sendHistoryPull: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('$lib/utils/chat/groupActions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/utils/chat/groupActions')>();
  return { ...actual, sendFullHistoryBundle, sendHistoryBundleForIds, sendHistoryPull };
});

import { handleHistoryRequest } from './actions';
import { buildHistoryDigest, historyRangeOf, type HistoryEntry } from './historyManifest';
import {
  digestIdentity,
  noteDigestReceived,
  resetHistoryDigestRendezvousForTests,
} from './historyDigestRendezvous';
import { clearAwaitingHistory, markAwaitingHistory } from './awaitingHistoryRegistry';

const GROUP = 'g1';
const SELF_USER = 'u1';
const SELF_DEVICE = 'dev-self';
const REQUESTER_USER = 'u2';
const REQUESTER_DEVICE = 'dev-requester';
const REQUESTER = digestIdentity(REQUESTER_USER, REQUESTER_DEVICE);

function activeConversations(groupId: string): Map<string, Conversation> {
  return new Map([
    [
      groupId,
      {
        id: groupId,
        contactName: groupId,
        name: 'Test',
        messages: [],
        lifecycle: 'active',
        mlsStateHex: null,
      } as Conversation,
    ],
  ]);
}

/**
 * A store holding exactly `entries`, or one that throws when `entries` is the string 'broken'.
 *
 * `historyFloor` is what this device would ask FROM. Setting it above the device window is what
 * makes the window assertions deterministic: the range start is `max(floor, windowStart)`, so a
 * recent floor decides it outright and the test never has to name a wall clock.
 */
function storageWith(entries: HistoryEntry[] | 'broken', historyFloor?: number): IStorage {
  return {
    getMessages: vi.fn().mockImplementation(async () => {
      if (entries === 'broken') throw new Error('store unreadable');
      return entries.map(
        (e) =>
          ({
            id: e.id,
            conversationId: GROUP,
            senderId: 'someone',
            content: 'x',
            timestamp: e.timestamp,
          }) as StoredMessage
      );
    }),
    getConversations: vi
      .fn()
      .mockResolvedValue([
        { id: GROUP, name: 'Test', lifecycle: 'active', updatedAt: 0, historyFloor },
      ]),
  } as unknown as IStorage;
}

const at = (iso: string) => Date.parse(iso);

function baseParams(overrides: Record<string, unknown> = {}) {
  return {
    storage: storageWith([]),
    deviceKeyB64: 'k',
    log: vi.fn(),
    requesterUserId: REQUESTER_USER,
    requesterDeviceId: REQUESTER_DEVICE,
    selfUserId: SELF_USER,
    groupId: GROUP,
    conversations: activeConversations(GROUP),
    mlsService: createMlsServiceStub({
      getLocalGroups: vi.fn().mockReturnValue([GROUP]),
      getDeviceId: vi.fn().mockReturnValue(SELF_DEVICE),
    }),
    // The default case in these tests is a requester that promised a digest; the ones about an
    // older client override it. No digest ever ARRIVES here unless one was posted before the call,
    // so the wait is collapsed to keep the suite fast - it is a bound, never a schedule.
    requesterHasDigest: true,
    digestWaitMs: 1,
    ...overrides,
  } as Parameters<typeof handleHistoryRequest>[0];
}

beforeEach(() => {
  resetHistoryDigestRendezvousForTests();
  clearAwaitingHistory(SELF_USER, GROUP);
  sendFullHistoryBundle.mockClear();
  sendHistoryBundleForIds.mockClear();
  sendHistoryPull.mockClear();
});

describe('handleHistoryRequest - guards', () => {
  it('skips when the group is not held locally (cannot re-encrypt history)', async () => {
    await handleHistoryRequest(
      baseParams({
        mlsService: createMlsServiceStub({ getLocalGroups: vi.fn().mockReturnValue([]) }),
      })
    );
    expect(sendFullHistoryBundle).not.toHaveBeenCalled();
    expect(sendHistoryBundleForIds).not.toHaveBeenCalled();
  });

  it('skips when the conversation is not active locally', async () => {
    await handleHistoryRequest(baseParams({ conversations: new Map() }));
    expect(sendFullHistoryBundle).not.toHaveBeenCalled();
    expect(sendHistoryBundleForIds).not.toHaveBeenCalled();
  });
});

describe('handleHistoryRequest - no digest (a peer on an older build)', () => {
  it('answers a peer that promised nothing IMMEDIATELY, without waiting for anything', async () => {
    // The whole point of `withDigest` on the election frame. With a grace period, this peer paid it
    // on every solicitation it ever made, waiting out a window for a frame it does not know how to
    // send. A wait long enough to be worth measuring here would be a wait it should never do at all.
    const params = baseParams({ requesterHasDigest: false, digestWaitMs: 60_000 });
    const before = Date.now();
    await handleHistoryRequest(params);

    expect(Date.now() - before).toBeLessThan(1_000);
    expect(sendFullHistoryBundle).toHaveBeenCalled();
  });

  it('falls back to the whole store, which is exactly what that peer expects', async () => {
    await handleHistoryRequest(baseParams());
    // `selfUserId` must be OUR id, never the requester's: it decides whether our empty store is
    // authoritative enough to answer "this group has no history".
    expect(sendFullHistoryBundle).toHaveBeenCalledWith(
      GROUP,
      // `to` is the requesting DEVICE: the bundle is a group broadcast, and only the device that
      // asked may read it as an answer to its own wait.
      expect.objectContaining({ selfUserId: SELF_USER, to: REQUESTER })
    );
    expect(sendHistoryBundleForIds).not.toHaveBeenCalled();
  });

  it('ignores a digest sent by a DIFFERENT device of the same user', async () => {
    // The election named one device. Answering another device's snapshot would diff against a store
    // that is not the asker's.
    noteDigestReceived(GROUP, digestIdentity(REQUESTER_USER, 'some-other-device'), {
      mode: 'ids',
      ids: ['a'],
    });
    await handleHistoryRequest(baseParams());
    expect(sendFullHistoryBundle).toHaveBeenCalled();
  });
});

describe('handleHistoryRequest - with a digest', () => {
  /** Posts the requester's digest so the rendezvous can hand it to the call under test. */
  async function postDigest(entries: HistoryEntry[], idModeMax?: number): Promise<void> {
    noteDigestReceived(GROUP, REQUESTER, await buildHistoryDigest(entries, idModeMax));
  }

  it('sends ONLY what the requester lacks, never the whole store', async () => {
    await postDigest([{ id: 'shared', timestamp: at('2026-01-01T00:00:00Z') }]);
    await handleHistoryRequest(
      baseParams({
        storage: storageWith([
          { id: 'shared', timestamp: at('2026-01-01T00:00:00Z') },
          { id: 'only-ours', timestamp: at('2026-01-02T00:00:00Z') },
        ]),
      })
    );

    expect(sendFullHistoryBundle).not.toHaveBeenCalled();
    expect(sendHistoryBundleForIds).toHaveBeenCalledWith(
      GROUP,
      ['only-ours'],
      expect.anything(),
      // Our whole store was compared, so an empty result here really would mean "you are complete".
      // `since: 0` is the requester's own window, restated: this digest stated none.
      { emptyMeans: 'complete', to: REQUESTER, since: 0 }
    );
  });

  it('answers identical stores with an empty selection instead of silence', async () => {
    // Silence and "you are missing nothing" must not be the same signal, or a device that is
    // already up to date keeps the offline banner and re-solicits until the give-up horizon.
    const rows = [{ id: 'same', timestamp: at('2026-01-01T00:00:00Z') }];
    await postDigest(rows);
    await handleHistoryRequest(baseParams({ storage: storageWith(rows) }));

    expect(sendHistoryBundleForIds).toHaveBeenCalledWith(GROUP, [], expect.anything(), {
      emptyMeans: 'complete',
      to: REQUESTER,
      since: 0,
    });
    expect(sendHistoryPull).not.toHaveBeenCalled();
  });

  it('PULLS what the requester has and we do not - one exchange repairs both devices', async () => {
    await postDigest([
      { id: 'theirs', timestamp: at('2026-01-01T00:00:00Z') },
      { id: 'shared', timestamp: at('2026-01-02T00:00:00Z') },
    ]);
    await handleHistoryRequest(
      baseParams({
        storage: storageWith([{ id: 'shared', timestamp: at('2026-01-02T00:00:00Z') }]),
      })
    );

    expect(sendHistoryPull).toHaveBeenCalledWith(
      GROUP,
      expect.objectContaining({
        from: digestIdentity(SELF_USER, SELF_DEVICE),
        to: REQUESTER,
        ids: ['theirs'],
      }),
      expect.anything()
    );
  });

  it('records the gap durably BEFORE pulling, so a lost answer is retried on reconnect', async () => {
    const { isAwaitingHistory } = await import('./awaitingHistoryRegistry');
    await postDigest([{ id: 'theirs', timestamp: at('2026-01-01T00:00:00Z') }]);
    await handleHistoryRequest(baseParams({ storage: storageWith([]) }));

    expect(isAwaitingHistory(SELF_USER, GROUP)).toBe(true);
  });

  it('answers "identical" - never silence - while it is itself awaiting history', async () => {
    // "You are missing nothing" is a claim a device that is itself short is not entitled to make.
    // But SILENCE was worse than a wrong claim: with both peers awaiting and their stores equal,
    // each was the other's only responder and neither answered, so both markers stood for ever and
    // both banners with them (WP-HISTBANNER-1). `identical` says only what was measured - our
    // stores match - which the requester weighs against its OWN evidence.
    markAwaitingHistory(SELF_USER, GROUP, 'unreadable-frames');
    const rows = [{ id: 'same', timestamp: at('2026-01-01T00:00:00Z') }];
    await postDigest(rows);
    await handleHistoryRequest(baseParams({ storage: storageWith(rows) }));

    expect(sendHistoryBundleForIds).toHaveBeenCalledWith(GROUP, [], expect.anything(), {
      emptyMeans: 'identical',
      to: REQUESTER,
      since: 0,
    });
  });

  it('still sends what it holds while awaiting history, since that part is not a claim', async () => {
    markAwaitingHistory(SELF_USER, GROUP, 'unreadable-frames');
    await postDigest([]);
    await handleHistoryRequest(
      baseParams({ storage: storageWith([{ id: 'ours', timestamp: at('2026-01-01T00:00:00Z') }]) })
    );

    expect(sendHistoryBundleForIds).toHaveBeenCalledWith(GROUP, ['ours'], expect.anything(), {
      emptyMeans: 'identical',
      to: REQUESTER,
      since: 0,
    });
  });

  it('stays silent when its own store cannot be read', async () => {
    // A failed read proves nothing about the group. Answering anything would end the requester's
    // solicitation on the strength of a store we could not open.
    await postDigest([{ id: 'theirs', timestamp: at('2026-01-01T00:00:00Z') }]);
    await handleHistoryRequest(baseParams({ storage: storageWith('broken') }));

    expect(sendHistoryBundleForIds).not.toHaveBeenCalled();
    expect(sendFullHistoryBundle).not.toHaveBeenCalled();
    expect(sendHistoryPull).not.toHaveBeenCalled();
  });

  it('resolves a range-mode digest to whole SLICES of the id space, in both directions', async () => {
    // Above the id threshold a digest can only say which slice differs, so the answer over-sends
    // that slice. The receiver dedupes by id, making the cost bandwidth rather than correctness.
    // The three fixture ids land in three distinct depth-1 slices, which is what makes the
    // expectations below exact rather than incidental.
    const sliceOf = (id: string) => historyRangeOf(id, 1);
    expect(new Set(['theirs', 'ours-a', 'ours-b'].map(sliceOf)).size).toBe(3);

    await postDigest([{ id: 'theirs', timestamp: at('2026-01-10T00:00:00Z') }], -1);
    await handleHistoryRequest(
      baseParams({
        storage: storageWith([
          { id: 'ours-a', timestamp: at('2026-01-20T00:00:00Z') },
          { id: 'ours-b', timestamp: at('2026-02-10T00:00:00Z') },
        ]),
      })
    );

    // Both our slices are ours alone, so both are pushed wholesale.
    expect(sendHistoryBundleForIds).toHaveBeenCalledWith(
      GROUP,
      ['ours-a', 'ours-b'],
      expect.anything(),
      { emptyMeans: 'complete', to: REQUESTER, since: 0 }
    );
    // Their slice is theirs alone, so it is pulled - and the DEPTH travels with the prefix, or it
    // names a slice the answering device cannot compute.
    expect(sendHistoryPull).toHaveBeenCalledWith(
      GROUP,
      expect.objectContaining({ prefixes: [sliceOf('theirs')], depth: 1, ids: [] }),
      expect.anything()
    );
  });
});

describe('handleHistoryRequest - whose window bounds what', () => {
  // The rule this fixes in place: on the leg where we ANSWER we honour the requester's window, and
  // on the leg where we ASK we state our own. One handler plays both roles in a single exchange,
  // which is exactly why the two are easy to confuse.

  /** A floor recent enough to sit above any device window, so it alone decides the range start. */
  const OUR_FLOOR = Date.now() - 60_000;
  const THEIR_SINCE = 1_700_000_000_000;

  async function postDigestAsking(entries: HistoryEntry[], since: number): Promise<void> {
    noteDigestReceived(GROUP, REQUESTER, await buildHistoryDigest(entries), since);
  }

  it('bounds the ANSWER by the window the requester stated, not by its own', async () => {
    await postDigestAsking([], THEIR_SINCE);
    await handleHistoryRequest(
      baseParams({
        storage: storageWith([{ id: 'ours', timestamp: at('2026-01-01T00:00:00Z') }], OUR_FLOOR),
      })
    );

    expect(sendHistoryBundleForIds).toHaveBeenCalledWith(GROUP, ['ours'], expect.anything(), {
      emptyMeans: 'complete',
      to: REQUESTER,
      since: THEIR_SINCE,
    });
  });

  it("bounds what it ASKS BACK for by its OWN window, never by the requester's", async () => {
    // A phone diffing against a browser's digest asks back for five years. Reusing the browser's
    // ninety days would cap every device in the conversation at the shortest window in it.
    await postDigestAsking([{ id: 'theirs', timestamp: at('2026-01-01T00:00:00Z') }], THEIR_SINCE);
    await handleHistoryRequest(baseParams({ storage: storageWith([], OUR_FLOOR) }));

    expect(sendHistoryPull).toHaveBeenCalledWith(
      GROUP,
      expect.objectContaining({ ids: ['theirs'], since: OUR_FLOOR }),
      expect.anything()
    );
  });

  it('answers in full when the requester stated no window, rather than inventing one', async () => {
    // A client too old to state a window has not declined anything. Clipping it to a bound we chose
    // for it would withhold messages nobody refused - the failure mode the default guards against.
    await postDigest([]);
    await handleHistoryRequest(
      baseParams({
        storage: storageWith([{ id: 'ours', timestamp: at('2020-01-01T00:00:00Z') }], OUR_FLOOR),
      })
    );

    expect(sendHistoryBundleForIds).toHaveBeenCalledWith(
      GROUP,
      ['ours'],
      expect.anything(),
      expect.objectContaining({ since: 0 })
    );
  });

  /** Posts a digest that states no window, the way a client too old to have one does. */
  async function postDigest(entries: HistoryEntry[]): Promise<void> {
    noteDigestReceived(GROUP, REQUESTER, await buildHistoryDigest(entries));
  }
});
