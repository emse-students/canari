/**
 * Of two overlapping history loads of one salon, only the one started LAST merges its page.
 *
 * The sequence (backlog, found reviewing #1761): load A reads the page while seed S is not held, so
 * row R decodes unreadable and is left out of A's page; S lands and starts load B; B decodes R and
 * merges it; A finishes AFTER B. A page is authoritative for its window, and R lies inside A's - so
 * A's merge used to REMOVE R. Before #1761 a redundant refetch usually put it back, which hid this.
 */
import { SvelteMap } from 'svelte/reactivity';
import type { Conversation } from '$lib/types';

const listMessages = vi.hoisted(() => vi.fn());
const listReadMarks = vi.hoisted(() => vi.fn());

vi.mock('$lib/services/ChannelService', () => ({
  channelService: { listMessages, listReadMarks },
}));

vi.mock('$lib/utils/chat/channelCrypto', () => ({
  isChannelConversationId: (id: string) => id.startsWith('channel_'),
  decodeChannelMessagePage: vi.fn(
    async (raw: string, rows: readonly unknown[], me: string, tally: unknown) => {
      // The page entry decodes row by row through the stub below, as the real one does.
      const { decodeChannelMessageRow } = await import('$lib/utils/chat/channelCrypto');
      const out = [];
      for (const r of rows)
        out.push(await decodeChannelMessageRow(raw, r as never, me, tally as never));
      return out;
    }
  ),
  decodeChannelMessageRow: vi.fn(async (_raw: string, row: { id: string; at: number }) => ({
    kind: 'message',
    message: {
      id: row.id,
      senderId: 'peer',
      content: row.id,
      timestamp: new Date(row.at),
      isOwn: false,
      isSystem: false,
    },
  })),
  UnreadableRowTally: class {
    report() {}
    rowsOf() {
      return [];
    }
  },
  V1_SESSION_NOT_HELD: 'v1 session not held',
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
const { getPollMeta } = await import('$lib/stores/pollStore.svelte');

const SALON = 'channel_7d2f0aa0-0000-4000-8000-000000000002';

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

beforeEach(() => {
  vi.clearAllMocks();
  listReadMarks.mockResolvedValue([]);
});

describe('salon history - a superseded load does not merge', () => {
  it('keeps the row a newer load decoded when an older load finishes last', async () => {
    let answerA: (rows: unknown[]) => void = () => {};
    // Load A: its page will arrive LAST and lacks R (unreadable when A read it).
    listMessages.mockReturnValueOnce(new Promise((resolve) => (answerA = resolve)));
    // Load B: R is readable now.
    listMessages.mockResolvedValueOnce([
      { id: 'm1', at: 1_000 },
      { id: 'R', at: 2_000 },
      { id: 'm3', at: 3_000 },
    ]);

    const convs = useConversations();
    convs.conversations.set(SALON, {
      id: SALON,
      name: SALON,
      messages: [],
    } as unknown as Conversation);
    convs.selectConversation(SALON);
    const ctx = makeCtx();

    const loadA = convs.loadHistoryForConversation(SALON, SALON, ctx, { force: true });
    await vi.waitFor(() => expect(listMessages).toHaveBeenCalledTimes(1));
    await convs.loadHistoryForConversation(SALON, SALON, ctx, { force: true });
    expect(convs.conversations.get(SALON)?.messages.map((m) => m.id)).toEqual(['m1', 'R', 'm3']);

    answerA([
      { id: 'm1', at: 1_000 },
      { id: 'm3', at: 3_000 },
    ]);
    await loadA;

    expect(convs.conversations.get(SALON)?.messages.map((m) => m.id)).toEqual(['m1', 'R', 'm3']);
    expect(convs.isLoadingHistory).toBe(false);
  });

  it('a superseded load leaves the skeleton up while the newer one is still loading', async () => {
    let answerB: (rows: unknown[]) => void = () => {};
    let answerA: (rows: unknown[]) => void = () => {};
    listMessages.mockReturnValueOnce(new Promise((resolve) => (answerA = resolve)));
    listMessages.mockReturnValueOnce(new Promise((resolve) => (answerB = resolve)));

    const convs = useConversations();
    convs.conversations.set(SALON, {
      id: SALON,
      name: SALON,
      messages: [],
    } as unknown as Conversation);
    convs.selectConversation(SALON);
    const ctx = makeCtx();

    const loadA = convs.loadHistoryForConversation(SALON, SALON, ctx, { force: true });
    await vi.waitFor(() => expect(listMessages).toHaveBeenCalledTimes(1));
    const loadB = convs.loadHistoryForConversation(SALON, SALON, ctx, { force: true });
    await vi.waitFor(() => expect(listMessages).toHaveBeenCalledTimes(2));

    answerA([{ id: 'm1', at: 1_000 }]);
    await loadA;
    expect(convs.isLoadingHistory).toBe(true);

    answerB([{ id: 'm1', at: 1_000 }]);
    await loadB;
    expect(convs.isLoadingHistory).toBe(false);
  });

  it('lowers the skeleton it raised when the newer load started off screen', async () => {
    // A starts on screen and raises the skeleton; the reader leaves; a repair starts B while the
    // salon is not selected, so B raises nothing. A, superseded, must still lower what it raised.
    let answerA: (rows: unknown[]) => void = () => {};
    let answerB: (rows: unknown[]) => void = () => {};
    listMessages.mockReturnValueOnce(new Promise((resolve) => (answerA = resolve)));
    listMessages.mockReturnValueOnce(new Promise((resolve) => (answerB = resolve)));

    const convs = useConversations();
    convs.conversations.set(SALON, {
      id: SALON,
      name: SALON,
      messages: [],
    } as unknown as Conversation);
    convs.selectConversation(SALON);
    const ctx = makeCtx();

    const loadA = convs.loadHistoryForConversation(SALON, SALON, ctx, { force: true });
    await vi.waitFor(() => expect(listMessages).toHaveBeenCalledTimes(1));
    expect(convs.isLoadingHistory).toBe(true);
    convs.selectConversation('');
    const loadB = convs.loadHistoryForConversation(SALON, SALON, ctx, { force: true });
    await vi.waitFor(() => expect(listMessages).toHaveBeenCalledTimes(2));

    answerA([{ id: 'm1', at: 1_000 }]);
    await loadA;
    expect(convs.isLoadingHistory).toBe(false);

    answerB([{ id: 'm1', at: 1_000 }]);
    await loadB;
    expect(convs.isLoadingHistory).toBe(false);
  });

  it("does not let a superseded load's poll tally undo the newer one", async () => {
    const pollAt = (voters: string[]) => ({
      optionIds: ['a', 'b'],
      multipleChoice: false,
      endsAt: null,
      votesByUser: Object.fromEntries(voters.map((v) => [v, ['a']])),
      closed: false,
    });
    let answerA: (rows: unknown[]) => void = () => {};
    listMessages.mockReturnValueOnce(new Promise((resolve) => (answerA = resolve)));
    listMessages.mockResolvedValueOnce([{ id: 'p1', at: 1_000, poll: pollAt(['x', 'y']) }]);

    const convs = useConversations();
    convs.conversations.set(SALON, {
      id: SALON,
      name: SALON,
      messages: [],
    } as unknown as Conversation);
    const ctx = makeCtx();

    const loadA = convs.loadHistoryForConversation(SALON, SALON, ctx, { force: true });
    await vi.waitFor(() => expect(listMessages).toHaveBeenCalledTimes(1));
    await convs.loadHistoryForConversation(SALON, SALON, ctx, { force: true });
    expect(Object.keys(getPollMeta('p1')?.votesByUser ?? {})).toEqual(['x', 'y']);

    // A read the row before y voted.
    answerA([{ id: 'p1', at: 1_000, poll: pollAt(['x']) }]);
    await loadA;

    expect(Object.keys(getPollMeta('p1')?.votesByUser ?? {})).toEqual(['x', 'y']);
  });
});
