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
import { buildHistoryDigest, type HistoryEntry } from './historyManifest';
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

/** A store holding exactly `entries`, or one that throws when `entries` is the string 'broken'. */
function storageWith(entries: HistoryEntry[] | 'broken'): IStorage {
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
    // No digest is ever going to arrive in these tests unless one was posted before the call, so
    // the grace window is collapsed to keep the suite fast.
    digestGraceMs: 1,
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
  it('falls back to the whole store, which is exactly what that peer expects', async () => {
    await handleHistoryRequest(baseParams());
    // `selfUserId` must be OUR id, never the requester's: it decides whether our empty store is
    // authoritative enough to answer "this group has no history".
    expect(sendFullHistoryBundle).toHaveBeenCalledWith(
      GROUP,
      expect.objectContaining({ selfUserId: SELF_USER })
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
      { announceComplete: true }
    );
  });

  it('answers identical stores with an empty selection instead of silence', async () => {
    // Silence and "you are missing nothing" must not be the same signal, or a device that is
    // already up to date keeps the offline banner and re-solicits until the give-up horizon.
    const rows = [{ id: 'same', timestamp: at('2026-01-01T00:00:00Z') }];
    await postDigest(rows);
    await handleHistoryRequest(baseParams({ storage: storageWith(rows) }));

    expect(sendHistoryBundleForIds).toHaveBeenCalledWith(GROUP, [], expect.anything(), {
      announceComplete: true,
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

  it('stays silent about completeness while it is itself awaiting history', async () => {
    // "You are missing nothing" is a claim a device that is itself short is not entitled to make:
    // it would clear the requester's marker for good, and a third member may hold what it wants.
    markAwaitingHistory(SELF_USER, GROUP, 'unreadable-frames');
    const rows = [{ id: 'same', timestamp: at('2026-01-01T00:00:00Z') }];
    await postDigest(rows);
    await handleHistoryRequest(baseParams({ storage: storageWith(rows) }));

    expect(sendHistoryBundleForIds).not.toHaveBeenCalled();
  });

  it('still sends what it holds while awaiting history, since that part is not a claim', async () => {
    markAwaitingHistory(SELF_USER, GROUP, 'unreadable-frames');
    await postDigest([]);
    await handleHistoryRequest(
      baseParams({ storage: storageWith([{ id: 'ours', timestamp: at('2026-01-01T00:00:00Z') }]) })
    );

    expect(sendHistoryBundleForIds).toHaveBeenCalledWith(GROUP, ['ours'], expect.anything(), {
      announceComplete: true,
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

  it('resolves a bucket-mode digest to whole MONTHS, in both directions', async () => {
    // Above the id threshold a digest can only say which month differs, so the answer over-sends
    // that month. The receiver dedupes by id, making the cost bandwidth rather than correctness.
    await postDigest([{ id: 'theirs-jan', timestamp: at('2026-01-10T00:00:00Z') }], -1);
    await handleHistoryRequest(
      baseParams({
        storage: storageWith([
          { id: 'ours-jan', timestamp: at('2026-01-20T00:00:00Z') },
          { id: 'ours-feb', timestamp: at('2026-02-10T00:00:00Z') },
        ]),
      })
    );

    // January differs (different ids) and February is ours alone: both are pushed wholesale.
    expect(sendHistoryBundleForIds).toHaveBeenCalledWith(
      GROUP,
      ['ours-feb', 'ours-jan'],
      expect.anything(),
      { announceComplete: true }
    );
    // January differs, so it is also pulled - a fingerprint cannot say which side is short.
    expect(sendHistoryPull).toHaveBeenCalledWith(
      GROUP,
      expect.objectContaining({ months: ['2026-01'], ids: [] }),
      expect.anything()
    );
  });
});
