// @vitest-environment happy-dom
/**
 * A SALON ROW WITH NO SEED IS READ AFTER ITS KEY GROUP'S DRAIN, AND EVERY OTHER ROW AT ONCE
 * (1.6.11 logs, 2026-11-14). A salon opened on a cold start decoded its page while the key group's
 * pending queue - the frames carrying the seeds its members minted meanwhile - was still being
 * drained: those rows read `missing seed`, were warned and asked for, and were drawn only by the
 * re-read the drain's end announced. The seed store is the discriminator: a row whose seed is held is
 * drawn at once (offline too - charter principle 2), and only a row whose seed is missing waits for
 * the drain proof, unwarned, then reads with the seed the drain brought or is reported truly missing.
 */
import { SvelteMap } from 'svelte/reactivity';
import type { Conversation } from '$lib/types';
import { flushMacrotask } from '../../test/flush';

const listMessages = vi.hoisted(() => vi.fn());
const listReadMarks = vi.hoisted(() => vi.fn());
vi.mock('$lib/services/ChannelService', () => ({
  channelService: { listMessages, listReadMarks },
}));

/** The device's seed store, by row, and what a row read without its seed says. */
const seeds = vi.hoisted(() => ({
  held: new Set<string>(),
  missingSeedWarned: vi.fn(),
}));

vi.mock('$lib/utils/chat/channelCrypto', () => ({
  isChannelConversationId: (id: string) => id.startsWith('channel_'),
  decodeChannelMessagePage: vi.fn(
    async (
      _raw: string,
      rows: readonly { id: string }[],
      _me: string,
      _tally: unknown,
      deferMissingSeed?: Set<number>
    ) =>
      rows.map((row, i) => {
        if (!seeds.held.has(row.id)) {
          if (deferMissingSeed) {
            deferMissingSeed.add(i);
            return null;
          }
          // What `reportUnreadableChannelMessage` says for a `GraineSessionUnavailableError`.
          seeds.missingSeedWarned(row.id);
          return null;
        }
        return {
          kind: 'message',
          message: {
            id: row.id,
            senderId: 'peer',
            content: `text of ${row.id}`,
            timestamp: new Date(row.id === 'm1' ? 1_000 : 2_000),
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
  settle: null as null | ((bring: string[]) => void),
  salonKeysNow: vi.fn(),
}));
vi.mock('$lib/utils/graine/salonReadGate', () => ({
  salonKeysNow: drain.salonKeysNow,
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

function openSalon() {
  const convs = useConversations();
  convs.conversations.set(SALON, {
    id: SALON,
    name: SALON,
    messages: [],
  } as unknown as Conversation);
  return convs;
}

const ids = (convs: ReturnType<typeof useConversations>) =>
  convs.conversations.get(SALON)?.messages.map((m) => m.id);

beforeEach(async () => {
  vi.clearAllMocks();
  seeds.held = new Set(['m1']);
  drain.settle = null;
  drain.salonKeysNow.mockImplementation(() => ({
    kind: 'draining',
    groupId: 'kg-0001',
    drained: () =>
      new Promise((resolve) => {
        drain.settle = (bring) => {
          // The drain applies the key group's frames - the seeds land - and only then is it proven.
          for (const id of bring) seeds.held.add(id);
          resolve({ kind: 'drained', groupId: 'kg-0001', waited: true });
        };
      }),
  }));
  listMessages.mockResolvedValue([{ id: 'm1' }, { id: 'm2' }]);
  listReadMarks.mockResolvedValue([]);
  const gate = await import('$lib/utils/graine/salonSendGate');
  gate.resetSalonSendGate();
});

describe('a salon opened while its key group is draining', () => {
  it('draws the row whose seed is held at once, and the one whose seed is in the queue after the drain, unwarned', async () => {
    const convs = openSalon();
    const loading = convs.loadHistoryForConversation(SALON, SALON, makeCtx(), { force: true });
    await vi.waitFor(() => expect(drain.settle).not.toBeNull());
    await flushMacrotask();

    // The held row does not wait for the link: drawn, and the skeleton is down.
    expect(ids(convs)).toEqual(['m1']);
    expect(convs.isLoadingHistory).toBe(false);
    // The other is neither warned nor asked for: its seed may be a frame of the queue.
    expect(seeds.missingSeedWarned).not.toHaveBeenCalled();

    drain.settle?.(['m2']);
    await loading;

    expect(seeds.missingSeedWarned).not.toHaveBeenCalled();
    expect(ids(convs)).toEqual(['m1', 'm2']);
    // One fetch: the second read is a decode of the rows already in hand, never a refetch.
    expect(listMessages).toHaveBeenCalledTimes(1);
  });

  it('a seed the drain did not bring is reported only after the drain - something true', async () => {
    const convs = openSalon();
    const loading = convs.loadHistoryForConversation(SALON, SALON, makeCtx(), { force: true });
    await vi.waitFor(() => expect(drain.settle).not.toBeNull());
    expect(seeds.missingSeedWarned).not.toHaveBeenCalled();

    drain.settle?.([]);
    await loading;

    expect(seeds.missingSeedWarned).toHaveBeenCalledTimes(1);
    expect(seeds.missingSeedWarned).toHaveBeenCalledWith('m2');
    expect(ids(convs)).toEqual(['m1']);
  });

  it('a page whose every seed is held never starts the wait', async () => {
    seeds.held = new Set(['m1', 'm2']);
    const convs = openSalon();
    await convs.loadHistoryForConversation(SALON, SALON, makeCtx(), { force: true });
    expect(drain.settle).toBeNull();
    expect(ids(convs)).toEqual(['m1', 'm2']);
    expect(seeds.missingSeedWarned).not.toHaveBeenCalled();
  });

  it('a drain already proven reads the page whole, and a missing seed is reported at once', async () => {
    drain.salonKeysNow.mockReturnValue({ kind: 'drained', groupId: 'kg-0001', waited: false });
    const convs = openSalon();
    await convs.loadHistoryForConversation(SALON, SALON, makeCtx(), { force: true });
    expect(seeds.missingSeedWarned).toHaveBeenCalledWith('m2');
    expect(ids(convs)).toEqual(['m1']);
  });

  it('a newer load started during the wait supersedes the deferred rows of the older one', async () => {
    const convs = openSalon();
    const first = convs.loadHistoryForConversation(SALON, SALON, makeCtx(), { force: true });
    await vi.waitFor(() => expect(drain.settle).not.toBeNull());
    const settleFirst = drain.settle!;

    // The newer load finds the drain proven and the seed held.
    drain.salonKeysNow.mockReturnValue({ kind: 'drained', groupId: 'kg-0001', waited: false });
    seeds.held.add('m2');
    await convs.loadHistoryForConversation(SALON, SALON, makeCtx(), { force: true });
    expect(ids(convs)).toEqual(['m1', 'm2']);
    const { decodeChannelMessagePage } = await import('$lib/utils/chat/channelCrypto');
    const decodes = vi.mocked(decodeChannelMessagePage).mock.calls.length;

    settleFirst([]);
    await first;
    // The older load neither decodes its deferred row again nor merges over the newer page.
    expect(vi.mocked(decodeChannelMessagePage).mock.calls.length).toBe(decodes);
    expect(ids(convs)).toEqual(['m1', 'm2']);
  });
});
