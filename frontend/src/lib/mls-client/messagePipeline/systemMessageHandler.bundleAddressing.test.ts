import { handleSystemEvent } from './systemMessageHandler';
import { digestIdentity } from '$lib/utils/chat/historyDigestRendezvous';

/**
 * A `history_bundle` is a GROUP BROADCAST, so every member sees an answer meant for one device.
 *
 * Deciding what to do with somebody else's answer used to be delicate: a bundle DISCHARGED the
 * receiver's durable awaiting-history marker, so reading one addressed elsewhere stopped this
 * device's own solicitation on another device's evidence - permanently, since nothing re-armed it.
 * That is why `to` exists.
 *
 * There is no marker any more, and these cases pin what replaced the rule rather than the rule: the
 * messages are taken whoever they were for, because taking them is free and the comparison that
 * decides whether anything is still missing runs again on the next connection.
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

describe('history_bundle addressing', () => {
  it('ingests a bundle addressed at THIS device', async () => {
    const ctx = makeCtx();

    await handleSystemEvent(
      'history_bundle',
      { messages: [BUNDLE_MSG], to: digestIdentity(ME, MY_DEVICE) },
      ctx as any
    );

    expect(ctx.batchAddMessages).toHaveBeenCalled();
  });

  it("ingests a bundle answering ANOTHER device's request - the messages are free to take", async () => {
    const ctx = makeCtx();

    await handleSystemEvent(
      'history_bundle',
      { messages: [BUNDLE_MSG], to: digestIdentity('someone-else', 'their-device') },
      ctx as any
    );

    expect(ctx.batchAddMessages).toHaveBeenCalled();
  });

  it('ingests a bundle addressed at another DEVICE of our own user', async () => {
    const ctx = makeCtx();

    await handleSystemEvent(
      'history_bundle',
      { messages: [BUNDLE_MSG], to: digestIdentity(ME, 'another-device-of-mine') },
      ctx as any
    );

    expect(ctx.batchAddMessages).toHaveBeenCalled();
  });

  it('ingests a bundle that names no addressee at all', async () => {
    const ctx = makeCtx();

    await handleSystemEvent('history_bundle', { messages: [BUNDLE_MSG] }, ctx as any);

    expect(ctx.batchAddMessages).toHaveBeenCalled();
  });

  it('merges the conversation state carried by a bundle meant for somebody else', async () => {
    // Read watermarks and the floor are `max` merges and cost nothing to repeat, so an answer
    // passing by is as good a carrier as one addressed here.
    const ctx = makeCtx();

    await handleSystemEvent(
      'history_bundle',
      {
        messages: [],
        to: digestIdentity('someone-else', 'their-device'),
        readWatermarks: { peer: 5000 },
      },
      ctx as any
    );

    expect(ctx.conversations.get(GROUP).readWatermarks).toEqual({ peer: 5000 });
  });
});
