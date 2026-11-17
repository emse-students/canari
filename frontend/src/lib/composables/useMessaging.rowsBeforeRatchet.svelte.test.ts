/**
 * ROWS BEFORE RATCHET (P1, second review of #3321).
 *
 * A live drain buffers each decrypted message until its window closes, and a checkpoint started
 * meanwhile exports the frame's ratchet advance and its seen mark. A kill between the two lost the
 * message for good: the generation is spent on disk and the frame is marked seen, so it can neither
 * be decrypted again nor replayed. The checkpoint now asks the buffer to store its rows before it
 * exports (`holdRowsForCheckpoint`, called by `BaseMlsService.persistCheckpoint`).
 *
 * The kill is simulated by never closing the window: what the store holds when the hold resolves is
 * what a reload would find.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';

/**
 * The sender lookup a notification waits on is a profile read (`/api/users/batch`) nothing here is
 * about: it answers from the cache, offline, as the synchronous form does.
 */
vi.mock('$lib/utils/users/displayName', async (importOriginal) => {
  const real = await importOriginal<typeof import('$lib/utils/users/displayName')>();
  return {
    ...real,
    resolveNotificationSenderName: async (
      senderId: string,
      conversationKey: string,
      convo: Parameters<typeof real.notificationSenderName>[2]
    ) => real.notificationSenderName(senderId, conversationKey, convo),
    // A visible notice's text names its actor: every id draws as itself here.
    resolveDisplayNames: async () => (id: string) => id,
  };
});

/**
 * BREAKS AN IMPORT CYCLE, and it is the module graph's shape rather than a convenience.
 *
 * `useMessaging` -> `chat/outbox` -> `chat/outboxMirror` -> `globalChatSingleton` -> which CALLS
 * `useMessaging()` at module scope. In the app the singleton is always the module that loads
 * first, so it finishes initialising before anything re-enters; entered from this file the cycle
 * closes early and `new MediaService()` hits an uninitialised import binding. Stubbing the
 * singleton cuts the back-edge without touching the code under test.
 */
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  appendLog: () => {},
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: {},
  globalNotifs: {},
}));

const { useMessaging } = await import('./useMessaging.svelte');
type MessagingContext = import('./useMessaging.svelte').MessagingContext;
import type { Conversation } from '$lib/types';

const ME = 'me-user-id';
const PEER = 'peer-user-id';
const CONVO = 'conversation-key';

/** The buffering phase a LIVE single-message drain opens - the one a user can send inside. */
const LIVE_DRAIN = { bufferUi: true, showOverlay: false };

function makeContext() {
  const saveMessage = vi.fn().mockResolvedValue(undefined);
  const conversations = new SvelteMap<string, Conversation>([
    [CONVO, { id: CONVO, name: CONVO, messages: [], unreadCount: 0, lastMessageAt: 0 } as never],
  ]);
  const ctx = {
    conversations,
    userId: ME,
    deviceKeyB64: 'device-key',
    authToken: 'token',
    selectedContact: CONVO,
    // An arriving row is written only where none stands (`saveMessagesIfAbsent`); it lands in
    // `saveMessage` here, the one sink these assertions read.
    storage: {
      saveMessage,
      saveMessagesIfAbsent: vi.fn(async (rows: { id: string }[], key: string) => {
        for (const row of rows) await saveMessage(row, key);
        return new Set(rows.map((row) => row.id));
      }),
      getMessagesByIds: vi.fn(async () => ({ rows: new Map(), unreadable: new Set() })),
      // No row stands in this store: a compare-and-set finds nothing, and the insert writes.
      mergeMessages: vi.fn(async () => new Set()),
      getPendingMutations: vi.fn(async () => ({ entries: [], unreadable: 0 })),
    } as never,
    setAuthToken: vi.fn(),
    getSendError: () => '',
    setSendError: vi.fn(),
    ensureMls: vi.fn(),
    log: vi.fn(),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    playNotificationTone: vi.fn(),
    playReceiveTone: vi.fn(),
    sendSystemNotification: vi.fn().mockResolvedValue(undefined),
  } as unknown as MessagingContext;
  return { ctx, conversations, saveMessage };
}

const idsIn = (conversations: SvelteMap<string, Conversation>) =>
  (conversations.get(CONVO)?.messages ?? []).map((m) => m.id);
const storedIds = (saveMessage: ReturnType<typeof vi.fn>) =>
  saveMessage.mock.calls.map(([row]) => (row as { id: string }).id);

describe('a checkpoint during a bulk-ingest window (rows before ratchet)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('stores every buffered row BEFORE the hold resolves, the window still open - a kill after the export keeps them', async () => {
    const messaging = useMessaging();
    const { ctx, conversations, saveMessage } = makeContext();

    messaging.beginBulkMessageIngest(LIVE_DRAIN);
    await messaging.addMessageToChat(PEER, 'first', CONVO, ctx, { messageId: 'in-1' });
    await messaging.addMessageToChat(PEER, 'second', CONVO, ctx, { messageId: 'in-2' });
    expect(storedIds(saveMessage)).toEqual([]);

    // The checkpoint's hold: once it resolves, the export may run.
    const release = await messaging.holdRowsForCheckpoint(ctx);

    expect(storedIds(saveMessage)).toEqual(['in-1', 'in-2']);
    expect(idsIn(conversations)).toEqual(['in-1', 'in-2']);
    release();
  });

  it('a message arriving while the hold is taken is STORED by its own handler, never buffered behind it', async () => {
    const messaging = useMessaging();
    const { ctx, saveMessage } = makeContext();

    messaging.beginBulkMessageIngest(LIVE_DRAIN);
    const release = await messaging.holdRowsForCheckpoint(ctx);
    await messaging.addMessageToChat(PEER, 'during the export', CONVO, ctx, { messageId: 'in-3' });

    expect(storedIds(saveMessage)).toEqual(['in-3']);
    release();
  });

  it('buffers again once released, and the window close stores what came after', async () => {
    const messaging = useMessaging();
    const { ctx, conversations, saveMessage } = makeContext();

    messaging.beginBulkMessageIngest(LIVE_DRAIN);
    (await messaging.holdRowsForCheckpoint(ctx))();
    await messaging.addMessageToChat(PEER, 'after the export', CONVO, ctx, { messageId: 'in-4' });
    expect(storedIds(saveMessage)).toEqual([]);

    await messaging.endBulkMessageIngest(ctx, LIVE_DRAIN);
    expect(storedIds(saveMessage)).toEqual(['in-4']);
    expect(idsIn(conversations)).toEqual(['in-4']);
  });

  it('waits for a window close already storing: the hold resolves only once ITS rows are on disk', async () => {
    const messaging = useMessaging();
    const { ctx, saveMessage } = makeContext();
    let landWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      landWrite = resolve;
    });
    const saveMessagesIfAbsent = (
      ctx.storage as unknown as { saveMessagesIfAbsent: ReturnType<typeof vi.fn> }
    ).saveMessagesIfAbsent;
    const realSave = saveMessagesIfAbsent.getMockImplementation() as (
      rows: { id: string }[],
      key: string
    ) => Promise<Set<string>>;
    saveMessagesIfAbsent.mockImplementationOnce(async (rows: { id: string }[], key: string) => {
      await writeGate;
      return realSave(rows, key);
    });

    messaging.beginBulkMessageIngest(LIVE_DRAIN);
    await messaging.addMessageToChat(PEER, 'closing', CONVO, ctx, { messageId: 'in-5' });
    // The persister observer runs first at a close and starts the checkpoint; the UI observer then
    // takes the buffer - so the hold meets an empty buffer and a store still running.
    const closing = messaging.endBulkMessageIngest(ctx, LIVE_DRAIN);
    let held = false;
    const hold = messaging.holdRowsForCheckpoint(ctx).then((release) => {
      held = true;
      return release;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(held).toBe(false);

    landWrite();
    (await hold)();
    expect(storedIds(saveMessage)).toEqual(['in-5']);
    await closing;
  });
});
