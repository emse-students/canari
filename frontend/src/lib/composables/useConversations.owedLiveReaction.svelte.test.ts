// @vitest-environment happy-dom
/**
 * A PAGE OF HISTORY RAISES NO REACTION - EXCEPT THE ONE ROW THAT ARRIVED LIVE BEFORE ITS SEED.
 *
 * The live path parks the decision of a row it could not open for a missing seed
 * (`owedLiveFrames.ts`); the repair that later opens it is a history load. That load hands the
 * reaction it reads to the parked decision - only that row, only once - and every other reaction on
 * the page stays silent (Mi 9T, 1.7.0-alpha.10, 2026-11-18).
 */
import type { Conversation } from '$lib/types';
import { ReactionsByConversation } from '$lib/utils/chat/reactionsByConversation';

const listMessages = vi.hoisted(() => vi.fn());
const listReadMarks = vi.hoisted(() => vi.fn());
const fetchAllChannelMessages = vi.hoisted(() => vi.fn());
const applyChannelReactionFrame = vi.hoisted(() => vi.fn(() => true));

vi.mock('$lib/services/ChannelService', () => ({
  channelService: { listMessages, listReadMarks, fetchAllChannelMessages },
}));

vi.mock('$lib/stores/reactionStore.svelte', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  applyChannelReactionFrame,
}));

vi.mock('$lib/utils/chat/channelCrypto', () => ({
  isChannelConversationId: (id: string) => id.startsWith('channel_'),
  decodeChannelMessagePage: vi.fn(async (_raw: string, rows: readonly { id: string }[]) =>
    rows.map((row) => ({
      kind: 'reaction',
      reaction: {
        targetMessageId: 'srv-mine',
        senderId: row.id === 'srv-r1' ? 'peer' : 'other',
        emoji: '+1',
        at: 1_700_000_000_123,
        removed: false,
        targetAuthorId: null,
      },
    }))
  ),
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
const { oweLiveDecision, owedLiveGeneration, takeOwedLiveDecision, resetOwedLiveDecisions } =
  await import('$lib/utils/chat/owedLiveFrames');

const RAW = '7d2f0aa0-0000-4000-8000-000000000003';
const SALON = `channel_${RAW}`;

function makeCtx() {
  return {
    storage: null,
    ensureMls: () => ({}),
    userId: 'me',
    deviceKeyB64: 'k',
    historyBaseUrl: '',
    messageReactions: new ReactionsByConversation(),
    log: vi.fn(),
    addMessageToChat: vi.fn(),
  } as never;
}

function holdSalon(convs: ReturnType<typeof useConversations>) {
  convs.conversations.set(SALON, {
    id: SALON,
    name: SALON,
    messages: [],
  } as unknown as Conversation);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Set here, never restored at a test's end: a failed assertion must not leak a `false` onward.
  applyChannelReactionFrame.mockReturnValue(true);
  resetOwedLiveDecisions();
  localStorage.clear();
  listMessages.mockResolvedValue([{ id: 'srv-r1' }, { id: 'srv-r2' }]);
  listReadMarks.mockResolvedValue([]);
});

describe('a history load and the live decisions it owes', () => {
  it('hands the parked row its reaction, once, with what applying it changed', async () => {
    const decide = vi.fn();
    oweLiveDecision(RAW, 'srv-r1', owedLiveGeneration(), decide);
    const convs = useConversations();
    holdSalon(convs);

    await convs.loadHistoryForConversation(SALON, SALON, makeCtx());

    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide).toHaveBeenCalledWith(
      expect.objectContaining({ targetMessageId: 'srv-mine', senderId: 'peer' }),
      true
    );
    expect(takeOwedLiveDecision(RAW, 'srv-r1', 'test')).toBeNull();

    // A second load of the same page is history again: nothing is owed any more.
    convs.invalidateChannelHistoryCache(SALON);
    await convs.loadHistoryForConversation(SALON, SALON, makeCtx());
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it('carries a replay as a replay - the trigger refuses what changed nothing', async () => {
    applyChannelReactionFrame.mockReturnValue(false);
    const decide = vi.fn();
    oweLiveDecision(RAW, 'srv-r1', owedLiveGeneration(), decide);
    const convs = useConversations();
    holdSalon(convs);

    await convs.loadHistoryForConversation(SALON, SALON, makeCtx());

    expect(decide).toHaveBeenCalledWith(expect.anything(), false);
  });

  it('a SEARCH that opens the parked row first is the reader that owes its decision', async () => {
    fetchAllChannelMessages.mockResolvedValue({ rows: [{ id: 'srv-r1' }], capped: false });
    const decide = vi.fn();
    oweLiveDecision(RAW, 'srv-r1', owedLiveGeneration(), decide);
    const convs = useConversations();
    holdSalon(convs);

    await convs.searchChannelHistory(SALON, 'hello', makeCtx());

    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ senderId: 'peer' }), true);
    expect(takeOwedLiveDecision(RAW, 'srv-r1', 'test')).toBeNull();
  });

  it('owes nothing for a row parked in ANOTHER salon of the same id space', async () => {
    const decide = vi.fn();
    oweLiveDecision('another-salon', 'srv-r1', owedLiveGeneration(), decide);
    const convs = useConversations();
    holdSalon(convs);

    await convs.loadHistoryForConversation(SALON, SALON, makeCtx());

    expect(decide).not.toHaveBeenCalled();
  });
});
