import { handleSystemEvent } from './systemMessageHandler';

/**
 * Read state on the LIVE path: the `read_watermark` frame, the legacy `read_receipt` shape it
 * replaces, and the read state a `history_bundle` carries.
 *
 * Every message here has a real timestamp, and that is load-bearing rather than decorative: a
 * watermark is compared against the message's own instant, so a fixture without one would make
 * every assertion below pass by comparing against `NaN`.
 */

/** Builds a minimal context. */
function makeCtx(overrides: Record<string, unknown> = {}) {
  const conversations = new Map<string, any>();
  conversations.set('g1', {
    id: 'g1',
    unreadCount: 3,
    readWatermarks: {},
    messages: [{ id: 'm1', senderId: 'peer', timestamp: new Date(1000) }],
  });
  return {
    // `getDeviceId` is what an addressed `history_bundle` is matched against - a bundle with no `to`
    // never reaches it, which is exactly what the legacy frames below exercise.
    mlsService: { getDeviceId: () => 'device-me' },
    storage: null,
    userId: 'me',
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
    convo: {},
    convoKey: 'g1',
    senderNorm: 'me',
    persistMlsStateNow: vi.fn(),
    ...overrides,
  };
}

const watermarks = (ctx: ReturnType<typeof makeCtx>) =>
  (ctx.conversations.get('g1') as any).readWatermarks;

describe('handleSystemEvent - read_watermark', () => {
  it('reads by ourselves on another device clear the badge, and are persisted', async () => {
    const ctx = makeCtx({ senderNorm: 'me', userId: 'me' });

    await handleSystemEvent('read_watermark', { at: 1000 }, ctx as any);

    expect((ctx.conversations.get('g1') as any).unreadCount).toBe(0);
    expect(watermarks(ctx)).toEqual({ me: 1000 });
    expect(ctx.saveConversation).toHaveBeenCalledWith('g1');
  });

  it("records a peer's read state without touching our own badge", async () => {
    const ctx = makeCtx({ senderNorm: 'peer', userId: 'me' });

    await handleSystemEvent('read_watermark', { at: 1000 }, ctx as any);

    expect((ctx.conversations.get('g1') as any).unreadCount).toBe(3);
    expect(watermarks(ctx)).toEqual({ peer: 1000 });
    // The read state lives on the conversation row, so a peer's watermark is persisted too - the
    // whole point being that it survives a reload without asking anyone again.
    expect(ctx.saveConversation).toHaveBeenCalledWith('g1');
    expect(ctx.onReadStateAdvanced).toHaveBeenCalledWith(
      expect.objectContaining({ senderId: 'peer', at: 1000 })
    );
  });

  it('ignores a watermark that is behind what we already hold', async () => {
    const conversations = new Map<string, any>();
    conversations.set('g1', {
      id: 'g1',
      unreadCount: 3,
      readWatermarks: { peer: 5000 },
      messages: [{ id: 'm1', senderId: 'peer', timestamp: new Date(1000) }],
    });
    const ctx = makeCtx({ conversations, senderNorm: 'peer', userId: 'me' });

    await handleSystemEvent('read_watermark', { at: 1000 }, ctx as any);

    expect(watermarks(ctx)).toEqual({ peer: 5000 });
    expect(ctx.onReadStateAdvanced).not.toHaveBeenCalled();
  });

  it('translates the legacy read_receipt shape using the messages we hold', async () => {
    // Ids instead of an instant. The instant is recovered from the message itself, which is the
    // only reading of that frame that can be compared against anything.
    const ctx = makeCtx({ senderNorm: 'peer', userId: 'me' });

    await handleSystemEvent('read_receipt', { messageIds: ['m1'] }, ctx as any);

    expect(watermarks(ctx)).toEqual({ peer: 1000 });
  });

  it('takes nothing from a legacy receipt naming messages we do not hold', async () => {
    const ctx = makeCtx({ senderNorm: 'peer', userId: 'me' });

    await handleSystemEvent('read_receipt', { messageIds: ['unknown'] }, ctx as any);

    expect(watermarks(ctx)).toEqual({});
  });
});

describe('handleSystemEvent - history_bundle read state', () => {
  function seed(unreadCount: number, messages: Array<Record<string, unknown>>) {
    const conversations = new Map<string, any>();
    conversations.set('g1', { id: 'g1', unreadCount, readWatermarks: {}, messages });
    return makeCtx({ conversations, convo: conversations.get('g1'), userId: 'me' });
  }

  const peerMsg = (id: string, at: number) => ({
    id,
    senderId: 'peer',
    content: id,
    isOwn: false,
    timestamp: new Date(at),
  });

  it('merges the read state a bundle carries, normalising the user ids', async () => {
    const ctx = seed(0, [peerMsg('m1', 1000)]);

    await handleSystemEvent(
      'history_bundle',
      { messages: [], readWatermarks: { PEER: 4000 } },
      ctx as any
    );

    expect(watermarks(ctx)).toEqual({ peer: 4000 });
  });

  it('takes the read state of a bundle carrying no messages at all', async () => {
    // "You are missing nothing, and here is who has read what" is an ordinary answer.
    const ctx = seed(0, [peerMsg('m1', 1000)]);

    await handleSystemEvent('history_bundle', { readWatermarks: { peer: 4000 } }, ctx as any);

    expect(watermarks(ctx)).toEqual({ peer: 4000 });
  });

  it('clears the badge for messages this user already read on another device', async () => {
    const ctx = seed(3, [peerMsg('m1', 1000), peerMsg('m2', 2000), peerMsg('m3', 3000)]);

    await handleSystemEvent(
      'history_bundle',
      {
        // Our own watermark comes back: another of our devices read up to m2.
        messages: [
          { id: 'm1', senderId: 'peer', content: 'm1', timestamp: 1000 },
          { id: 'm2', senderId: 'peer', content: 'm2', timestamp: 2000 },
          { id: 'm3', senderId: 'peer', content: 'm3', timestamp: 3000 },
        ],
        readWatermarks: { me: 2000 },
      },
      ctx as any
    );

    expect((ctx.conversations.get('g1') as any).unreadCount).toBe(1);
  });

  it('keeps the full count for a genuine new member, whose watermark is 0', async () => {
    const ctx = seed(2, [peerMsg('m1', 1000), peerMsg('m2', 2000)]);

    await handleSystemEvent(
      'history_bundle',
      {
        // Somebody else read them; this device never did.
        messages: [
          { id: 'm1', senderId: 'peer', content: 'm1', timestamp: 1000 },
          { id: 'm2', senderId: 'peer', content: 'm2', timestamp: 2000 },
        ],
        readWatermarks: { other: 9000 },
      },
      ctx as any
    );

    expect((ctx.conversations.get('g1') as any).unreadCount).toBe(2);
  });

  it('never raises the badge of a conversation the add-path already zeroed', async () => {
    // unreadCount 0 = the conversation was open while the bundle landed.
    const ctx = seed(0, [peerMsg('m1', 1000), peerMsg('m2', 2000)]);

    await handleSystemEvent(
      'history_bundle',
      {
        messages: [
          { id: 'm1', senderId: 'peer', content: 'm1', timestamp: 1000 },
          { id: 'm2', senderId: 'peer', content: 'm2', timestamp: 2000 },
        ],
      },
      ctx as any
    );

    expect((ctx.conversations.get('g1') as any).unreadCount).toBe(0);
  });
});
