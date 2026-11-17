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

const { useMessaging, BufferedRowsNotStoredError } = await import('./useMessaging.svelte');
type MessagingContext = import('./useMessaging.svelte').MessagingContext;
import type { Conversation } from '$lib/types';
import { envelopeBodyText, mkTextEnvelope, serializeEnvelope } from '$lib/envelope';

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

  /**
   * A FAILED WRITE MUST NOT LET THE EXPORT THROUGH (review of #3786, P2). `batchAddMessages` caught
   * its own write failure and the buffer was already cleared, so the hold resolved, the checkpoint
   * exported the ratchet advance and the row stood only in memory.
   */
  it('REJECTS the hold while a row stands unstored, and the next hold retries the write', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const messaging = useMessaging();
    const { ctx, saveMessage } = makeContext();
    const saveMessagesIfAbsent = (
      ctx.storage as unknown as { saveMessagesIfAbsent: ReturnType<typeof vi.fn> }
    ).saveMessagesIfAbsent;
    // The batch's write and the hold's one retry of it both fail.
    saveMessagesIfAbsent
      .mockRejectedValueOnce(new Error('QuotaExceededError'))
      .mockRejectedValueOnce(new Error('QuotaExceededError'));

    messaging.beginBulkMessageIngest(LIVE_DRAIN);
    await messaging.addMessageToChat(PEER, 'unlucky', CONVO, ctx, { messageId: 'in-6' });

    await expect(messaging.holdRowsForCheckpoint(ctx)).rejects.toBeInstanceOf(
      BufferedRowsNotStoredError
    );
    expect(storedIds(saveMessage)).toEqual([]);

    // The hold that refused was released: a message now buffers again.
    await messaging.addMessageToChat(PEER, 'next', CONVO, ctx, { messageId: 'in-7' });
    expect(storedIds(saveMessage)).toEqual([]);

    // The next checkpoint's hold retries the failed write, then stores what was buffered since.
    (await messaging.holdRowsForCheckpoint(ctx))();
    expect(storedIds(saveMessage).sort()).toEqual(['in-6', 'in-7']);
  });

  it('a write that failed at the window CLOSE is retried by the next hold, and refuses it while it fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const messaging = useMessaging();
    const { ctx, saveMessage } = makeContext();
    const saveMessagesIfAbsent = (
      ctx.storage as unknown as { saveMessagesIfAbsent: ReturnType<typeof vi.fn> }
    ).saveMessagesIfAbsent;
    // The close's write and the first hold's retry fail; the second hold's retry lands.
    saveMessagesIfAbsent
      .mockRejectedValueOnce(new Error('AbortError'))
      .mockRejectedValueOnce(new Error('AbortError'));

    messaging.beginBulkMessageIngest(LIVE_DRAIN);
    await messaging.addMessageToChat(PEER, 'closing', CONVO, ctx, { messageId: 'in-8' });
    // The close only logs: it is not a checkpoint.
    await messaging.endBulkMessageIngest(ctx, LIVE_DRAIN);

    await expect(messaging.holdRowsForCheckpoint(ctx)).rejects.toBeInstanceOf(
      BufferedRowsNotStoredError
    );
    (await messaging.holdRowsForCheckpoint(ctx))();
    expect(storedIds(saveMessage)).toEqual(['in-8']);
  });

  it('builds ONE observer whose hold is the messaging hold (the wiring a page cannot half-do)', async () => {
    const messaging = useMessaging();
    const { ctx, saveMessage } = makeContext();
    const observer = messaging.bulkIngestObserver(() => ctx);

    observer.onBulkIngestStart(LIVE_DRAIN);
    await messaging.addMessageToChat(PEER, 'via the observer', CONVO, ctx, { messageId: 'in-9' });
    (await observer.holdRowsForCheckpoint())();
    expect(storedIds(saveMessage)).toEqual(['in-9']);
    await observer.onBulkIngestEnd(LIVE_DRAIN);
  });

  /**
   * A RETRIED WRITE SETTLES WHAT ARRIVED WHILE ITS ROW WAS UNSTORED (re-review of #3786, P2). An edit
   * that meets a shown-and-not-stored row is kept "for its write" (`settlePendingFor`); the retry
   * stored the old snapshot and settled nothing, so the edit was lost at rest.
   */
  it('a retried write carries an edit that arrived after the failed write', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const messaging = useMessaging();
    const { ctx } = makeContext();
    const saved = new Map<string, Record<string, unknown>>();
    let pending: unknown[] = [];
    const storage = ctx.storage as unknown as Record<string, ReturnType<typeof vi.fn>>;
    storage.saveMessagesIfAbsent
      .mockRejectedValueOnce(new Error('QuotaExceededError'))
      .mockRejectedValueOnce(new Error('QuotaExceededError'))
      .mockImplementation(async (rows: Array<{ id: string }>) => {
        for (const row of rows) saved.set(row.id, { ...row });
        return new Set(rows.map((row) => row.id));
      });
    storage.getMessagesByIds.mockImplementation(async (_c: string, ids: string[]) => ({
      rows: new Map(ids.filter((id) => saved.has(id)).map((id) => [id, saved.get(id)])),
      unreadable: new Set(),
    }));
    storage.mergeMessages.mockImplementation(
      async (_c: string, ids: string[], merge: (row: unknown) => unknown) => {
        for (const id of ids) {
          const next = saved.has(id) ? merge(saved.get(id)) : null;
          if (next) saved.set(id, next as Record<string, unknown>);
        }
        return new Set(ids);
      }
    );
    storage.getPendingMutations.mockImplementation(async () => ({
      entries: pending,
      removedUnreadable: 0,
    }));
    storage.deletePendingMutations = vi.fn(async () => {
      pending = [];
    });

    messaging.beginBulkMessageIngest(LIVE_DRAIN);
    const body = serializeEnvelope(mkTextEnvelope('before the edit'));
    await messaging.addMessageToChat(PEER, body, CONVO, ctx, { messageId: 'in-10' });
    await expect(messaging.holdRowsForCheckpoint(ctx)).rejects.toBeInstanceOf(
      BufferedRowsNotStoredError
    );

    // The author's edit arrives while the row is shown and not stored: kept for its write.
    pending = [
      {
        conversationId: CONVO,
        messageId: 'in-10',
        sender: PEER,
        kind: 'edit',
        slot: '',
        rank: Date.now(),
        at: Date.now(),
        text: 'after the edit',
      },
    ];

    (await messaging.holdRowsForCheckpoint(ctx))();
    expect(envelopeBodyText(String(saved.get('in-10')?.content))).toBe('after the edit');
    expect(saved.get('in-10')?.isEdited).toBe(true);
    expect(storage.deletePendingMutations).toHaveBeenCalled();
  });

  it('drops a failed write whose conversation left the map, instead of bringing its rows back', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const messaging = useMessaging();
    const { ctx, conversations, saveMessage } = makeContext();
    const storage = ctx.storage as unknown as Record<string, ReturnType<typeof vi.fn>>;
    storage.saveMessagesIfAbsent
      .mockRejectedValueOnce(new Error('AbortError'))
      .mockRejectedValueOnce(new Error('AbortError'));

    messaging.beginBulkMessageIngest(LIVE_DRAIN);
    await messaging.addMessageToChat(PEER, 'doomed', CONVO, ctx, { messageId: 'in-11' });
    await expect(messaging.holdRowsForCheckpoint(ctx)).rejects.toBeInstanceOf(
      BufferedRowsNotStoredError
    );

    // The conversation is deleted locally: nothing of it is written back.
    conversations.delete(CONVO);
    (await messaging.holdRowsForCheckpoint(ctx))();
    expect(storedIds(saveMessage)).toEqual([]);
  });

  it('says a recurring failure ONCE per write, and once per retry in one line', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const messaging = useMessaging();
    const { ctx, conversations } = makeContext();
    conversations.set('other', {
      id: 'other',
      name: 'other',
      messages: [],
      unreadCount: 0,
      lastMessageAt: 0,
    } as never);
    const storage = ctx.storage as unknown as Record<string, ReturnType<typeof vi.fn>>;
    storage.saveMessagesIfAbsent.mockRejectedValue(new Error('QuotaExceededError'));

    messaging.beginBulkMessageIngest(LIVE_DRAIN);
    await messaging.addMessageToChat(PEER, 'a', CONVO, ctx, { messageId: 'in-12' });
    await messaging.addMessageToChat(PEER, 'b', 'other', ctx, { messageId: 'in-13' });
    for (let i = 0; i < 3; i++) {
      await expect(messaging.holdRowsForCheckpoint(ctx)).rejects.toBeInstanceOf(
        BufferedRowsNotStoredError
      );
    }
    const lines = errors.mock.calls.map((call) => String(call[0]));
    // Each write's own failure once - two conversations, two writes - however many holds retry it.
    expect(lines.filter((l) => l.startsWith('[DB] batchAddMessages failed'))).toHaveLength(2);
    // One combined line per retry, whatever the number of writes.
    expect(lines.filter((l) => l.startsWith('[DB] Retry of'))).toHaveLength(3);
    // The cause of every refusal named once per session.
    expect(lines.filter((l) => l.includes('every checkpoint is refused'))).toHaveLength(1);
  });

  /**
   * ONE EXCEPTION MUST NOT POISON THE STORE CHAIN (re-review of #3786, P2). A step that threw left
   * the chain rejected: every later hold and close rejected for the rest of the page, and the hold's
   * counter never came down, so buffering stayed off.
   */
  it('a step that throws costs one store: the next hold and close still work, buffering comes back', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const messaging = useMessaging();
    const { ctx, conversations, saveMessage } = makeContext();
    const storage = ctx.storage as unknown as Record<string, ReturnType<typeof vi.fn>>;
    storage.saveMessagesIfAbsent
      .mockRejectedValueOnce(new Error('AbortError'))
      .mockRejectedValueOnce(new Error('AbortError'));

    messaging.beginBulkMessageIngest(LIVE_DRAIN);
    await messaging.addMessageToChat(PEER, 'kept', CONVO, ctx, { messageId: 'in-14' });
    await expect(messaging.holdRowsForCheckpoint(ctx)).rejects.toBeInstanceOf(
      BufferedRowsNotStoredError
    );

    // The next step meets an exception where nothing expected one.
    const has = conversations.has.bind(conversations);
    const get = conversations.get.bind(conversations);
    let armed = true;
    const trap = () => {
      if (!armed) return;
      armed = false;
      throw new Error('unexpected');
    };
    conversations.has = (key: string) => (trap(), has(key));
    conversations.get = (key: string) => (trap(), get(key));
    await expect(messaging.holdRowsForCheckpoint(ctx)).rejects.toThrow();

    // The chain is whole: this hold stores the kept row and resolves.
    (await messaging.holdRowsForCheckpoint(ctx))();
    expect(storedIds(saveMessage)).toEqual(['in-14']);
    // Every hold was given back: a message buffers again, and the close stores it.
    await messaging.addMessageToChat(PEER, 'after', CONVO, ctx, { messageId: 'in-15' });
    expect(storedIds(saveMessage)).toEqual(['in-14']);
    await messaging.endBulkMessageIngest(ctx, LIVE_DRAIN);
    expect(storedIds(saveMessage)).toEqual(['in-14', 'in-15']);
  });

  it('a batch that THROWS at a window close is kept, and the next hold stores it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const messaging = useMessaging();
    const { ctx, conversations, saveMessage } = makeContext();

    messaging.beginBulkMessageIngest(LIVE_DRAIN);
    await messaging.addMessageToChat(PEER, 'closing', CONVO, ctx, { messageId: 'in-16' });
    const get = conversations.get.bind(conversations);
    let armed = true;
    conversations.get = (key: string) => {
      if (armed) {
        armed = false;
        throw new Error('unexpected');
      }
      return get(key);
    };
    await messaging.endBulkMessageIngest(ctx, LIVE_DRAIN);
    expect(storedIds(saveMessage)).toEqual([]);

    (await messaging.holdRowsForCheckpoint(ctx))();
    expect(storedIds(saveMessage)).toEqual(['in-16']);
  });

  it('a 1:1 re-keyed onto the group it joined keeps its unstored rows, written under the new key', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const messaging = useMessaging();
    const { ctx, conversations, saveMessage } = makeContext();
    const storage = ctx.storage as unknown as Record<string, ReturnType<typeof vi.fn>>;
    storage.saveMessagesIfAbsent
      .mockRejectedValueOnce(new Error('AbortError'))
      .mockRejectedValueOnce(new Error('AbortError'));

    messaging.beginBulkMessageIngest(LIVE_DRAIN);
    await messaging.addMessageToChat(PEER, 'moving', CONVO, ctx, { messageId: 'in-17' });
    await expect(messaging.holdRowsForCheckpoint(ctx)).rejects.toBeInstanceOf(
      BufferedRowsNotStoredError
    );

    // The Welcome's re-key: the thread moves, with the rows it shows, under the joined group's id.
    const thread = conversations.get(CONVO)!;
    conversations.delete(CONVO);
    conversations.set('joined-group', { ...thread, id: 'joined-group' });

    (await messaging.holdRowsForCheckpoint(ctx))();
    const row = saveMessage.mock.calls.map(([r]) => r as { id: string; conversationId: string });
    expect(row).toEqual([expect.objectContaining({ id: 'in-17', conversationId: 'joined-group' })]);
  });
});
