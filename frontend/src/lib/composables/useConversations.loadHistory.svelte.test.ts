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

/**
 * A conversation whose group is gone is KEPT, at `lifecycle: 'removed'`, so the UI can explain the
 * absence - which means a user really does open one. Every open used to fire
 * `GET /api/mls/history/<id>` at a group the server has soft-deleted and refuses, and `fetchHistory`
 * swallowed the 403 into an empty page, so the refusal was invisible in the app and showed only as a
 * console error nobody could attribute. Measured on DEL-2 and DEL-3, 2026-09-05: the request went
 * out eleven seconds AFTER the client's own deletion, so it was never one already in flight.
 */
describe('loadHistoryForConversation - a conversation whose group is gone', () => {
  it('renders what is on disk and asks the server for nothing', async () => {
    const convs = useConversations();
    convs.conversations.set(DM, { ...conversation(), lifecycle: 'removed' } as Conversation);
    convs.selectConversation(DM);
    const { ctx, log } = makeCtx();

    await convs.loadHistoryForConversation(DM, GROUP_ID, ctx);

    // THE ASSERTION IS THE ABSENCE OF A REQUEST, and both halves matter: no probe, no replay.
    expect(
      (ctx as unknown as { ensureMls: () => { fetchHistory: unknown } }).ensureMls().fetchHistory
    ).not.toHaveBeenCalled();
    expect(replayConversationHistory).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(convs.isLoadingHistory).toBe(false);
  });

  it('still replays an ACTIVE conversation, so the guard is the lifecycle and not the branch', async () => {
    const convs = useConversations();
    convs.conversations.set(DM, { ...conversation(), lifecycle: 'active' } as Conversation);
    convs.selectConversation(DM);
    const { ctx } = makeCtx();
    replayConversationHistory.mockResolvedValue(undefined);

    await convs.loadHistoryForConversation(DM, GROUP_ID, ctx);

    expect(replayConversationHistory).toHaveBeenCalledTimes(1);
  });
});

/**
 * A notification tap opens a conversation that HAS something new - the message it announced - so
 * the cursor probe answers "yes, there is more" and the full replay runs. The page the device
 * already holds used to be drawn only after that replay, which left the reader on an empty thread
 * for the length of a network catch-up over history that was on disk all along (Mi 9T, 2026-10-12:
 * ~0.7 s between the pane and its first row on a cold landing).
 */
describe('loadHistoryForConversation - the stored page is drawn before the server is asked', () => {
  function storedRow(id: string, at: number) {
    return { id, conversationId: GROUP_ID, senderId: 'peer', content: `held ${id}`, timestamp: at };
  }

  function ctxWithStorage(page: ReturnType<typeof storedRow>[]) {
    const { ctx, log } = makeCtx();
    const storage = { getMessagesPage: vi.fn().mockResolvedValue(page) };
    return { ctx: { ...(ctx as object), storage } as never, log, storage };
  }

  it('shows the held rows while the probe and the replay are still in flight', async () => {
    const convs = useConversations();
    convs.conversations.set(DM, conversation());
    convs.selectConversation(DM);
    readHistoryStreamCursor.mockReturnValue('cursor-1');
    const { ctx } = ctxWithStorage([storedRow('m1', 1_000), storedRow('m2', 2_000)]);
    let releaseProbe: (v: { rows: unknown[] }) => void = () => {};
    (ctx as unknown as { ensureMls: () => { fetchHistory: ReturnType<typeof vi.fn> } })
      .ensureMls()
      .fetchHistory.mockReturnValue(new Promise((r) => (releaseProbe = r)));
    replayConversationHistory.mockResolvedValue(undefined);

    const done = convs.loadHistoryForConversation(DM, GROUP_ID, ctx);
    await vi.waitFor(() =>
      expect(convs.conversations.get(DM)?.messages.map((m) => m.id)).toEqual(['m1', 'm2'])
    );
    // THE ORDER IS THE ASSERTION: the rows are on screen and the replay has not even started.
    expect(replayConversationHistory).not.toHaveBeenCalled();

    releaseProbe({ rows: [{ id: 'newer' }] });
    await done;
    expect(replayConversationHistory).toHaveBeenCalledTimes(1);
    expect(convs.isLoadingHistory).toBe(false);
  });

  it('leaves no hole when the replay brings more than a page', async () => {
    // Drawing first must change WHEN rows appear, never which: the scrollback pages below the
    // OLDEST row in memory, so an early-drawn page kept under a fresh one that does not reach it
    // would hide every stored row between the two windows for good.
    const convs = useConversations();
    convs.conversations.set(DM, conversation());
    convs.selectConversation(DM);
    readHistoryStreamCursor.mockReturnValue('cursor-1');
    const held = Array.from({ length: 60 }, (_, i) => storedRow(`m${i + 1}`, (i + 1) * 1_000));
    const fresh = Array.from({ length: 60 }, (_, i) => storedRow(`m${i + 101}`, (i + 101) * 1_000));
    const { ctx, storage } = ctxWithStorage(held);
    storage.getMessagesPage.mockResolvedValueOnce(held).mockResolvedValue(fresh);
    (ctx as unknown as { ensureMls: () => { fetchHistory: ReturnType<typeof vi.fn> } })
      .ensureMls()
      .fetchHistory.mockResolvedValue({ rows: [{ id: 'newer' }] });
    replayConversationHistory.mockResolvedValue(undefined);

    await convs.loadHistoryForConversation(DM, GROUP_ID, ctx);

    expect(convs.conversations.get(DM)?.messages.map((m) => m.id)).toEqual(fresh.map((r) => r.id));
  });

  it('keeps the early-drawn rows the fresh page overlaps', async () => {
    const convs = useConversations();
    convs.conversations.set(DM, conversation());
    convs.selectConversation(DM);
    readHistoryStreamCursor.mockReturnValue('cursor-1');
    const held = [storedRow('m1', 1_000), storedRow('m2', 2_000)];
    const fresh = [...held, storedRow('m3', 3_000)];
    const { ctx, storage } = ctxWithStorage(held);
    storage.getMessagesPage.mockResolvedValueOnce(held).mockResolvedValue(fresh);
    (ctx as unknown as { ensureMls: () => { fetchHistory: ReturnType<typeof vi.fn> } })
      .ensureMls()
      .fetchHistory.mockResolvedValue({ rows: [{ id: 'm3' }] });
    replayConversationHistory.mockResolvedValue(undefined);

    await convs.loadHistoryForConversation(DM, GROUP_ID, ctx);

    expect(convs.conversations.get(DM)?.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('still skips the replay when the probe finds nothing newer', async () => {
    const convs = useConversations();
    convs.conversations.set(DM, conversation());
    convs.selectConversation(DM);
    readHistoryStreamCursor.mockReturnValue('cursor-1');
    const { ctx } = ctxWithStorage([storedRow('m1', 1_000)]);
    (ctx as unknown as { ensureMls: () => { fetchHistory: ReturnType<typeof vi.fn> } })
      .ensureMls()
      .fetchHistory.mockResolvedValue({ rows: [] });

    await convs.loadHistoryForConversation(DM, GROUP_ID, ctx);

    expect(convs.conversations.get(DM)?.messages.map((m) => m.id)).toEqual(['m1']);
    expect(replayConversationHistory).not.toHaveBeenCalled();
  });
});
