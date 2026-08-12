import { handleSystemEvent } from './systemMessageHandler';
import { digestIdentity } from '$lib/utils/chat/historyDigestRendezvous';
import { historyRequestPendingStore } from '$lib/stores/historyRequestPending.svelte';
import { markAwaitingHistory, isAwaitingHistory } from '$lib/utils/chat/awaitingHistoryRegistry';

/**
 * A `history_bundle` is a GROUP BROADCAST, so every member sees an answer meant for one device.
 *
 * Taking the messages is free - they dedupe by id - but taking the ANSWER is not: it discharges the
 * awaiting-history marker, and a device that never asked has had nothing compared against its store.
 * Before the `to` field, one repair between two peers silenced the solicitation of every other
 * member of the group, permanently: the marker was gone, so no reconnect, sweep or election ever
 * asked again, and whatever was missing here stayed missing.
 */
const ME = 'me';
const MY_DEVICE = 'device-me';
const GROUP = 'g1';

function makeCtx(overrides: Record<string, unknown> = {}) {
  const conversations = new Map<string, any>();
  conversations.set(GROUP, { id: GROUP, unreadCount: 0, messages: [] });
  return {
    mlsService: { getDeviceId: () => MY_DEVICE },
    storage: null,
    userId: ME,
    deviceKeyB64: 'device-key',
    conversations,
    messageReactions: new Map(),
    addMessageToChat: vi.fn(),
    batchAddMessages: vi.fn(),
    deleteConversation: vi.fn(),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    getSelectedContact: () => null,
    setSelectedContact: vi.fn(),
    onReadStateAdvanced: vi.fn(),
    log: vi.fn(),
    convo: conversations.get(GROUP),
    convoKey: GROUP,
    senderNorm: 'peer',
    persistMlsStateNow: vi.fn(),
    ...overrides,
  };
}

/** One message from the peer, in the wire shape a bundle carries. */
const BUNDLE_MSG = { id: 'm1', senderId: 'peer', content: 'hi', timestamp: 1000 };

beforeEach(() => {
  localStorage.clear();
  historyRequestPendingStore.noteReceived(GROUP);
});
afterEach(() => localStorage.clear());

describe('history_bundle addressing', () => {
  it("keeps our marker when the bundle answers ANOTHER device's request", async () => {
    markAwaitingHistory(ME, GROUP, 'no-local-history');
    const ctx = makeCtx();

    await handleSystemEvent(
      'history_bundle',
      { messages: [], to: digestIdentity('someone-else', 'their-device') },
      ctx as any
    );

    expect(isAwaitingHistory(ME, GROUP)).toBe(true);
  });

  it('still INGESTS a bundle addressed elsewhere - the messages are free to take', async () => {
    const ctx = makeCtx();

    await handleSystemEvent(
      'history_bundle',
      { messages: [BUNDLE_MSG], to: digestIdentity('someone-else', 'their-device') },
      ctx as any
    );

    expect(ctx.batchAddMessages).toHaveBeenCalled();
  });

  it('discharges the marker when the bundle is addressed at THIS device', async () => {
    markAwaitingHistory(ME, GROUP, 'no-local-history');
    const ctx = makeCtx();

    await handleSystemEvent(
      'history_bundle',
      { messages: [], to: digestIdentity(ME, MY_DEVICE) },
      ctx as any
    );

    expect(isAwaitingHistory(ME, GROUP)).toBe(false);
  });

  it('matches the addressee case-insensitively, as `digestIdentity` normalises the user half', async () => {
    markAwaitingHistory(ME, GROUP, 'no-local-history');
    const ctx = makeCtx();

    await handleSystemEvent(
      'history_bundle',
      { messages: [], to: digestIdentity(ME, MY_DEVICE).toUpperCase() },
      ctx as any
    );

    expect(isAwaitingHistory(ME, GROUP)).toBe(false);
  });

  it('ignores a bundle addressed at another DEVICE of our own user', async () => {
    // A user with three devices must be able to solicit from one without the other two concluding
    // they are complete on the strength of an answer that diffed a different store.
    markAwaitingHistory(ME, GROUP, 'no-local-history');
    const ctx = makeCtx();

    await handleSystemEvent(
      'history_bundle',
      { messages: [], to: digestIdentity(ME, 'another-device-of-mine') },
      ctx as any
    );

    expect(isAwaitingHistory(ME, GROUP)).toBe(true);
  });

  describe('a legacy bundle, from a peer too old to address one', () => {
    it('is answered only while OUR OWN solicitation is outstanding', async () => {
      markAwaitingHistory(ME, GROUP, 'no-local-history');
      historyRequestPendingStore.start(GROUP);
      const ctx = makeCtx();

      await handleSystemEvent('history_bundle', { messages: [] }, ctx as any);

      expect(isAwaitingHistory(ME, GROUP)).toBe(false);
    });

    it('leaves the marker alone when we asked for nothing - the retry is the cheap failure', async () => {
      markAwaitingHistory(ME, GROUP, 'no-local-history');
      const ctx = makeCtx();

      await handleSystemEvent('history_bundle', { messages: [] }, ctx as any);

      expect(isAwaitingHistory(ME, GROUP)).toBe(true);
    });
  });
});
