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
    storage: { saveMessage } as never,
    setAuthToken: vi.fn(),
    getSendError: () => '',
    setSendError: vi.fn(),
    ensureMls: vi.fn(),
    log: vi.fn(),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    verifyCurrentUserMembership: vi.fn().mockResolvedValue(true),
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

  it('replaces the caption with the envelope and persists it, without waiting for the flush', async () => {
    const messaging = useMessaging();
    const { ctx, conversations, saveMessage } = withPreview();

    messaging.beginBulkMessageIngest(LIVE_DRAIN);
    await messaging.addMessageToChat(PEER, ENVELOPE, CONVO, ctx, { messageId: 'photo-1' });

    // The frame is acked the moment this returns, so the repair may not be owed to the flush.
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
    saveMessage.mockClear();
    await messaging.addMessageToChat(PEER, ENVELOPE, CONVO, ctx, { messageId: 'photo-1' });

    expect(saveMessage).not.toHaveBeenCalled();
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
