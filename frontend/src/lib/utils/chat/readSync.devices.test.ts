import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * READ STATE BETWEEN DEVICES, PATH BY PATH (owner, 2026-11-02: "a conversation read on one device
 * still shows as unread on another, possibly until that page reloads").
 *
 * Three devices, each its own conversation store, the way two isolated browser contexts are: `A` and
 * `B` are two devices of the SAME account (`me`), `P` is the other party. `B2` is a second tab of the
 * browser `B` runs in - a FOLLOWER, which opens no socket and learns everything from its leader over
 * the tab channel. Every frame travels through the REAL handlers (`handleSystemEvent`,
 * `handleChannelEvent`) and the REAL tab channel publishers; only the transport between devices is
 * this file's own hand.
 *
 * No wall clock anywhere: every instant is a fixed number, and the server's time of a frame is the
 * `queuedCreatedAt` the test hands in, as the delivery service would.
 *
 * Map of the paths: docs/wiki/frontend/modules/chat.md, "Read state between devices - the census".
 */

let isLeader = false;
vi.mock('$lib/mls-client/tabLeader', () => ({ getIsTabLeader: () => isLeader }));
vi.mock('$lib/stores/typingStore.svelte', () => ({ setTyping: vi.fn() }));
vi.mock('$lib/stores/pinStore.svelte', () => ({ applyPin: vi.fn(), mergePinEntries: vi.fn() }));
vi.mock('$lib/stores/pollStore.svelte', () => ({ setPollMeta: vi.fn() }));
vi.mock('$lib/stores/reactionStore.svelte', () => ({ applyChannelReactionFrame: vi.fn() }));
vi.mock('$lib/utils/graine/channelSeal', () => ({ openChannelMessageProving: vi.fn() }));
vi.mock('$lib/utils/chat/channelCrypto', () => ({ reportUnreadableChannelMessage: vi.fn() }));

const { handleSystemEvent } = await import('$lib/mls-client/messagePipeline/systemMessageHandler');
const { handleChannelEvent } = await import('$lib/mls-client/messagePipeline/channelEventHandler');
const { readMarkTarget, readWatermarkFrameData, readersOf, watermarkFor } =
  await import('./readState');
const { reconcileSalonUnreadFromServer, resetSalonUnread } = await import('./salonUnread');
const { applyTabReadEvent } = await import('./tabReadRelay');
const { publishConversationRead } = await import('$lib/mls-client/tabMessageSync');

/** One device's conversation store - loosely typed, as the handlers' own fixtures are. */
type Device = Map<string, any>;

/** What the tab channel carried, in order: what a follower tab of the same browser receives. */
const tabChannel: any[] = [];

class FakeBroadcastChannel {
  constructor(readonly name: string) {}
  postMessage(data: unknown) {
    tabChannel.push(data);
  }
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

beforeEach(() => {
  tabChannel.length = 0;
  isLeader = false;
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
  resetSalonUnread();
});
afterEach(() => vi.unstubAllGlobals());

/** A message from the peer, dated by the server at `serverAt` (its sentAt a little before). */
const fromPeer = (id: string, serverAt: number) => ({
  id,
  senderId: 'peer',
  content: id,
  isOwn: false,
  isSystem: false,
  timestamp: new Date(serverAt - 5),
  serverTimestamp: serverAt,
});

/** A salon row: its stamp IS the server's `createdAt`. */
const salonRow = (id: string, createdAt: number) => ({
  id,
  senderId: 'peer',
  content: id,
  isOwn: false,
  isSystem: false,
  timestamp: new Date(createdAt),
  serverTimestamp: createdAt,
});

/** A device holding one DM `g1` where the peer wrote two messages it has not read. */
function dmDevice(isOwnDevice: boolean): Device {
  return new Map([
    [
      'g1',
      {
        id: 'g1',
        lifecycle: 'active',
        unreadCount: isOwnDevice ? 2 : 0,
        lastMessageAt: 2000,
        readWatermarks: {},
        serverReadWatermarks: {},
        messages: [fromPeer('m1', 1000), fromPeer('m2', 2000)],
      },
    ],
  ]);
}

/** The pipeline context of one device receiving a frame of `sender` in `g1`. */
function frameCtx(device: Device, me: string, sender: string, queuedCreatedAt: number) {
  return {
    mlsService: { getDeviceId: () => `device-of-${me}` },
    storage: null,
    userId: me,
    deviceKey: () => 'k',
    conversations: device,
    messageReactions: new Map(),
    addMessageToChat: vi.fn(),
    batchAddMessages: vi.fn(),
    deleteConversation: vi.fn(),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    getSelectedContact: () => null,
    setSelectedContact: vi.fn(),
    onReadStateAdvanced: vi.fn(),
    log: vi.fn(),
    convo: device.get('g1'),
    convoKey: 'g1',
    senderNorm: sender,
    persistMlsStateNow: vi.fn(),
    deliveryMeta: { queuedCreatedAt },
  } as any;
}

/** Device A reads the open DM: the mark its receipt effect decides, and the frame it sends. */
function readOnA(a: Device) {
  const convo = a.get('g1')!;
  const target = readMarkTarget(convo.messages, 0, false, 9_999);
  return readWatermarkFrameData(target);
}

describe('a DM read on device A', () => {
  it('clears the badge on device B, live, without a reload', async () => {
    const a = dmDevice(true);
    const b = dmDevice(true);

    const frame = readOnA(a);
    await handleSystemEvent('read_watermark', frame, frameCtx(b, 'me', 'me', 3000));

    expect(b.get('g1')!.unreadCount).toBe(0);
    expect(watermarkFor(b.get('g1')!.serverReadWatermarks, 'me')).toBe(2000);
  });

  it('reaches the other party as a receipt ("Vu")', async () => {
    const a = dmDevice(true);
    const p = dmDevice(false);
    // On the peer's device the two messages are its OWN.
    for (const msg of p.get('g1')!.messages) msg.isOwn = true;

    await handleSystemEvent('read_watermark', readOnA(a), frameCtx(p, 'peer', 'me', 3000));

    const c = p.get('g1')!;
    expect(readersOf(c.messages[1], c.readWatermarks, c.serverReadWatermarks)).toEqual(['me']);
  });

  it('on a device that was offline: a message newer than the read stays counted after the catch-up', async () => {
    const a = dmDevice(true);
    const b = dmDevice(true);
    // B was offline: it receives m3 (written after A read) in the same catch-up as A's mark.
    b.get('g1')!.messages.push(fromPeer('m3', 4000));
    b.get('g1')!.unreadCount = 3;

    await handleSystemEvent('read_watermark', readOnA(a), frameCtx(b, 'me', 'me', 3000));

    expect(b.get('g1')!.unreadCount).toBe(1);
  });

  it('reaches a FOLLOWER tab of device B, which opens no socket of its own', async () => {
    const a = dmDevice(true);
    const bLeader = dmDevice(true);
    const bFollower = dmDevice(true);

    isLeader = true;
    await handleSystemEvent('read_watermark', readOnA(a), frameCtx(bLeader, 'me', 'me', 3000));
    isLeader = false;
    for (const event of tabChannel) applyTabReadEvent(bFollower, event, 'me', () => false);

    expect(bFollower.get('g1')!.unreadCount).toBe(0);
    expect(watermarkFor(bFollower.get('g1')!.serverReadWatermarks, 'me')).toBe(2000);
  });

  it("reaches a follower tab of the PEER's browser as a receipt", async () => {
    const a = dmDevice(true);
    const pLeader = dmDevice(false);
    const pFollower = dmDevice(false);

    isLeader = true;
    await handleSystemEvent('read_watermark', readOnA(a), frameCtx(pLeader, 'peer', 'me', 3000));
    isLeader = false;
    for (const event of tabChannel) applyTabReadEvent(pFollower, event, 'peer', () => false);

    const c = pFollower.get('g1')!;
    expect(readersOf(c.messages[1], c.readWatermarks, c.serverReadWatermarks)).toEqual(['me']);
  });
});

describe('a conversation read in one TAB of a browser', () => {
  it('moves the other tab’s watermark with its badge, so the list and the open thread agree', () => {
    const reading = dmDevice(true);
    const other = dmDevice(true);

    // The reading tab's optimistic mark, announced with the mark it took.
    publishConversationRead('g1', reading.get('g1')!.lastMessageAt, { at: 2000, clock: 'server' });
    for (const event of tabChannel) applyTabReadEvent(other, event, 'me', () => false);

    const c = other.get('g1')!;
    expect(c.unreadCount).toBe(0);
    // The thread's own unread rows (the divider, the scroll button) read this map.
    expect(watermarkFor(c.serverReadWatermarks, 'me')).toBe(2000);
  });

  it('a SELECTION (no mark) still zeroes the badge, and only when nothing newer arrived', () => {
    const other = dmDevice(true);
    publishConversationRead('g1', 1500);
    for (const event of tabChannel) applyTabReadEvent(other, event, 'me', () => false);
    expect(other.get('g1')!.unreadCount).toBe(2);

    tabChannel.length = 0;
    publishConversationRead('g1', 2000);
    for (const event of tabChannel) applyTabReadEvent(other, event, 'me', () => false);
    expect(other.get('g1')!.unreadCount).toBe(0);
  });
});

/** A device holding one salon `channel_s1` the server counted three unread messages in. */
function salonDevice(held: Array<ReturnType<typeof salonRow>>): Device {
  return new Map([
    [
      'channel_s1',
      {
        id: 'channel_s1',
        lifecycle: 'active',
        unreadCount: 3,
        readWatermarks: {},
        messages: held,
      },
    ],
  ]);
}

const channelCtx = (device: Device, me: string) =>
  ({ conversations: device, userId: me, addMessageToChat: vi.fn(), log: vi.fn() }) as any;
const channelRead = (userId: string, at: number) => ({
  type: 'channel.read',
  data: { channelId: 's1', workspaceId: 'w', userId, at },
});

describe('a salon read on device A', () => {
  it('clears the badge on device B live, whether or not B holds the messages', async () => {
    const holding = salonDevice([salonRow('r1', 1000), salonRow('r2', 2000), salonRow('r3', 3000)]);
    const empty = salonDevice([]);

    await handleChannelEvent(channelRead('me', 3000), channelCtx(holding, 'me'));
    await handleChannelEvent(channelRead('me', 3000), channelCtx(empty, 'me'));

    expect(holding.get('channel_s1')!.unreadCount).toBe(0);
    expect(empty.get('channel_s1')!.unreadCount).toBe(0);
  });

  it('reaches a follower tab of device B', async () => {
    const leader = salonDevice([salonRow('r1', 1000)]);
    const follower = salonDevice([salonRow('r1', 1000)]);

    isLeader = true;
    await handleChannelEvent(channelRead('me', 1000), channelCtx(leader, 'me'));
    isLeader = false;
    for (const event of tabChannel) applyTabReadEvent(follower, event, 'me', () => false);

    expect(follower.get('channel_s1')!.unreadCount).toBe(0);
  });

  it('when B was offline, B takes the server count on reconnect - even for the salon it has SELECTED but is not reading', async () => {
    // B kept the salon selected and went to another page (or hid the tab, or the phone slept).
    // A read it meanwhile; the server now counts 0. The receipt effect is not running for a salon
    // nobody is looking at, so nothing else will ever correct this badge.
    const b = salonDevice([salonRow('r1', 1000)]);
    const { conversationBeingRead } = await import('./arrivalRuntime');

    await reconcileSalonUnreadFromServer({
      conversations: b,
      selectedId: conversationBeingRead('channel_s1'),
      userId: 'me',
      fetchCounts: async () => ({ asOf: 5000, counts: {} }),
      log: vi.fn(),
      reason: 'live stream back',
    });

    expect(b.get('channel_s1')!.unreadCount).toBe(0);
  });

  it('the counts a leader re-reads reach its follower tabs', async () => {
    const leader = salonDevice([]);
    const follower = salonDevice([]);

    isLeader = true;
    await reconcileSalonUnreadFromServer({
      conversations: leader,
      selectedId: null,
      userId: 'me',
      fetchCounts: async () => ({ asOf: 5000, counts: {} }),
      log: vi.fn(),
      reason: 'community cleared on a device',
    });
    isLeader = false;
    for (const event of tabChannel) applyTabReadEvent(follower, event, 'me', () => false);

    expect(follower.get('channel_s1')!.unreadCount).toBe(0);
  });

  it('a follower reading the salon keeps its own count: the counts do not reach the open one', async () => {
    const leader = salonDevice([]);
    const follower = salonDevice([]);
    follower.get('channel_s1')!.unreadCount = 0;

    isLeader = true;
    await reconcileSalonUnreadFromServer({
      conversations: leader,
      selectedId: null,
      userId: 'me',
      fetchCounts: async () => ({ asOf: 5000, counts: { s1: 4 } }),
      log: vi.fn(),
      reason: 'live stream back',
    });
    isLeader = false;
    for (const event of tabChannel) {
      applyTabReadEvent(follower, event, 'me', (key) => key === 'channel_s1');
    }

    expect(leader.get('channel_s1')!.unreadCount).toBe(4);
    expect(follower.get('channel_s1')!.unreadCount).toBe(0);
  });
});

describe('who owns the count of the selected salon', () => {
  it('both callers of the server count hand it the salon being READ, never the bare selection', async () => {
    const { readFileSync } = await import('node:fs');
    for (const file of [
      'src/lib/composables/useConversations.svelte.ts',
      'src/lib/composables/useChannelWorkspaces.svelte.ts',
    ]) {
      const source = readFileSync(file, 'utf8');
      const call = source.indexOf('reconcileSalonUnreadFromServer({');
      expect(call, file).toBeGreaterThan(0);
      const args = source.slice(call, source.indexOf('});', call));
      expect(args, file).toMatch(/selectedId: conversationBeingRead\(/);
    }
  });
});
