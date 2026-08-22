/**
 * `loadHistoryForConversation`'s full replay path used to have no `catch` at all: every caller
 * fires it with `void`, so a throw (network hiccup, decrypt error, IndexedDB contention - all
 * realistic during a cold-started app's many concurrent init steps) left `conversation.messages`
 * never updated, with nothing logged anywhere. The empty conversation this left behind was
 * indistinguishable from one that genuinely had no history - reported from a real phone as
 * "no history when opening via a notification".
 */
import { SvelteMap } from 'svelte/reactivity';
import type { Conversation } from '$lib/types';

const replayConversationHistory = vi.hoisted(() => vi.fn());
const readHistoryStreamCursor = vi.hoisted(() => vi.fn());

vi.mock('$lib/utils/chat/history', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/utils/chat/history')>();
  return { ...actual, replayConversationHistory, readHistoryStreamCursor };
});

vi.mock('$lib/mls-client/mlsBulkIngest', () => ({
  // Transparent passthrough: runs the replay and propagates whatever it does (resolve or throw).
  withMlsBulkIngest: async (_mls: unknown, fn: () => unknown) => fn(),
}));

// Same isolation reasoning as the scrollback test: the composable is reachable from the global
// chat singleton's own module-scope instantiation, so importing it directly would close a cycle.
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: {},
  globalNotifs: {},
  appendLog: vi.fn(),
}));

const { useConversations } = await import('./useConversations.svelte');

const DM = 'peer-dm';
const GROUP_ID = 'e4c1f0aa-0000-4000-8000-000000000002';

function conversation(): Conversation {
  return { id: GROUP_ID, name: DM, messages: [] } as unknown as Conversation;
}

function makeCtx() {
  const mls = { fetchHistory: vi.fn(), getDeviceId: () => 'dev-1' };
  const log = vi.fn();
  return {
    log,
    ctx: {
      storage: null,
      ensureMls: () => mls,
      userId: 'u1',
      deviceKeyB64: 'k',
      messageReactions: new SvelteMap(),
      log,
      addMessageToChat: vi.fn(),
    } as never,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  readHistoryStreamCursor.mockReturnValue(null); // no cursor -> straight to the full replay path
});

describe('loadHistoryForConversation - the full replay path', () => {
  it('logs and clears isLoadingHistory instead of leaving an unhandled rejection', async () => {
    const convs = useConversations();
    convs.conversations.set(DM, conversation());
    convs.selectConversation(DM);
    const { ctx, log } = makeCtx();
    replayConversationHistory.mockRejectedValue(new Error('decrypt failed'));

    await expect(convs.loadHistoryForConversation(DM, GROUP_ID, ctx)).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledWith(expect.stringContaining('[HISTORY]'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('decrypt failed'));
    expect(convs.isLoadingHistory).toBe(false);
  });

  it('still updates the conversation and clears isLoadingHistory on the happy path', async () => {
    const convs = useConversations();
    convs.conversations.set(DM, conversation());
    convs.selectConversation(DM);
    const { ctx, log } = makeCtx();
    replayConversationHistory.mockResolvedValue(undefined);

    await convs.loadHistoryForConversation(DM, GROUP_ID, ctx);

    expect(log).not.toHaveBeenCalled();
    expect(convs.isLoadingHistory).toBe(false);
  });
});
