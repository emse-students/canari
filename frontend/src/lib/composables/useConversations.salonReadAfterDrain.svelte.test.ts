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
const fetchAllChannelMessages = vi.hoisted(() => vi.fn());
vi.mock('$lib/services/ChannelService', () => ({
  channelService: { listMessages, listReadMarks, fetchAllChannelMessages },
}));

/** The device's seed store, by row, and what a row read without its seed says. */
const seeds = vi.hoisted(() => ({
  held: new Set<string>(),
  missingSeedWarned: vi.fn(),
  /** Run once, while the NEXT page is being decoded: a live event landing during the decode. */
  duringDecode: null as null | (() => void),
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
    ) => {
      const during = seeds.duringDecode;
      seeds.duringDecode = null;
      during?.();
      return rows.map((row, i) => {
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
      });
    }
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
const { noteSalonRowRemoved } = await import('$lib/utils/chat/salonRemovals');
const { getPollMeta, setPollMeta } = await import('$lib/stores/pollStore.svelte');

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
  seeds.duringDecode = null;
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

  it('the deferred pass never rewinds what moved on screen during the wait - a deletion, an edit', async () => {
    const convs = openSalon();
    const loading = convs.loadHistoryForConversation(SALON, SALON, makeCtx(), { force: true });
    await vi.waitFor(() => expect(drain.settle).not.toBeNull());
    await flushMacrotask();
    expect(ids(convs)).toEqual(['m1']);

    // While the link comes back, the held row is deleted by a live event (or edited by its author):
    // the page in hand still carries it as it was when fetched.
    const before = convs.conversations.get(SALON)!;
    convs.conversations.set(SALON, {
      ...before,
      messages: before.messages.map((m) =>
        m.id === 'm1' ? { ...m, isDeleted: true, content: 'deleted' } : m
      ),
    });

    drain.settle?.(['m2']);
    await loading;

    const m1 = convs.conversations.get(SALON)!.messages.find((m) => m.id === 'm1');
    expect(m1?.isDeleted).toBe(true);
    expect(m1?.content).toBe('deleted');
    expect(ids(convs)).toEqual(['m1', 'm2']);
  });

  it('a salon declared stale during the wait is not marked fresh again by the deferred pass', async () => {
    const convs = openSalon();
    const loading = convs.loadHistoryForConversation(SALON, SALON, makeCtx(), { force: true });
    await vi.waitFor(() => expect(drain.settle).not.toBeNull());
    await flushMacrotask();

    convs.invalidateChannelHistoryCache(SALON);
    drain.settle?.(['m2']);
    await loading;

    drain.salonKeysNow.mockReturnValue({ kind: 'drained', groupId: 'kg-0001', waited: false });
    await convs.loadHistoryForConversation(SALON, SALON, makeCtx());
    expect(listMessages).toHaveBeenCalledTimes(2);
  });

  it('a wait the closing service ends decodes nothing more and warns of nothing', async () => {
    drain.salonKeysNow.mockReturnValue({
      kind: 'draining',
      groupId: 'kg-0001',
      drained: () => Promise.resolve({ kind: 'unwaited', reason: 'closed' }),
    });
    const convs = openSalon();
    await convs.loadHistoryForConversation(SALON, SALON, makeCtx(), { force: true });
    const { decodeChannelMessagePage } = await import('$lib/utils/chat/channelCrypto');
    expect(vi.mocked(decodeChannelMessagePage)).toHaveBeenCalledTimes(1);
    expect(seeds.missingSeedWarned).not.toHaveBeenCalled();
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
  it('a salon left during the wait is not decoded again - no warning, no request for a salon gone', async () => {
    const convs = openSalon();
    const loading = convs.loadHistoryForConversation(SALON, SALON, makeCtx(), { force: true });
    await vi.waitFor(() => expect(drain.settle).not.toBeNull());
    await flushMacrotask();

    // Removed from the private salon (or signed out): the purge takes the conversation.
    convs.conversations.delete(SALON);

    drain.settle?.([]);
    await loading;
    const { decodeChannelMessagePage } = await import('$lib/utils/chat/channelCrypto');
    expect(vi.mocked(decodeChannelMessagePage)).toHaveBeenCalledTimes(1);
    expect(seeds.missingSeedWarned).not.toHaveBeenCalled();
    expect(convs.conversations.has(SALON)).toBe(false);
  });

  it('a deferred row removed live during the wait is never inserted - the delete found no row to mark', async () => {
    const convs = openSalon();
    const loading = convs.loadHistoryForConversation(SALON, SALON, makeCtx(), { force: true });
    await vi.waitFor(() => expect(drain.settle).not.toBeNull());
    await flushMacrotask();
    expect(ids(convs)).toEqual(['m1']);

    // `channel.message.deleted` for the row still waiting for its seed: nothing on screen to mark.
    noteSalonRowRemoved('m2');

    drain.settle?.(['m2']);
    await loading;
    expect(ids(convs)).toEqual(['m1']);
  });

  it('a held row removed live while the page decodes is not put back by the merge', async () => {
    seeds.held = new Set(['m1', 'm2']);
    seeds.duringDecode = () => noteSalonRowRemoved('m1');
    const convs = openSalon();
    await convs.loadHistoryForConversation(SALON, SALON, makeCtx(), { force: true });
    expect(ids(convs)).toEqual(['m2']);
  });

  it("a removal before the page was asked for, or by another salon read, is not this load's", async () => {
    noteSalonRowRemoved('m1');
    seeds.held = new Set(['m1', 'm2']);
    const convs = openSalon();
    await convs.loadHistoryForConversation(SALON, SALON, makeCtx(), { force: true });
    // No watch was open: the note went nowhere, and the page is authoritative for what it holds.
    expect(ids(convs)).toEqual(['m1', 'm2']);
  });

  it("a live vote during the wait is not rewound by the deferred row's older tally", async () => {
    const stale = {
      optionIds: ['a'],
      multipleChoice: false,
      endsAt: null,
      closed: false,
      votesByUser: {},
    };
    const live = { ...stale, votesByUser: { peer: ['a'] } };
    listMessages.mockResolvedValue([{ id: 'm1' }, { id: 'm2', poll: stale }]);
    const convs = openSalon();
    const loading = convs.loadHistoryForConversation(SALON, SALON, makeCtx(), { force: true });
    await vi.waitFor(() => expect(drain.settle).not.toBeNull());
    await flushMacrotask();

    // `channel.poll.vote` on the poll still waiting for its seed.
    setPollMeta('m2', live);

    drain.settle?.(['m2']);
    await loading;
    expect(getPollMeta('m2')).toEqual(live);
  });

  it("a live vote while the page decodes is not rewound by the page's older tally", async () => {
    seeds.held = new Set(['m1', 'm2']);
    const stale = {
      optionIds: ['a'],
      multipleChoice: false,
      endsAt: null,
      closed: false,
      votesByUser: {},
    };
    const live = { ...stale, votesByUser: { peer: ['a'] } };
    listMessages.mockResolvedValue([{ id: 'm1', poll: stale }, { id: 'm2' }]);
    seeds.duringDecode = () => setPollMeta('m1', live);
    const convs = openSalon();
    await convs.loadHistoryForConversation(SALON, SALON, makeCtx(), { force: true });
    expect(getPollMeta('m1')).toEqual(live);
  });

  it('a whole-history search does not insert a row removed live while it decoded', async () => {
    drain.salonKeysNow.mockReturnValue({ kind: 'drained', groupId: 'kg-0001', waited: false });
    seeds.held = new Set(['m1', 'm2']);
    fetchAllChannelMessages.mockResolvedValue({
      rows: [{ id: 'm1' }, { id: 'm2' }],
      capped: false,
    });
    seeds.duringDecode = () => noteSalonRowRemoved('m2');
    const convs = openSalon();
    const hits = await convs.searchChannelHistory(SALON, 'text', makeCtx());
    expect(hits).toEqual(['m1']);
    expect(ids(convs)).toEqual(['m1']);
  });
});
