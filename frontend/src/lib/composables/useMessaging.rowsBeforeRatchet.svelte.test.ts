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
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
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

/** The poison metric is read by the tests that must - or must not - count a dropped row. */
vi.mock('$lib/mls-client/mlsRecoveryMetrics', () => ({ logMlsMetric: vi.fn() }));

const { useMessaging, BufferedRowsNotStoredError } = await import('./useMessaging.svelte');
const { logMlsMetric } = await import('$lib/mls-client/mlsRecoveryMetrics');
const { RowRefusedError } = await import('$lib/db/rowWriteFailure');
const { notificationPreferences } = await import('$lib/stores/notificationPreferences.svelte');
const { keepPendingMutation } = await import('$lib/utils/chat/pendingMutationStore');
type MessagingContext = import('./useMessaging.svelte').MessagingContext;
import type { Conversation } from '$lib/types';
import type { PendingMutation } from '$lib/db/types';
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

  it('THE LIVE PATH: a row whose write failed outside any window is kept, refuses the hold, and the next hold stores it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const messaging = useMessaging();
    const { ctx, conversations, saveMessage } = makeContext();
    const saveMessagesIfAbsent = (
      ctx.storage as unknown as { saveMessagesIfAbsent: ReturnType<typeof vi.fn> }
    ).saveMessagesIfAbsent;
    // The live write and the first hold's retry fail; the second hold's retry lands.
    saveMessagesIfAbsent
      .mockRejectedValueOnce(new DOMException('full', 'QuotaExceededError'))
      .mockRejectedValueOnce(new DOMException('full', 'QuotaExceededError'));
    const observer = messaging.bulkIngestObserver(() => ctx);

    // No window open: the ordinary path, whose handler writes the row itself.
    await messaging.addMessageToChat(PEER, 'live', CONVO, ctx, {
      messageId: 'in-live',
      frameId: 'q-live',
    });
    expect(idsIn(conversations)).toEqual(['in-live']);
    expect(storedIds(saveMessage)).toEqual([]);
    // What an application frame's ack reads before it deletes the server's copy: THIS frame.
    expect([...observer.framesLeftUnstored()]).toEqual(['q-live']);

    await expect(messaging.holdRowsForCheckpoint(ctx)).rejects.toBeInstanceOf(
      BufferedRowsNotStoredError
    );
    (await messaging.holdRowsForCheckpoint(ctx))();
    expect(storedIds(saveMessage)).toEqual(['in-live']);
    expect(observer.framesLeftUnstored().size).toBe(0);
  });

  it('names the frames of the rows a window close could not store, for the ack, and none once a hold stored them', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const messaging = useMessaging();
    const { ctx } = makeContext();
    const saveMessagesIfAbsent = (
      ctx.storage as unknown as { saveMessagesIfAbsent: ReturnType<typeof vi.fn> }
    ).saveMessagesIfAbsent;
    saveMessagesIfAbsent.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'));
    const observer = messaging.bulkIngestObserver(() => ctx);

    observer.onBulkIngestStart(LIVE_DRAIN);
    await messaging.addMessageToChat(PEER, 'a', CONVO, ctx, { messageId: 'in-a', frameId: 'q-a' });
    await messaging.addMessageToChat(PEER, 'b', CONVO, ctx, { messageId: 'in-b', frameId: 'q-b' });
    expect(observer.framesLeftUnstored().size).toBe(0);
    await observer.onBulkIngestEnd(LIVE_DRAIN);
    expect([...observer.framesLeftUnstored()].sort()).toEqual(['q-a', 'q-b']);

    (await observer.holdRowsForCheckpoint())();
    expect(observer.framesLeftUnstored().size).toBe(0);
  });

  /**
   * PER FRAME (review of #3851, SF-1): a page-wide count let one unstored row withhold the ack of
   * every frame of every conversation. Only the frame whose row is unstored waits.
   */
  it('PER FRAME: a row left unstored names ITS frame only - a row of another conversation stored meanwhile withholds nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const messaging = useMessaging();
    const { ctx, conversations } = makeContext();
    conversations.set('other-conversation', {
      id: 'other-conversation',
      name: 'other',
      messages: [],
      unreadCount: 0,
      lastMessageAt: 0,
    } as never);
    const saveMessagesIfAbsent = (
      ctx.storage as unknown as { saveMessagesIfAbsent: ReturnType<typeof vi.fn> }
    ).saveMessagesIfAbsent;
    saveMessagesIfAbsent.mockRejectedValueOnce(new DOMException('full', 'QuotaExceededError'));
    const observer = messaging.bulkIngestObserver(() => ctx);

    await messaging.addMessageToChat(PEER, 'stuck', CONVO, ctx, {
      messageId: 'in-stuck',
      frameId: 'q-stuck',
    });
    await messaging.addMessageToChat(PEER, 'fine', 'other-conversation', ctx, {
      messageId: 'in-fine',
      frameId: 'q-fine',
    });

    expect([...observer.framesLeftUnstored()]).toEqual(['q-stuck']);
  });

  /**
   * A POISON ROW IS DROPPED, NEVER KEPT (review of #3851, SF-1): a row the store refuses for what it
   * IS fails the same way at every retry and after every reload, so keeping it refused every
   * checkpoint - commits and joins included - and withheld its frame for good.
   */
  it('POISON: a row the store refused at its own request (RowRefusedError, DataError) is dropped at ERROR - the hold is not refused and its frame is acknowledged', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(logMlsMetric).mockClear();
    const messaging = useMessaging();
    const { ctx, conversations } = makeContext();
    const saveMessagesIfAbsent = (
      ctx.storage as unknown as { saveMessagesIfAbsent: ReturnType<typeof vi.fn> }
    ).saveMessagesIfAbsent;
    saveMessagesIfAbsent.mockRejectedValueOnce(
      new RowRefusedError('in-poison', new DOMException('bad key', 'DataError'))
    );
    const observer = messaging.bulkIngestObserver(() => ctx);

    await messaging.addMessageToChat(PEER, 'poison', CONVO, ctx, {
      messageId: 'in-poison',
      frameId: 'q-poison',
    });

    // Shown, not kept: the frame's ack goes out and the checkpoint is not refused.
    expect(idsIn(conversations)).toEqual(['in-poison']);
    expect(observer.framesLeftUnstored().size).toBe(0);
    (await messaging.holdRowsForCheckpoint(ctx))();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('POISON ROW'), expect.anything());
    // Tried once: a poison row is never retried.
    expect(saveMessagesIfAbsent).toHaveBeenCalledTimes(1);
    expect(logMlsMetric).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'row_write_poison', errorName: 'DataError' })
    );
  });

  /**
   * CLASSIFIED AT THE THROW, NOT BY NAME (second review of #3851, SF-B): `crypto.subtle.importKey`
   * raises `DataError` for an empty device key, which sign-in paths hand the store on purpose. Read by
   * name it was poison: every row of the page dropped and its frame acknowledged - the messages lost.
   */
  it('a BARE DataError (a key import with an empty device key) is transient: the row is KEPT, its frame withheld, nothing dropped', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(logMlsMetric).mockClear();
    const messaging = useMessaging();
    const { ctx, saveMessage } = makeContext();
    const saveMessagesIfAbsent = (
      ctx.storage as unknown as { saveMessagesIfAbsent: ReturnType<typeof vi.fn> }
    ).saveMessagesIfAbsent;
    saveMessagesIfAbsent.mockRejectedValueOnce(new DOMException('empty key', 'DataError'));
    const observer = messaging.bulkIngestObserver(() => ctx);

    await messaging.addMessageToChat(PEER, 'sealed later', CONVO, ctx, {
      messageId: 'in-key',
      frameId: 'q-key',
    });

    expect([...observer.framesLeftUnstored()]).toEqual(['q-key']);
    expect(error).not.toHaveBeenCalledWith(
      expect.stringContaining('POISON ROW'),
      expect.anything()
    );
    expect(logMlsMetric).not.toHaveBeenCalled();
    // The key is there at the next hold: the kept row is stored.
    (await messaging.holdRowsForCheckpoint(ctx))();
    expect(storedIds(saveMessage)).toEqual(['in-key']);
  });

  it('a DataCloneError on the CONVERSATION row blames no message row that landed: no POISON line, no metric, the write kept', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(logMlsMetric).mockClear();
    const messaging = useMessaging();
    const { ctx, saveMessage } = makeContext();
    (ctx.saveConversation as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new DOMException('cannot clone', 'DataCloneError')
    );
    const observer = messaging.bulkIngestObserver(() => ctx);

    await messaging.addMessageToChat(PEER, 'landed', CONVO, ctx, {
      messageId: 'in-landed',
      frameId: 'q-landed',
    });

    // The message row landed; the conversation row did not, so the write is kept - and its frame.
    expect(storedIds(saveMessage)).toEqual(['in-landed']);
    expect([...observer.framesLeftUnstored()]).toEqual(['q-landed']);
    expect(error).not.toHaveBeenCalledWith(
      expect.stringContaining('POISON ROW'),
      expect.anything()
    );
    expect(logMlsMetric).not.toHaveBeenCalled();
  });

  /**
   * SF-C (second review of #3851): a dispatch that threw was not acknowledged, but the next
   * checkpoint still exported its spent generation - the frame left on the server could then never
   * be decrypted. The message is kept, with its frame, for the checkpoint's hold to write.
   */
  /**
   * THE ROW BEFORE ANY EFFECT THAT MAY THROW (third review of #3851, SF-1): the notification ran
   * between the render and the write, so its throw left the message on screen and off the disk; the
   * kept rerun met it in memory, called it stored, and the frame was acknowledged.
   */
  it('a NOTIFICATION that throws costs nothing: the row is stored before it runs, the add resolves, no frame is withheld', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const messaging = useMessaging();
    const { ctx, saveMessage } = makeContext();
    let storedWhenNotified: string[] | null = null;
    // The node environment has no document, and `notifyInbound` asks nothing without one: a page
    // put away, so the arrival is news.
    vi.stubGlobal('document', { visibilityState: 'hidden', hidden: true, hasFocus: () => false });
    vi.stubGlobal('window', {
      location: { pathname: '/chat' },
      matchMedia: () => ({ matches: false }),
    });
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    vi.spyOn(notificationPreferences, 'pushAllowed').mockImplementation(() => {
      storedWhenNotified = storedIds(saveMessage);
      throw new Error('notification store torn down');
    });
    const observer = messaging.bulkIngestObserver(() => ctx);

    await messaging.addMessageToChat(PEER, 'notified', CONVO, ctx, {
      messageId: 'in-notified',
      frameId: 'q-notified',
    });

    expect(storedWhenNotified).toEqual(['in-notified']);
    expect(storedIds(saveMessage)).toEqual(['in-notified']);
    expect(observer.framesLeftUnstored().size).toBe(0);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('notifying the arrival threw'),
      expect.anything()
    );
  });

  it('a kept live add is rerun by the STORE, not memory: a row shown and not stored is written, one shown and stored is not', async () => {
    const messaging = useMessaging();
    const { ctx, conversations, saveMessage } = makeContext();
    const shown = (id: string) => ({
      id,
      senderId: PEER,
      content: id,
      timestamp: new Date(1_700_000_000_000),
      isOwn: false,
    });
    conversations.set(CONVO, {
      ...conversations.get(CONVO)!,
      messages: [shown('in-memory-only'), shown('in-both')] as never,
    });
    const getMessagesByIds = (
      ctx.storage as unknown as { getMessagesByIds: ReturnType<typeof vi.fn> }
    ).getMessagesByIds;
    getMessagesByIds.mockImplementation(async (_key: string, ids: string[]) => ({
      rows: new Map(
        ids
          .filter((id) => id === 'in-both')
          .map((id) => [id, { ...shown(id), conversationId: CONVO, timestamp: 1_700_000_000_000 }])
      ),
      unreadable: new Set(),
    }));
    const batch = ['in-memory-only', 'in-both'].map((id) => ({
      senderId: PEER,
      content: id,
      messageId: id,
      frameId: `q-${id}`,
    }));

    // Memory decides (an ordinary batch): both are shown, so both are called held.
    await messaging.batchAddMessages(batch, CONVO, ctx, 'arrival');
    expect(storedIds(saveMessage)).toEqual([]);

    // The store decides (the rerun of a live add that threw).
    await messaging.batchAddMessages(batch, CONVO, ctx, 'arrival', { storeDecides: true });
    expect(storedIds(saveMessage)).toEqual(['in-memory-only']);
  });

  it('a store-decided rerun shows the row as it WROTE it: what waited for it is settled onto the screen too, and nothing is announced', async () => {
    const messaging = useMessaging();
    const { ctx, conversations, saveMessage } = makeContext();
    conversations.set(CONVO, {
      ...conversations.get(CONVO)!,
      messages: [
        {
          id: 'in-memory-only',
          senderId: PEER,
          content: serializeEnvelope(mkTextEnvelope('said')),
          timestamp: new Date(1_700_000_000_000),
          isOwn: false,
        },
      ] as never,
    });
    const storage = ctx.storage as unknown as Record<string, ReturnType<typeof vi.fn>>;
    // Its author deleted it while it stood shown and not stored: the deletion waits for it - read
    // once, by the batch, and consumed by its write (the look after the write finds none).
    storage.getPendingMutations.mockResolvedValueOnce({
      entries: [
        {
          conversationId: CONVO,
          messageId: 'in-memory-only',
          sender: PEER,
          kind: 'delete',
          slot: '',
          rank: 0,
          at: 1_700_000_001_000,
        },
      ],
      removedUnreadable: 0,
    });
    const publish = vi.spyOn(ctx, 'playReceiveTone' as never);

    await messaging.batchAddMessages(
      [
        {
          senderId: PEER,
          content: serializeEnvelope(mkTextEnvelope('said')),
          messageId: 'in-memory-only',
        },
      ],
      CONVO,
      ctx,
      'arrival',
      { storeDecides: true }
    );

    expect(storedIds(saveMessage)).toEqual(['in-memory-only']);
    expect(saveMessage.mock.calls[0][0]).toEqual(expect.objectContaining({ isDeleted: true }));
    const shown = conversations.get(CONVO)!.messages.find((m) => m.id === 'in-memory-only')!;
    expect(shown.isDeleted).toBe(true);
    expect(publish).not.toHaveBeenCalled();
    expect(ctx.sendSystemNotification).not.toHaveBeenCalled();
  });

  /**
   * AGAINST THE ROW SHOWN NOW (fifth review of #3851): the batch decided what to show from the
   * snapshot it read before its awaits, so a live edit landing meanwhile was overwritten by the older
   * body until the settle after the write repaired it - a race that healed, which is still a defect.
   */
  it('a live EDIT landing during the batch is never overwritten by the pre-edit body it read', async () => {
    const messaging = useMessaging();
    const { ctx, conversations } = makeContext();
    const before = {
      id: 'in-memory-only',
      senderId: PEER,
      content: serializeEnvelope(mkTextEnvelope('said')),
      timestamp: new Date(1_700_000_000_000),
      isOwn: false,
    };
    conversations.set(CONVO, { ...conversations.get(CONVO)!, messages: [before] as never });
    const edited = 'said, then edited';
    const storage = ctx.storage as unknown as Record<string, ReturnType<typeof vi.fn>>;
    // A reaction waited for the row; the batch reads it - and while it awaits that read, the
    // author's live edit lands on the screen.
    storage.getPendingMutations.mockImplementationOnce(async () => {
      const convo = conversations.get(CONVO)!;
      conversations.set(CONVO, {
        ...convo,
        messages: [
          { ...before, content: serializeEnvelope(mkTextEnvelope(edited)), isEdited: true },
        ] as never,
      });
      return {
        entries: [
          {
            conversationId: CONVO,
            messageId: 'in-memory-only',
            sender: 'someone',
            kind: 'reaction',
            slot: '👍',
            rank: 1_700_000_002_000,
            at: 1_700_000_002_000,
          },
        ],
        removedUnreadable: 0,
      };
    });
    const shownAfterEdit: string[] = [];
    const set = conversations.set.bind(conversations);
    vi.spyOn(conversations, 'set').mockImplementation((key, value) => {
      const row = value.messages.find((m) => m.id === 'in-memory-only');
      if (row) shownAfterEdit.push(envelopeBodyText(row.content));
      return set(key, value);
    });

    await messaging.batchAddMessages(
      [{ senderId: PEER, content: before.content, messageId: 'in-memory-only' }],
      CONVO,
      ctx,
      'arrival',
      { storeDecides: true }
    );

    expect(shownAfterEdit.length).toBeGreaterThan(0);
    expect(shownAfterEdit.every((body) => body === edited)).toBe(true);
    const shown = conversations.get(CONVO)!.messages.find((m) => m.id === 'in-memory-only')!;
    expect(shown.reactions).toEqual([expect.objectContaining({ emoji: '👍' })]);
  });

  it('an inbound add that THREW keeps the message with its frame: rethrown, withheld, and the next hold writes it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const messaging = useMessaging();
    const { ctx, conversations, saveMessage } = makeContext();
    const realGet = conversations.get.bind(conversations);
    let thrown = false;
    vi.spyOn(conversations, 'get').mockImplementation((key: string) => {
      if (!thrown) {
        thrown = true;
        throw new Error('map torn down');
      }
      return realGet(key);
    });
    const observer = messaging.bulkIngestObserver(() => ctx);

    await expect(
      messaging.addMessageToChat(PEER, 'thrown', CONVO, ctx, {
        messageId: 'in-thrown',
        frameId: 'q-thrown',
      })
    ).rejects.toThrow('map torn down');

    expect([...observer.framesLeftUnstored()]).toEqual(['q-thrown']);
    (await messaging.holdRowsForCheckpoint(ctx))();
    expect(storedIds(saveMessage)).toEqual(['in-thrown']);
    expect(observer.framesLeftUnstored().size).toBe(0);
  });

  it('a Welcome-replayed or bundle row (the batch path) whose write fails transiently withholds ITS frame', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const messaging = useMessaging();
    const { ctx } = makeContext();
    const saveMessagesIfAbsent = (
      ctx.storage as unknown as { saveMessagesIfAbsent: ReturnType<typeof vi.fn> }
    ).saveMessagesIfAbsent;
    // The batch's write and the hold's one retry of it both fail.
    saveMessagesIfAbsent
      .mockRejectedValueOnce(new DOMException('full', 'QuotaExceededError'))
      .mockRejectedValueOnce(new DOMException('full', 'QuotaExceededError'));
    const observer = messaging.bulkIngestObserver(() => ctx);

    // What `handleWelcome`'s replay hands the batch path, stamped by `framedRowWriters`.
    await messaging.batchAddMessages(
      [{ senderId: PEER, content: 'replayed', messageId: 'in-replay', frameId: 'q-replay' }],
      CONVO,
      ctx,
      'arrival'
    );

    expect([...observer.framesLeftUnstored()]).toEqual(['q-replay']);
    await expect(messaging.holdRowsForCheckpoint(ctx)).rejects.toBeInstanceOf(
      BufferedRowsNotStoredError
    );
  });

  it('POISON IN A BATCH: the rows are written one by one - the good one is stored, the poison one dropped, nothing kept', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const messaging = useMessaging();
    const { ctx, saveMessage } = makeContext();
    const saveMessagesIfAbsent = (
      ctx.storage as unknown as { saveMessagesIfAbsent: ReturnType<typeof vi.fn> }
    ).saveMessagesIfAbsent;
    const realSave = saveMessagesIfAbsent.getMockImplementation() as (
      rows: { id: string }[],
      key: string
    ) => Promise<Set<string>>;
    // Any write holding the poison row is refused for it, as the store raises at that row's `add`.
    saveMessagesIfAbsent.mockImplementation(async (rows: { id: string }[], key: string) => {
      if (rows.some((row) => row.id === 'in-bad')) {
        throw new RowRefusedError('in-bad', new DOMException('cannot clone', 'DataCloneError'));
      }
      return realSave(rows, key);
    });
    const observer = messaging.bulkIngestObserver(() => ctx);

    observer.onBulkIngestStart(LIVE_DRAIN);
    await messaging.addMessageToChat(PEER, 'good', CONVO, ctx, {
      messageId: 'in-good',
      frameId: 'q-good',
    });
    await messaging.addMessageToChat(PEER, 'bad', CONVO, ctx, {
      messageId: 'in-bad',
      frameId: 'q-bad',
    });
    await observer.onBulkIngestEnd(LIVE_DRAIN);

    expect(storedIds(saveMessage)).toEqual(['in-good']);
    expect(observer.framesLeftUnstored().size).toBe(0);
    (await messaging.holdRowsForCheckpoint(ctx))();
  });

  /**
   * SF-2 (review of #3851): the two upgrade writes of the live path caught, logged and went on, so
   * the frame was acknowledged while the stored row was still the notification's caption.
   */
  it('THE SHOWN-PREVIEW UPGRADE: a failed write is kept - it names its frame, refuses the hold, and the next hold stores it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const messaging = useMessaging();
    const { ctx, conversations } = makeContext();
    conversations.set(CONVO, {
      id: CONVO,
      name: CONVO,
      messages: [
        {
          id: 'in-up',
          senderId: PEER,
          content: 'caption from the push',
          timestamp: new Date(1_700_000_000_000),
          isOwn: false,
          isFcmPreview: true,
        },
      ],
      unreadCount: 0,
      lastMessageAt: 0,
    } as never);
    const storage = ctx.storage as unknown as Record<string, ReturnType<typeof vi.fn>>;
    storage.mergeMessages
      .mockRejectedValueOnce(new DOMException('full', 'QuotaExceededError'))
      .mockRejectedValueOnce(new DOMException('full', 'QuotaExceededError'));
    const observer = messaging.bulkIngestObserver(() => ctx);

    const body = serializeEnvelope(mkTextEnvelope('the body'));
    await messaging.addMessageToChat(PEER, body, CONVO, ctx, {
      messageId: 'in-up',
      frameId: 'q-up',
    });

    expect([...observer.framesLeftUnstored()]).toEqual(['q-up']);
    await expect(messaging.holdRowsForCheckpoint(ctx)).rejects.toBeInstanceOf(
      BufferedRowsNotStoredError
    );
    (await messaging.holdRowsForCheckpoint(ctx))();
    expect(observer.framesLeftUnstored().size).toBe(0);
  });

  it('THE STORED-PREVIEW UPGRADE: a failed write is kept - it names its frame and refuses the hold', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const messaging = useMessaging();
    const { ctx } = makeContext();
    const storage = ctx.storage as unknown as Record<string, ReturnType<typeof vi.fn>>;
    // The row is in the store as a push preview, and not shown.
    storage.getMessagesByIds.mockImplementation(async (_c: string, ids: string[]) => ({
      rows: new Map(
        ids
          .filter((id) => id === 'in-stored')
          .map((id) => [
            id,
            {
              id,
              conversationId: CONVO,
              senderId: PEER,
              content: 'caption from the push',
              timestamp: 1_700_000_000_000,
              isFcmPreview: true,
            },
          ])
      ),
      unreadable: new Set(),
    }));
    storage.mergeMessages.mockRejectedValue(new DOMException('full', 'QuotaExceededError'));
    const observer = messaging.bulkIngestObserver(() => ctx);

    const body = serializeEnvelope(mkTextEnvelope('the body'));
    await messaging.addMessageToChat(PEER, body, CONVO, ctx, {
      messageId: 'in-stored',
      frameId: 'q-stored',
    });

    expect([...observer.framesLeftUnstored()]).toEqual(['q-stored']);
    await expect(messaging.holdRowsForCheckpoint(ctx)).rejects.toBeInstanceOf(
      BufferedRowsNotStoredError
    );
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

  /** One `conversations.get` that throws the first `times` times it is asked for `key`. */
  function trapGet(conversations: SvelteMap<string, Conversation>, key: string, times: number) {
    const get = conversations.get.bind(conversations);
    let left = times;
    conversations.get = (k: string) => {
      if (k === key && left > 0) {
        left -= 1;
        throw new Error('unexpected');
      }
      return get(k);
    };
  }

  it('a batch kept at a window close is replayed at the NEXT close, without waiting for a checkpoint', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const messaging = useMessaging();
    const { ctx, conversations, saveMessage } = makeContext();

    messaging.beginBulkMessageIngest(LIVE_DRAIN);
    await messaging.addMessageToChat(PEER, 'first window', CONVO, ctx, { messageId: 'in-18' });
    trapGet(conversations, CONVO, 1);
    await messaging.endBulkMessageIngest(ctx, LIVE_DRAIN);
    expect(storedIds(saveMessage)).toEqual([]);

    messaging.beginBulkMessageIngest(LIVE_DRAIN);
    await messaging.endBulkMessageIngest(ctx, LIVE_DRAIN);
    expect(storedIds(saveMessage)).toEqual(['in-18']);
    expect(idsIn(conversations)).toEqual(['in-18']);
  });

  it('a kept batch follows its thread when the 1:1 is re-keyed onto the group it joined', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const messaging = useMessaging();
    const { ctx, conversations, saveMessage } = makeContext();
    // A message already shown in the thread, outside any window.
    await messaging.addMessageToChat(PEER, 'shown before', CONVO, ctx, { messageId: 'in-19' });

    messaging.beginBulkMessageIngest(LIVE_DRAIN);
    await messaging.addMessageToChat(PEER, 'kept', CONVO, ctx, { messageId: 'in-20' });
    trapGet(conversations, CONVO, 1);
    await messaging.endBulkMessageIngest(ctx, LIVE_DRAIN);

    // The Welcome's re-key moves the thread, and what it shows, under the joined group's id.
    const thread = conversations.get(CONVO)!;
    conversations.delete(CONVO);
    conversations.set('joined-group', { ...thread, id: 'joined-group' });

    (await messaging.holdRowsForCheckpoint(ctx))();
    const rows = saveMessage.mock.calls.map(([r]) => r as { id: string; conversationId: string });
    expect(rows).toContainEqual(
      expect.objectContaining({ id: 'in-20', conversationId: 'joined-group' })
    );
  });

  it('an always-throwing kept batch says its error ONCE, and the refusal counts its messages', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const messaging = useMessaging();
    const { ctx, conversations } = makeContext();

    messaging.beginBulkMessageIngest(LIVE_DRAIN);
    await messaging.addMessageToChat(PEER, 'doomed', CONVO, ctx, { messageId: 'in-21' });
    trapGet(conversations, CONVO, 1000);
    for (let i = 0; i < 3; i++) {
      const refusal = await messaging.holdRowsForCheckpoint(ctx).catch((e: unknown) => e);
      expect(refusal).toBeInstanceOf(BufferedRowsNotStoredError);
      expect((refusal as InstanceType<typeof BufferedRowsNotStoredError>).rows).toBe(1);
    }
    const lines = errors.mock.calls.map((call) => String(call[0]));
    expect(lines.filter((l) => l.includes('threw'))).toHaveLength(1);
  });
});

/**
 * A MUTATION PARKED AGAINST A ROW THAT STANDS IS RETRIED BY THE HOLD (third review of #3851, SF-3):
 * its frame is acknowledged and its row is never written again, so before this nothing drained the
 * parked entry - the act's only copy - until a reload happened to look.
 */
describe('a mutation parked against a stored row (rows before ratchet)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  /** A store holding row `m1` and a real list of parked entries; its merge fails while `refuse` says. */
  function parkedWorld() {
    const { ctx } = makeContext();
    const entries: PendingMutation[] = [];
    const row = {
      id: 'm1',
      conversationId: CONVO,
      senderId: PEER,
      content: serializeEnvelope(mkTextEnvelope('original')),
      timestamp: 1_700_000_000_000,
    };
    const written: Array<Record<string, unknown>> = [];
    const state = { refuse: true };
    Object.assign(ctx.storage as object, {
      putPendingMutation: vi.fn(async (entry: PendingMutation) => {
        entries.push(entry);
        return { written: true, kept: true, evicted: 0 };
      }),
      getPendingMutations: vi.fn(async (_c: string, ids: string[]) => ({
        entries: entries.filter((e) => ids.includes(e.messageId)),
        removedUnreadable: 0,
      })),
      deletePendingMutations: vi.fn(async (gone: PendingMutation[]) => {
        for (const e of gone) entries.splice(entries.indexOf(e), 1);
      }),
      getMessagesByIds: vi.fn(async (_c: string, ids: string[]) => ({
        rows: new Map(ids.includes('m1') ? [['m1', row]] : []),
        unreadable: new Set(),
      })),
      mergeMessages: vi.fn(
        async (
          _c: string,
          _ids: string[],
          merge: (r: typeof row) => Record<string, unknown> | null
        ) => {
          if (state.refuse) throw new DOMException('full', 'QuotaExceededError');
          const next = merge(row);
          if (next) written.push(next);
          return new Set(['m1']);
        }
      ),
    });
    const deps = {
      storage: ctx.storage,
      deviceKey: () => 'device-key',
      conversations: ctx.conversations,
      messageReactions: new SvelteMap(),
      log: () => {},
    };
    return { ctx, entries, written, state, deps };
  }

  const edit = {
    conversationId: CONVO,
    messageId: 'm1',
    sender: PEER,
    kind: 'edit' as const,
    slot: '',
    rank: 1_700_000_002_000,
    text: 'edited',
  };

  it('an EDIT parked against a stored row lands at the next hold, and the hold then resolves', async () => {
    const messaging = useMessaging();
    const { ctx, entries, written, state, deps } = parkedWorld();
    // The edit's write onto its stored row failed: parked (its own look fails the same way).
    await keepPendingMutation(deps as never, edit, 1_700_000_001_000, 'could not be written');
    expect(entries).toHaveLength(1);
    expect(written).toHaveLength(0);

    state.refuse = false;
    (await messaging.holdRowsForCheckpoint(ctx))();

    expect(written).toEqual([expect.objectContaining({ isEdited: true })]);
    expect(envelopeBodyText(String(written[0].content))).toBe('edited');
    expect(entries).toHaveLength(0);
  });

  /**
   * NEVER A REFUSED CHECKPOINT (fourth review of #3851): the entry is durable before it is noted, so
   * refusing would protect no copy - it would only stop commits, joins and sends for the session.
   */
  it('a parked mutation whose row stands and still refuses it lets the hold through, said at ERROR once under its own cause', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const messaging = useMessaging();
    const { ctx, entries, state, deps } = parkedWorld();
    await keepPendingMutation(deps as never, edit, 1_700_000_001_000, 'could not be written');
    error.mockClear();

    (await messaging.holdRowsForCheckpoint(ctx))();
    (await messaging.holdRowsForCheckpoint(ctx))();

    expect(entries).toHaveLength(1);
    const stuckLines = error.mock.calls.filter(([line]) =>
      String(line).includes('PARKED MUTATION CANNOT BE MERGED')
    );
    expect(stuckLines).toHaveLength(1);
    expect(String(stuckLines[0][0])).toContain('(transient)');
    expect(error.mock.calls.some(([line]) => String(line).includes('Rows of applied frames'))).toBe(
      false
    );

    // Still retried: it lands once the store takes it.
    state.refuse = false;
    (await messaging.holdRowsForCheckpoint(ctx))();
    expect(entries).toHaveLength(0);
  });

  it('a target that settled and stalls AGAIN is said again: once per stall, not once per session', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const messaging = useMessaging();
    const { ctx, state, deps } = parkedWorld();
    const stuckLines = () =>
      error.mock.calls.filter(([line]) => String(line).includes('PARKED MUTATION CANNOT BE MERGED'))
        .length;

    await keepPendingMutation(deps as never, edit, 1_700_000_001_000, 'could not be written');
    (await messaging.holdRowsForCheckpoint(ctx))();
    expect(stuckLines()).toBe(1);
    state.refuse = false;
    (await messaging.holdRowsForCheckpoint(ctx))();

    // A later edit of the same row, whose write fails again.
    state.refuse = true;
    await keepPendingMutation(
      deps as never,
      { ...edit, rank: 1_700_000_003_000, text: 'edited again' },
      1_700_000_003_000,
      'could not be written'
    );
    (await messaging.holdRowsForCheckpoint(ctx))();
    expect(stuckLines()).toBe(2);

    state.refuse = false;
    (await messaging.holdRowsForCheckpoint(ctx))();
  });

  it('an entry whose message has NOT arrived does not refuse the hold: it waits for its body', async () => {
    const messaging = useMessaging();
    const { ctx, deps } = parkedWorld();
    await keepPendingMutation(
      deps as never,
      { ...edit, messageId: 'not-here-yet' },
      1_700_000_001_000
    );

    (await messaging.holdRowsForCheckpoint(ctx))();
  });
});

/**
 * THE ORPHAN WINDOW (rows before ratchet, the last one, 2026-11-20). A message whose conversation
 * is not in the map was held in memory until a Welcome drained it, outside every checkpoint's
 * hold: an export could claim its frame's ratchet advance while only memory held its row. A FRAMED
 * orphan (one decrypted from a queued frame) is now settled by the hold - stored when its
 * conversation is back, dropped and said when it was deleted or purged - and the drain is a step of
 * the store chain the hold waits on.
 */
describe('the orphan buffer (rows before ratchet)', () => {
  const ORPHAN_KEY = 'orphan-conversation';

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  /** Puts the orphan's conversation (back) in the map, as a Welcome's upsert does. */
  function admit(conversations: SvelteMap<string, Conversation>): void {
    conversations.set(ORPHAN_KEY, {
      id: ORPHAN_KEY,
      name: ORPHAN_KEY,
      messages: [],
      unreadCount: 0,
      lastMessageAt: 0,
    } as never);
  }

  it('a checkpoint does not export past a still-buffered DECRYPTED orphan: the hold stores it, and its frame is withheld until then', async () => {
    const messaging = useMessaging();
    const { ctx, conversations, saveMessage } = makeContext();
    const observer = messaging.bulkIngestObserver(() => ctx);

    // The conversation left the map while the frame's handler ran: the add meets no conversation.
    await messaging.addMessageToChat(PEER, 'orphaned', ORPHAN_KEY, ctx, {
      messageId: 'orphan-1',
      frameId: 'q-orphan',
    });
    expect(storedIds(saveMessage)).toEqual([]);
    // Shown nowhere, stored nowhere: its frame must stay on the server.
    expect([...observer.framesLeftUnstored()]).toEqual(['q-orphan']);

    // Back in the map, and no Welcome drained it: the checkpoint's hold settles it before the export.
    admit(conversations);
    const release = await observer.holdRowsForCheckpoint();

    expect(storedIds(saveMessage)).toEqual(['orphan-1']);
    expect(conversations.get(ORPHAN_KEY)?.messages.map((m) => m.id)).toEqual(['orphan-1']);
    expect(observer.framesLeftUnstored().size).toBe(0);
    release();
  });

  it('a decrypted orphan whose conversation was DELETED or purged is dropped and said - it never blocks the hold', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const messaging = useMessaging();
    const { ctx, conversations, saveMessage } = makeContext();
    const observer = messaging.bulkIngestObserver(() => ctx);

    await messaging.addMessageToChat(PEER, 'for a deleted thread', ORPHAN_KEY, ctx, {
      messageId: 'orphan-gone',
      frameId: 'q-gone',
    });

    // Two checkpoints in a row: neither is refused, and the second has nothing left to settle.
    (await observer.holdRowsForCheckpoint())();
    (await observer.holdRowsForCheckpoint())();

    expect(storedIds(saveMessage)).toEqual([]);
    expect(conversations.has(ORPHAN_KEY)).toBe(false);
    expect(observer.framesLeftUnstored().size).toBe(0);
    const dropped = warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith('[ORPHAN]') && line.includes('dropped'));
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toContain('q-gone');

    // And a Welcome for that key later finds nothing to bring back.
    admit(conversations);
    messaging.drainOrphanMessages(ORPHAN_KEY, ctx);
    (await observer.holdRowsForCheckpoint())();
    expect(storedIds(saveMessage)).toEqual([]);
  });

  it('drainOrphanMessages stores the row BEFORE a hold taken right after it releases', async () => {
    const messaging = useMessaging();
    const { ctx, conversations, saveMessage } = makeContext();
    const observer = messaging.bulkIngestObserver(() => ctx);

    // An orphan with no frame waits for its Welcome; the drain's write is held open below.
    await messaging.addMessageToChat(PEER, 'awaiting its welcome', ORPHAN_KEY, ctx, {
      messageId: 'orphan-2',
    });
    let openTheWrite: () => void = () => {};
    const writeHeld = new Promise<void>((resolve) => (openTheWrite = resolve));
    saveMessage.mockImplementationOnce(async () => {
      await writeHeld;
    });

    // The Welcome: the conversation enters the map, the orphans drain, the checkpoint follows.
    admit(conversations);
    messaging.drainOrphanMessages(ORPHAN_KEY, ctx);
    let resolved = false;
    const hold = observer.holdRowsForCheckpoint().then((release) => {
      resolved = true;
      return release;
    });

    // Let every microtask and timer turn run: the hold must still be waiting for the drain's write.
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    expect(resolved).toBe(false);

    openTheWrite();
    (await hold)();
    expect(storedIds(saveMessage)).toEqual(['orphan-2']);
  });
});
