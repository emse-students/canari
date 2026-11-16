// @vitest-environment happy-dom
/**
 * A SALON PAGE IS DECODED AFTER ITS KEY GROUP'S DRAIN (1.6.11 logs, 2026-11-14). A salon opened on a
 * cold start fetched and decoded its page while the key group's pending queue - the frames carrying
 * the seeds its members minted meanwhile - was still being drained: its rows read `missing seed`,
 * were warned and asked for, and were drawn only by the re-read the drain's end announced. These
 * pin the order: the page is fetched at once, decoded only once the drain proof resolves, and then
 * every row reads with the seed the drain brought - no warning, nothing dropped.
 */
import { SvelteMap } from 'svelte/reactivity';
import type { Conversation } from '$lib/types';
import { flushMacrotask } from '../../test/flush';

const listMessages = vi.hoisted(() => vi.fn());
const listReadMarks = vi.hoisted(() => vi.fn());
vi.mock('$lib/services/ChannelService', () => ({
  channelService: { listMessages, listReadMarks },
}));

/** The device's seed store as the drain fills it, and what a row read without its seed says. */
const seeds = vi.hoisted(() => ({ held: false, missingSeedWarned: vi.fn() }));

vi.mock('$lib/utils/chat/channelCrypto', () => ({
  isChannelConversationId: (id: string) => id.startsWith('channel_'),
  decodeChannelMessagePage: vi.fn(async (_raw: string, rows: readonly { id: string }[]) =>
    rows.map((row) => {
      if (!seeds.held) {
        // What `reportUnreadableChannelMessage` says for a `GraineSessionUnavailableError`.
        seeds.missingSeedWarned(row.id);
        return null;
      }
      return {
        kind: 'message',
        message: {
          id: row.id,
          senderId: 'peer',
          content: 'hi',
          timestamp: new Date(1_000),
          isOwn: false,
          isSystem: false,
        },
      };
    })
  ),
  UnreadableRowTally: class {
    report() {}
    rowsOf() {
      return [];
    }
  },
  V1_SESSION_NOT_HELD: 'v1 session not held',
}));

/** The key group's drain, settled by hand: the event `whenGroupDrained` stands for. */
const drain = vi.hoisted(() => ({
  settle: null as null | (() => void),
  whenSalonKeysDrained: vi.fn(),
}));
vi.mock('$lib/utils/graine/salonReadGate', () => ({
  whenSalonKeysDrained: drain.whenSalonKeysDrained,
}));

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: {},
  globalNotifs: {},
  appendLog: vi.fn(),
}));

const { useConversations } = await import('./useConversations.svelte');

const SALON = 'channel_7d2f0aa0-0000-4000-8000-000000000001';

function makeCtx() {
  return {
    storage: null,
    ensureMls: () => ({}),
    userId: 'u1',
    deviceKeyB64: 'k',
    historyBaseUrl: '',
    messageReactions: new SvelteMap(),
    log: vi.fn(),
    addMessageToChat: vi.fn(),
  } as never;
}

beforeEach(async () => {
  vi.clearAllMocks();
  seeds.held = false;
  drain.settle = null;
  drain.whenSalonKeysDrained.mockImplementation(
    () =>
      new Promise((resolve) => {
        drain.settle = () => {
          // The drain applies the key group's frames - the seeds land - and only then is it proven.
          seeds.held = true;
          resolve({ kind: 'drained', groupId: 'kg-0001', waited: true });
        };
      })
  );
  listMessages.mockResolvedValue([{ id: 'm1' }, { id: 'm2' }]);
  listReadMarks.mockResolvedValue([]);
  const gate = await import('$lib/utils/graine/salonSendGate');
  gate.resetSalonSendGate();
});

describe('a salon opened while its key group is draining', () => {
  it('fetches the page at once but decodes it only after the drain, so no row reads "missing seed"', async () => {
    const convs = useConversations();
    convs.conversations.set(SALON, {
      id: SALON,
      name: SALON,
      messages: [],
    } as unknown as Conversation);
    const { decodeChannelMessagePage } = await import('$lib/utils/chat/channelCrypto');

    const loading = convs.loadHistoryForConversation(SALON, SALON, makeCtx());
    await vi.waitFor(() => expect(listMessages).toHaveBeenCalledTimes(1));
    await flushMacrotask();
    // Fetched, not decoded: the seeds of these rows are still in the key group's queue.
    expect(decodeChannelMessagePage).not.toHaveBeenCalled();
    expect(drain.whenSalonKeysDrained).toHaveBeenCalledWith('7d2f0aa0-0000-4000-8000-000000000001');

    drain.settle?.();
    await loading;

    expect(seeds.missingSeedWarned).not.toHaveBeenCalled();
    expect(decodeChannelMessagePage).toHaveBeenCalledTimes(1);
    // Read once, whole: nothing dropped by the order, and no second fetch to heal it.
    expect(convs.conversations.get(SALON)?.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(listMessages).toHaveBeenCalledTimes(1);
  });

  it('a drain already proven costs the read nothing', async () => {
    seeds.held = true;
    drain.whenSalonKeysDrained.mockResolvedValue({
      kind: 'drained',
      groupId: 'kg-0001',
      waited: false,
    });
    const convs = useConversations();
    convs.conversations.set(SALON, {
      id: SALON,
      name: SALON,
      messages: [],
    } as unknown as Conversation);
    await convs.loadHistoryForConversation(SALON, SALON, makeCtx());
    expect(seeds.missingSeedWarned).not.toHaveBeenCalled();
    expect(convs.conversations.get(SALON)?.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
  });
});
