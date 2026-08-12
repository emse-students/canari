import { sendFullHistoryBundle } from './groupActions';
import { markAwaitingHistory } from './awaitingHistoryRegistry';
import { createMlsServiceStub } from '$lib/mls-client/test/fixtures/mlsServiceStub';
import { decodeAppMessage } from '$lib/proto/codec';
import type { IStorage, StoredMessage } from '$lib/db';

const SELF = 'user-a';
const GROUP = 'g1';
/** The device that asked - every bundle is addressed at one, never at the group at large. */
const REQUESTER = 'user-b:device-b';

function storageWith(messages: StoredMessage[] | Error): IStorage {
  return {
    getMessages: vi
      .fn()
      .mockImplementation(() =>
        messages instanceof Error ? Promise.reject(messages) : Promise.resolve(messages)
      ),
  } as unknown as IStorage;
}

function storedMessage(id: string): StoredMessage {
  return {
    id,
    senderId: 'user-b',
    content: 'hello',
    timestamp: 1_700_000_000_000,
  } as StoredMessage;
}

/** Decodes the `history_bundle` payload of the single message the stub was asked to send. */
function sentBundle(mlsService: ReturnType<typeof createMlsServiceStub>) {
  const bytes = vi.mocked(mlsService.sendMessage).mock.calls[0][1] as Uint8Array;
  const decoded = decodeAppMessage(bytes);
  return {
    event: decoded?.system?.event,
    data: JSON.parse(decoded?.system?.data || '{}') as { messages: unknown[]; to?: string },
  };
}

describe('sendFullHistoryBundle', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('answers an empty group with an empty bundle, so the requester stops waiting', async () => {
    // Silence used to mean both "no history" and "nobody answered", which left a brand-new
    // conversation in pending-offline and re-soliciting on every reconnect for 30 days.
    const mlsService = createMlsServiceStub();
    await sendFullHistoryBundle(GROUP, {
      storage: storageWith([]),
      deviceKeyB64: 'k',
      mlsService,
      log: vi.fn(),
      selfUserId: SELF,
      to: REQUESTER,
    });

    expect(mlsService.sendMessage).toHaveBeenCalledTimes(1);
    const { event, data } = sentBundle(mlsService);
    expect(event).toBe('history_bundle');
    expect(data.messages).toEqual([]);
    // The empty bundle is the one that DISCHARGES a marker, so it is the one that most needs an
    // addressee: unaddressed, it tells every other member of the group to stop waiting too.
    expect(data.to).toBe(REQUESTER);
  });

  it('stays silent when empty AND still awaiting history itself (emptiness proves nothing)', async () => {
    // A device that just joined has an empty store for a group that may hold years of history:
    // answering "empty" here would wrongly close the requester's loop.
    markAwaitingHistory(SELF, GROUP, 'unreadable-frames');
    const mlsService = createMlsServiceStub();
    await sendFullHistoryBundle(GROUP, {
      storage: storageWith([]),
      deviceKeyB64: 'k',
      mlsService,
      log: vi.fn(),
      selfUserId: SELF,
      to: REQUESTER,
    });

    expect(mlsService.sendMessage).not.toHaveBeenCalled();
  });

  it('stays silent when the local read fails - a failed read proves nothing either', async () => {
    const mlsService = createMlsServiceStub();
    await sendFullHistoryBundle(GROUP, {
      storage: storageWith(new Error('sqlite locked')),
      deviceKeyB64: 'k',
      mlsService,
      log: vi.fn(),
      selfUserId: SELF,
      to: REQUESTER,
    });

    expect(mlsService.sendMessage).not.toHaveBeenCalled();
  });

  it('still sends the real history when there is some, awaiting marker or not', async () => {
    markAwaitingHistory(SELF, GROUP, 'unreadable-frames');
    const mlsService = createMlsServiceStub();
    await sendFullHistoryBundle(GROUP, {
      storage: storageWith([storedMessage('m1'), storedMessage('m2')]),
      deviceKeyB64: 'k',
      mlsService,
      log: vi.fn(),
      selfUserId: SELF,
      to: REQUESTER,
    });

    expect(mlsService.sendMessage).toHaveBeenCalledTimes(1);
    const { event, data } = sentBundle(mlsService);
    expect(event).toBe('history_bundle');
    expect(data.messages).toHaveLength(2);
    expect(data.to).toBe(REQUESTER);
  });

  it('carries the edit time with the edit flag, and every reaction including the withdrawn ones', async () => {
    // Two things a device restored from a bundle has NO other source for. `isEdited` without
    // `editedAt` showed "edited" with no time for ever, since the sender's own edit is never
    // echoed back over MLS (D4). And a reaction taken back is an entry carrying its removal time -
    // dropping it from the bundle would hand the receiver back the placement it had removed (D3).
    const mlsService = createMlsServiceStub();
    const edited = {
      ...storedMessage('m1'),
      isEdited: true,
      editedAt: 1_700_000_042_000,
      reactions: [
        { emoji: '👍', userId: 'user-b', at: 10, removed: true },
        { emoji: '🎉', userId: 'user-c', at: 20 },
      ],
    } as StoredMessage;

    await sendFullHistoryBundle(GROUP, {
      storage: storageWith([edited]),
      deviceKeyB64: 'k',
      mlsService,
      log: vi.fn(),
      selfUserId: SELF,
      to: REQUESTER,
    });

    const { data } = sentBundle(mlsService);
    expect(data.messages[0]).toMatchObject({
      isEdited: true,
      editedAt: 1_700_000_042_000,
      reactions: [
        { emoji: '👍', userId: 'user-b', at: 10, removed: true },
        { emoji: '🎉', userId: 'user-c', at: 20 },
      ],
    });
  });
});
