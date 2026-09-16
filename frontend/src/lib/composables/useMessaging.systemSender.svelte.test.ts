/**
 * A ROW SENT BY `system` IS A SYSTEM ROW, WHATEVER THE CALLER REMEMBERED TO SAY.
 *
 * `isSystem` and `senderId === 'system'` are the same fact in two forms, and `isSystemSender`'s
 * docblock already says that any writer setting one without the other produces a notice rendered as
 * an ORDINARY BUBBLE labelled "Utilisateur" - no display name resolves for the sentinel, so the
 * sender label falls back to the unknown-user string.
 *
 * `serializeForBundle` is that writer. It carries reactions, tombstones and the edit instant from
 * the source device and has never carried this flag, so every notice restored through a
 * `history_bundle` arrived as a message from nobody. The 2026-09-14 fix derived the flag in the
 * REPLAY's `pushPendingMessage` - and the LIVE bundle merge in `systemMessageHandler` goes through
 * these two functions instead, which restated it. Half an invariant is not an invariant.
 *
 * Reported from production on 2026-09-16 with both renderings visible in one thread: the same
 * `memberAdded`, once as a centred pill and once as a "Utilisateur" bubble directly beneath it.
 *
 * THE RENDER IS THE SMALLEST OF THE THREE THINGS THE FLAG DECIDES. It also gates the unread badge,
 * the arrival tone and the OS notification, so a notice arriving through a bundle rang a phone and
 * raised a count for a line nobody sent - which is why those are asserted here too.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';

// Same import-cycle break as the other useMessaging tests: useMessaging -> chat/outbox ->
// chat/outboxMirror -> globalChatSingleton, which calls useMessaging() at module scope.
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
const CONVO = 'conversation-key';
/** Exactly what `serializeForBundle` puts on the wire for a notice: a sender, and no flag. */
const BUNDLE_NOTICE = {
  senderId: 'system',
  content: 'Mathéo BOUDIER a ajouté Esteban DELSOL au groupe',
  messageId: 'notice-1',
  timestamp: new Date('2026-09-16T14:20:37Z'),
};

function makeContext() {
  const conversations = new SvelteMap<string, Conversation>([
    [
      CONVO,
      {
        id: CONVO,
        name: CONVO,
        messages: [],
        unreadCount: 0,
        lastMessageAt: 0,
      } as never,
    ],
  ]);
  const ctx = {
    conversations,
    userId: ME,
    deviceKeyB64: 'device-key',
    authToken: 'token',
    // NOT the open conversation: nothing may zero the badge as a side effect of being on screen.
    selectedContact: 'some-other-conversation',
    storage: { saveMessage: vi.fn().mockResolvedValue(undefined) } as never,
    setAuthToken: vi.fn(),
    getSendError: () => '',
    setSendError: vi.fn(),
    getChatContainer: () => undefined,
    ensureMls: vi.fn(),
    log: vi.fn(),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    verifyCurrentUserMembership: vi.fn().mockResolvedValue(true),
    playNotificationTone: vi.fn(),
    playReceiveTone: vi.fn(),
    sendSystemNotification: vi.fn().mockResolvedValue(undefined),
  } as unknown as MessagingContext;
  return { ctx, conversations };
}

const rowsIn = (conversations: SvelteMap<string, Conversation>) =>
  conversations.get(CONVO)?.messages ?? [];

describe('a bundle row from `system` is materialised as a system row', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('batch seam: the flag is derived from the sender, not taken from the caller', async () => {
    const messaging = useMessaging();
    const { ctx, conversations } = makeContext();

    await messaging.batchAddMessages([BUNDLE_NOTICE], CONVO, ctx);

    const [row] = rowsIn(conversations);
    expect(row.senderId).toBe('system');
    // Without the derivation this is `undefined`, and the renderer draws a left-aligned bubble
    // under a "Utilisateur" header - which is exactly what production showed.
    expect(row.isSystem).toBe(true);
  });

  it('single-add seam: same row, same answer', async () => {
    const messaging = useMessaging();
    const { ctx, conversations } = makeContext();

    const { senderId, content, ...options } = BUNDLE_NOTICE;
    await messaging.addMessageToChat(senderId, content, CONVO, ctx, options);

    const [row] = rowsIn(conversations);
    expect(row.isSystem).toBe(true);
  });

  it('raises no badge, no tone and no notification for it', async () => {
    const messaging = useMessaging();
    const { ctx, conversations } = makeContext();

    const { senderId, content, ...options } = BUNDLE_NOTICE;
    await messaging.addMessageToChat(senderId, content, CONVO, ctx, options);

    expect(conversations.get(CONVO)?.unreadCount ?? 0).toBe(0);
    expect(ctx.playReceiveTone).not.toHaveBeenCalled();
    expect(ctx.playNotificationTone).not.toHaveBeenCalled();
    expect(ctx.sendSystemNotification).not.toHaveBeenCalled();
  });

  it('an explicit flag still wins for a caller that has no system sender', async () => {
    // The derivation widens the answer, it does not replace it: a row flagged by its writer stays
    // flagged whatever its sender is. Nothing in the tree relies on this today, and a silent
    // narrowing here would be invisible until something did.
    const messaging = useMessaging();
    const { ctx, conversations } = makeContext();

    await messaging.batchAddMessages(
      [{ senderId: 'peer-user', content: 'flagged by its writer', messageId: 'x', isSystem: true }],
      CONVO,
      ctx
    );

    expect(rowsIn(conversations)[0].isSystem).toBe(true);
  });

  it('an ordinary message is untouched: still a bubble, still counted', async () => {
    const messaging = useMessaging();
    const { ctx, conversations } = makeContext();

    await messaging.batchAddMessages(
      [{ senderId: 'peer-user', content: 'bonjour', messageId: 'm1' }],
      CONVO,
      ctx
    );

    expect(rowsIn(conversations)[0].isSystem).toBeFalsy();
    expect(conversations.get(CONVO)?.unreadCount ?? 0).toBe(1);
  });
});
