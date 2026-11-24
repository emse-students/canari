/**
 * WP-ECHO-1: the sender's own message must never enter the bulk-ingest UI buffer.
 *
 * MLS gives no echo of your own message, so the optimistic `addMessageToChat` call is the ONLY
 * writer the sender's copy will ever get. The UI buffer sat IN FRONT of that write - it returned
 * early, so `saveMessage` never ran - and the buffer is discarded without flushing by a second
 * drain and by `resetMessageCatchupState`. A message composed during any inbound drain therefore
 * died before it was persisted: the receiver had it, the sender lost it at the next load.
 *
 * The end-to-end reproduction is a RACE - `{ bufferUi: true, showOverlay: pendingCount > 1 }` means
 * a single-message live drain buffers for the few hundred milliseconds it takes to ingest, with the
 * composer unlocked - so it is exactly the shape that passes by luck. These tests pin the rule
 * instead: the branch is entered, and the own message still lands and still persists.
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
import { createMlsServiceStub } from '../mls-client/test/fixtures/mlsServiceStub';
import { decodeAppMessage } from '../proto/codec';
import { sendVisibleNotice } from '../utils/chat/visibleNotices';

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
    selectedNow(this: { selectedContact: string | null }) {
      return this.selectedContact;
    },
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

describe('addMessageToChat during a bulk-ingest window', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it("renders and PERSISTS the sender's own message instead of buffering it", async () => {
    const messaging = useMessaging();
    const { ctx, conversations, saveMessage } = makeContext();

    messaging.beginBulkMessageIngest(LIVE_DRAIN);
    await messaging.addMessageToChat(ME, 'my own message', CONVO, ctx, { messageId: 'own-1' });

    expect(idsIn(conversations)).toEqual(['own-1']);
    expect(saveMessage).toHaveBeenCalledTimes(1);
  });

  it('still buffers an INBOUND message, which is what the window is for', async () => {
    const messaging = useMessaging();
    const { ctx, conversations, saveMessage } = makeContext();

    messaging.beginBulkMessageIngest(LIVE_DRAIN);
    await messaging.addMessageToChat(PEER, 'their message', CONVO, ctx, { messageId: 'theirs-1' });

    expect(idsIn(conversations)).toEqual([]);
    expect(saveMessage).not.toHaveBeenCalled();

    await messaging.endBulkMessageIngest(ctx, LIVE_DRAIN);
    expect(idsIn(conversations)).toEqual(['theirs-1']);
  });

  /**
   * AN OWN MESSAGE FROM A FRAME IS NOT AN OWN SEND (2026-11-24). Written on this account's other
   * device, it reaches this one as a frame like a peer's message - the frame stays on the server until
   * the close stored its row - so it waits for the flush with the rest of the drain instead of paying
   * a render and a store write of its own (23 of them at ~90 ms in the owner's 1.7.3 catch-up).
   */
  it("buffers an own message decrypted from a frame (this account's other device)", async () => {
    const messaging = useMessaging();
    const { ctx, conversations, saveMessage } = makeContext();

    messaging.beginBulkMessageIngest(LIVE_DRAIN);
    await messaging.addMessageToChat(ME, 'from my laptop', CONVO, ctx, {
      messageId: 'sibling-1',
      frameId: 'frame-1',
    });

    expect(idsIn(conversations)).toEqual([]);
    expect(saveMessage).not.toHaveBeenCalled();

    await messaging.endBulkMessageIngest(ctx, LIVE_DRAIN);
    expect(idsIn(conversations)).toEqual(['sibling-1']);
    expect(conversations.get(CONVO)?.messages[0].isOwn).toBe(true);
    expect(saveMessage).toHaveBeenCalledTimes(1);
  });

  /**
   * THE OPEN CONVERSATION RECEIVES A DRAIN IN ONE RENDER. A catch-up mixing a peer's new messages,
   * upgrades of the previews their notifications left and messages from this account's other device
   * changes the conversation's row ONCE, at the window's close, and writes the store once: the pane
   * sees one change of its list, so one anchor decision, instead of one per row.
   */
  it('commits a mixed catch-up to the conversation in ONE change at the close', async () => {
    const messaging = useMessaging();
    const { ctx, conversations, saveMessage } = makeContext();
    conversations.set(CONVO, {
      ...(conversations.get(CONVO) as Conversation),
      messages: [
        {
          id: 'preview-1',
          senderId: PEER,
          content: '\u{1F4F7} Photo',
          timestamp: new Date(1_700_000_000_000),
          isOwn: false,
          isFcmPreview: true,
        },
      ] as never,
    });
    const sets = vi.spyOn(conversations, 'set');

    messaging.beginBulkMessageIngest(LIVE_DRAIN);
    const envelope = JSON.stringify({ kind: 'media', mediaId: 'm-1', mimeType: 'image/jpeg' });
    await messaging.addMessageToChat(PEER, envelope, CONVO, ctx, {
      messageId: 'preview-1',
      frameId: 'f-1',
      serverTimestamp: 1_700_000_000_000,
    });
    await messaging.addMessageToChat(ME, 'mine, from my laptop', CONVO, ctx, {
      messageId: 'sibling-1',
      frameId: 'f-2',
      serverTimestamp: 1_700_000_001_000,
    });
    await messaging.addMessageToChat(PEER, 'a new one', CONVO, ctx, {
      messageId: 'theirs-1',
      frameId: 'f-3',
      serverTimestamp: 1_700_000_002_000,
    });
    expect(sets).not.toHaveBeenCalled();

    await messaging.endBulkMessageIngest(ctx, LIVE_DRAIN);

    expect(sets.mock.calls.filter(([key]) => key === CONVO)).toHaveLength(1);
    expect(idsIn(conversations)).toEqual(['preview-1', 'sibling-1', 'theirs-1']);
    expect(conversations.get(CONVO)?.messages[0].content).toBe(envelope);
    // One batch write: the upgraded row and the two new ones, each once.
    expect(saveMessage.mock.calls.map((c) => (c[0] as { id: string }).id).sort()).toEqual([
      'preview-1',
      'sibling-1',
      'theirs-1',
    ]);
    expect(ctx.saveConversation).toHaveBeenCalledTimes(1);
  });

  /**
   * THE BANNER SAYS A CATCH-UP THE DRAIN'S START COULD NOT SEE (2026-11-24). A resume's drain
   * starts on the first frame of the pull's page, so its phase carries no overlay; the buffer's
   * count raises the banner anyway, and the window's close - the drain's own completion - lowers it.
   */
  it('raises the banner from the buffer of a window opened without an overlay, and lowers it at the close', async () => {
    const messaging = useMessaging();
    const { ctx } = makeContext();

    messaging.beginBulkMessageIngest(LIVE_DRAIN);
    for (let i = 0; i < 4; i++) {
      await messaging.addMessageToChat(PEER, `m${i}`, CONVO, ctx, { messageId: `m-${i}` });
    }
    expect(messaging.isCatchupOverlayVisible).toBe(false);
    await messaging.addMessageToChat(PEER, 'm4', CONVO, ctx, { messageId: 'm-4' });
    expect(messaging.isCatchupOverlayVisible).toBe(true);
    // Raising the banner is not the drain-wide catch-up state the concurrency guards read.
    expect(messaging.isMessageCatchupActive).toBe(false);

    await messaging.endBulkMessageIngest(ctx, LIVE_DRAIN);
    expect(messaging.isCatchupOverlayVisible).toBe(false);
  });

  /**
   * THE TWO SILENT RETURNS ON THE INBOUND PATH, and they are only findable because they now speak.
   *
   * COMM-4 watched an invitation card be written - the handler logged the conversation it went into
   * - and never appear on screen or survive a reload. Between the buffer and the flush there were
   * exactly two places a message could be absorbed without leaving anything behind, and neither of
   * them said so, which made a delivered message and a lost one look identical from every log there
   * is. Discarding may well be right; being silent about it never is.
   */
  it('says so when it drops a buffered message because the conversation went away', async () => {
    const messaging = useMessaging();
    const { ctx, conversations, saveMessage } = makeContext();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    messaging.beginBulkMessageIngest(LIVE_DRAIN);
    await messaging.addMessageToChat(PEER, 'their message', CONVO, ctx, { messageId: 'theirs-1' });
    // The conversation was in the map when the message arrived, and is not any more - which is why
    // this is not the orphan buffer: nothing will ever come back for it.
    conversations.delete(CONVO);
    await messaging.endBulkMessageIngest(ctx, LIVE_DRAIN);

    expect(saveMessage).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('vanished between buffering and flush')
    );
  });

  it('says so when it ignores a buffered message it already holds', async () => {
    const messaging = useMessaging();
    const { ctx, conversations } = makeContext();
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});

    messaging.beginBulkMessageIngest(LIVE_DRAIN);
    await messaging.addMessageToChat(PEER, 'their message', CONVO, ctx, { messageId: 'theirs-1' });
    await messaging.addMessageToChat(PEER, 'their message', CONVO, ctx, { messageId: 'theirs-1' });
    await messaging.endBulkMessageIngest(ctx, LIVE_DRAIN);

    expect(idsIn(conversations)).toEqual(['theirs-1']);
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining('Duplicate ignored during a bulk ingest')
    );
  });

  /**
   * The loss itself, and the reason a flush-based test would not catch it: a second drain starting
   * before the first ended clears the buffer WITHOUT flushing (`beginBulkMessageIngest` clears
   * unconditionally), so anything in it is gone for good. The own message must not be in there.
   */
  it('keeps the own message when a second drain discards the buffer unflushed', async () => {
    const messaging = useMessaging();
    const { ctx, conversations, saveMessage } = makeContext();

    messaging.beginBulkMessageIngest(LIVE_DRAIN);
    await messaging.addMessageToChat(PEER, 'their message', CONVO, ctx, { messageId: 'theirs-1' });
    await messaging.addMessageToChat(ME, 'my own message', CONVO, ctx, { messageId: 'own-1' });

    messaging.beginBulkMessageIngest(LIVE_DRAIN); // discards the buffer, unflushed
    await messaging.endBulkMessageIngest(ctx, LIVE_DRAIN);

    expect(idsIn(conversations)).toEqual(['own-1']);
    expect(saveMessage).toHaveBeenCalledTimes(1);
  });

  /**
   * THE ACTING DEVICE'S OWN NOTICE IS THE SAME CASE UNDER A `system` SENDER (review of #2412): MLS
   * never echoes it, so `sendVisibleNotice`'s write is the only one it gets. Written through the
   * real `sendVisibleNotice` into the real `addMessageToChat`, inside a drain, then the drain is
   * discarded both ways the buffer can be.
   */
  for (const discard of ['a second drain start', 'resetMessageCatchupState'] as const) {
    it(`keeps the acting device's own visible notice across ${discard}`, async () => {
      const messaging = useMessaging();
      const { ctx, conversations, saveMessage } = makeContext();
      const mls = createMlsServiceStub();

      messaging.beginBulkMessageIngest(LIVE_DRAIN);
      await sendVisibleNotice(
        mls,
        CONVO,
        'groupRenamed',
        { newName: 'Nouveau' },
        {
          contactName: CONVO,
          actor: ME,
          addMessageToChat: (senderId, content, key, options) =>
            messaging.addMessageToChat(senderId, content, key, ctx, options),
        }
      );
      if (discard === 'a second drain start') {
        messaging.beginBulkMessageIngest(LIVE_DRAIN);
        await messaging.endBulkMessageIngest(ctx, LIVE_DRAIN);
      } else {
        messaging.resetMessageCatchupState();
      }

      const frame = decodeAppMessage(vi.mocked(mls.sendMessage).mock.calls[0][1] as Uint8Array);
      expect(idsIn(conversations)).toEqual([frame?.messageId]);
      expect(saveMessage).toHaveBeenCalledTimes(1);
    });
  }

  it('keeps the own message across resetMessageCatchupState, which also discards unflushed', async () => {
    const messaging = useMessaging();
    const { ctx, conversations, saveMessage } = makeContext();

    messaging.beginBulkMessageIngest(LIVE_DRAIN);
    await messaging.addMessageToChat(ME, 'my own message', CONVO, ctx, { messageId: 'own-1' });
    await messaging.addMessageToChat(PEER, 'their message', CONVO, ctx, { messageId: 'theirs-1' });
    messaging.resetMessageCatchupState();

    expect(idsIn(conversations)).toEqual(['own-1']);
    expect(saveMessage).toHaveBeenCalledTimes(1);
  });
});

/**
 * THE PHOTO THAT STAYED A NOTIFICATION (user report, 2026-09-22; reproduced on the Mi 9T
 * 2026-09-23 with `archive/photoprev.mjs --mode restored`).
 *
 * A launch that has an FCM cache entry merges the notification's caption into the conversation
 * BEFORE the queue drain reaches the frame it previews - same id, deliberately. The drain is a
 * bulk ingest, and the bulk branch asked only whether the id was known: it logged
 * `Duplicate ignored during a bulk ingest`, returned, and the handler answered `true`. The frame
 * was then acknowledged and DELETED server-side, so the bubble read the caption for good - the
 * queue row gone, the generation spent, and the archive replay skipping the fingerprint for ever.
 * The upgrade has to happen here, at the instant the envelope arrives, because the ack does.
 */
describe('an FCM preview upgraded during a bulk-ingest window', () => {
  const ENVELOPE = JSON.stringify({ kind: 'media', mediaId: 'm-1', mimeType: 'image/jpeg' });
  /** The ONE producer of this string is the Rust notification builder - see `proto_fields.rs`. */
  const PREVIEW = '\u{1F4F7} Photo';

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  /** The state `mergeFcmMessagesIntoConversations` leaves behind at login. */
  function withPreview() {
    const made = makeContext();
    made.conversations.set(CONVO, {
      ...(made.conversations.get(CONVO) as Conversation),
      messages: [
        {
          id: 'photo-1',
          senderId: PEER,
          content: PREVIEW,
          timestamp: new Date(1_700_000_000_000),
          isOwn: false,
          isFcmPreview: true,
        },
      ] as never,
    });
    return made;
  }

  /**
   * THE UPGRADE WAITS FOR THE FLUSH (2026-11-24). It used to be done at once on the live path,
   * because the frame was acknowledged the moment the handler returned; the ack now waits for the
   * window's close to store the row (rows before ratchet), so the upgrade is held with the drain's
   * other rows and lands in the same render and the same write - one per conversation, not one per
   * preview (`bulkWindowHolds`).
   */
  it('holds the upgrade for the window, then replaces the caption and persists it at the close', async () => {
    const messaging = useMessaging();
    const { ctx, conversations, saveMessage } = withPreview();

    messaging.beginBulkMessageIngest(LIVE_DRAIN);
    await messaging.addMessageToChat(PEER, ENVELOPE, CONVO, ctx, { messageId: 'photo-1' });

    expect(conversations.get(CONVO)?.messages[0].content).toBe(PREVIEW);
    expect(saveMessage).not.toHaveBeenCalled();

    await messaging.endBulkMessageIngest(ctx, LIVE_DRAIN);

    const held = conversations.get(CONVO)?.messages ?? [];
    expect(held.map((m) => m.id)).toEqual(['photo-1']);
    expect(held[0].content).toBe(ENVELOPE);
    expect(held[0].isFcmPreview).toBe(false);
    expect(saveMessage).toHaveBeenCalledTimes(1);
    expect(saveMessage.mock.calls[0][0]).toMatchObject({
      id: 'photo-1',
      content: ENVELOPE,
      isFcmPreview: false,
    });
  });

  it("keeps THIS device's record of a reel's 410 across the upgrade (RC-6)", async () => {
    const messaging = useMessaging();
    const { ctx, conversations, saveMessage } = withPreview();
    const row = conversations.get(CONVO)!;
    conversations.set(CONVO, {
      ...row,
      messages: [{ ...row.messages[0], mediaPurgedAt: 4242 }],
    });

    await messaging.addMessageToChat(PEER, ENVELOPE, CONVO, ctx, { messageId: 'photo-1' });

    expect(conversations.get(CONVO)!.messages[0].mediaPurgedAt).toBe(4242);
    expect(saveMessage.mock.calls[0][0]).toMatchObject({ id: 'photo-1', mediaPurgedAt: 4242 });
  });

  it("keeps it through batchAddMessages' upgrade too, the other seam that rewrites the row", async () => {
    const messaging = useMessaging();
    const { ctx, conversations, saveMessage } = withPreview();
    const row = conversations.get(CONVO)!;
    conversations.set(CONVO, {
      ...row,
      messages: [{ ...row.messages[0], mediaPurgedAt: 4242 }],
    });

    await messaging.batchAddMessages(
      [{ senderId: PEER, content: ENVELOPE, messageId: 'photo-1' }],
      CONVO,
      ctx,
      'restore'
    );

    expect(conversations.get(CONVO)!.messages[0].mediaPurgedAt).toBe(4242);
    const written = saveMessage.mock.calls.map((c) => c[0] as { id: string });
    expect(written.find((r) => r.id === 'photo-1')).toMatchObject({ mediaPurgedAt: 4242 });
  });

  it('does not add a second bubble, and the flush adds nothing either', async () => {
    const messaging = useMessaging();
    const { ctx, conversations } = withPreview();

    messaging.beginBulkMessageIngest(LIVE_DRAIN);
    await messaging.addMessageToChat(PEER, ENVELOPE, CONVO, ctx, { messageId: 'photo-1' });
    await messaging.endBulkMessageIngest(ctx, LIVE_DRAIN);

    const held = conversations.get(CONVO)?.messages ?? [];
    expect(held.map((m) => m.id)).toEqual(['photo-1']);
    expect(held[0].content).toBe(ENVELOPE);
  });

  /**
   * The rule is an UPGRADE, not "never dedupe": a second copy of the same envelope is still a
   * duplicate, and must still be dropped and still say so.
   */
  it('still ignores a duplicate once the row is a full envelope', async () => {
    const messaging = useMessaging();
    const { ctx, conversations, saveMessage } = withPreview();
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});

    messaging.beginBulkMessageIngest(LIVE_DRAIN);
    await messaging.addMessageToChat(PEER, ENVELOPE, CONVO, ctx, { messageId: 'photo-1' });
    await messaging.addMessageToChat(PEER, ENVELOPE, CONVO, ctx, { messageId: 'photo-1' });
    await messaging.endBulkMessageIngest(ctx, LIVE_DRAIN);

    expect(saveMessage).toHaveBeenCalledTimes(1);
    expect((conversations.get(CONVO)?.messages ?? []).length).toBe(1);
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining('Duplicate ignored during a bulk ingest')
    );
  });

  /**
   * A preview NEVER overwrites an envelope, whichever order they arrive in - the reverse direction
   * of the same rule, and the one `isEnvelopeContent` guards in the FCM cache.
   */
  it('refuses the reverse: a caption arriving after the envelope is a plain duplicate', async () => {
    const messaging = useMessaging();
    const { ctx, conversations, saveMessage } = makeContext();
    conversations.set(CONVO, {
      ...(conversations.get(CONVO) as Conversation),
      messages: [
        {
          id: 'photo-1',
          senderId: PEER,
          content: ENVELOPE,
          timestamp: new Date(1_700_000_000_000),
          isOwn: false,
        },
      ] as never,
    });

    messaging.beginBulkMessageIngest(LIVE_DRAIN);
    await messaging.addMessageToChat(PEER, PREVIEW, CONVO, ctx, { messageId: 'photo-1' });

    expect(conversations.get(CONVO)?.messages[0].content).toBe(ENVELOPE);
    expect(saveMessage).not.toHaveBeenCalled();
  });
});
