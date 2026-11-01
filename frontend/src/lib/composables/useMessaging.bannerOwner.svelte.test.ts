// @vitest-environment happy-dom
/**
 * OUT OF FRONT ON AN iPHONE, A MESSAGE'S BANNER IS THE PAGE'S OR ITS PUSH'S, AS THE SERVER'S ACK
 * ANSWER SAYS (`bannerOwnership.ts`, server half in `push-claim.ts`).
 *
 * The page receives a frame over the socket while backgrounded; the server pushes the same row when
 * its ACK has not arrived after ten seconds, and the notification extension announces that push. The
 * ACK and the push are exclusive on the server and the ACK's answer names the rows a push owns. Each
 * case below fails if the page decides before that answer, or ignores it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';

vi.mock('$lib/utils/users/displayName', async (orig) => ({
  ...(await orig<typeof import('$lib/utils/users/displayName')>()),
  resolveNotificationSenderName: async () => 'Peer',
}));

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  appendLog: () => {},
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: {},
  globalNotifs: {},
}));

vi.mock('$lib/utils/appVersion', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  isMobileTauriRuntime: () => true,
  isIosTauriRuntime: () => true,
}));

vi.mock('$lib/utils/chat/fcmCache', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  pushCacheMessageIds: async () => new Set<string>(),
}));

const { useMessaging } = await import('./useMessaging.svelte');
const { bindQueuedRow, forgetBannerOwnership, settleAckAnswer } =
  await import('$lib/utils/chat/bannerOwnership');
const { ackMessagesWithRetry, clearPersistedPendingAcks } =
  await import('$lib/mls-client/ackRetry');
const { unnotifiedOf } = await import('$lib/utils/chat/notifiedMessages');
type MessagingContext = import('./useMessaging.svelte').MessagingContext;
import type { Conversation } from '$lib/types';

const ME = 'me-user-id';
const PEER = 'peer-user-id';
const CONVO = 'conversation-key';

function session() {
  const sendSystemNotification = vi.fn().mockResolvedValue(true);
  const ctx = {
    conversations: new SvelteMap<string, Conversation>([
      [CONVO, { id: CONVO, name: CONVO, messages: [], unreadCount: 0, lastMessageAt: 0 } as never],
    ]),
    userId: ME,
    deviceKeyB64: 'device-key',
    authToken: 'token',
    selectedContact: 'something-else',
    storage: {
      saveMessage: vi.fn().mockResolvedValue(undefined),
      saveMessages: vi.fn().mockResolvedValue(undefined),
    } as never,
    setAuthToken: vi.fn(),
    getSendError: () => '',
    setSendError: vi.fn(),
    ensureMls: vi.fn(),
    log: vi.fn(),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    verifyCurrentUserMembership: vi.fn().mockResolvedValue(true),
    playNotificationTone: vi.fn(),
    playReceiveTone: vi.fn(),
    sendSystemNotification,
  } as unknown as MessagingContext;
  return { messaging: useMessaging(), ctx, sendSystemNotification };
}

/** What iOS tells the page (`CanariPushForegroundToPage`). */
function inFront(foreground: boolean) {
  (window as unknown as Record<string, unknown>).__canariForeground = foreground;
}

/** A message the pipeline delivered from queued row `queuedId`. */
async function arrives(s: ReturnType<typeof session>, messageId: string, queuedId: string) {
  bindQueuedRow(messageId, queuedId);
  await s.messaging.addMessageToChat(PEER, `text ${messageId}`, CONVO, s.ctx, { messageId });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the banner of a message received out of front', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
    sessionStorage.clear();
    forgetBannerOwnership();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    window.history.pushState({}, '', '/posts');
  });

  it('IN FRONT: the page announces it at once - no answer is waited for', async () => {
    inFront(true);
    const s = session();
    await arrives(s, 'm-front', 'q-front');
    await vi.waitFor(() => expect(s.sendSystemNotification).toHaveBeenCalledTimes(1));
  });

  it('OUT OF FRONT, THE ACK CLAIMED IT: the page announces it - after the answer, not before', async () => {
    inFront(false);
    const s = session();
    await arrives(s, 'm-ack', 'q-ack');
    await settle();
    expect(s.sendSystemNotification).not.toHaveBeenCalled();

    settleAckAnswer(['q-ack'], { status: 'deleted', count: 1, pushed: [], unresolved: [] });
    await vi.waitFor(() => expect(s.sendSystemNotification).toHaveBeenCalledTimes(1));
  });

  it('OUT OF FRONT, THE PUSH FIRED: the page stays silent, and the message is known announced', async () => {
    inFront(false);
    const s = session();
    await arrives(s, 'm-push', 'q-push');
    settleAckAnswer(['q-push'], {
      status: 'deleted',
      count: 1,
      pushed: ['q-push'],
      unresolved: [],
    });
    await settle();
    await settle();
    expect(s.sendSystemNotification).not.toHaveBeenCalled();
    expect(unnotifiedOf(ME, ['m-push'])).toEqual([]);
  });

  it('an UNRESOLVED owner is announced by the page - a duplicate, never a missing banner', async () => {
    inFront(false);
    const s = session();
    await arrives(s, 'm-unk', 'q-unk');
    settleAckAnswer(['q-unk'], { status: 'deleted', count: 0, pushed: [], unresolved: ['q-unk'] });
    await vi.waitFor(() => expect(s.sendSystemNotification).toHaveBeenCalledTimes(1));
  });

  it('A LEGACY SERVER (no owner in the answer): announced as before, and said once per session', async () => {
    inFront(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = session();
    await arrives(s, 'm-l1', 'q-l1');
    await arrives(s, 'm-l2', 'q-l2');
    settleAckAnswer(['q-l1'], { status: 'deleted', count: 1 });
    settleAckAnswer(['q-l2'], { status: 'deleted', count: 1 });
    await vi.waitFor(() => expect(s.sendSystemNotification).toHaveBeenCalledTimes(2));
    expect(
      warn.mock.calls.filter((c) => String(c[0]).includes('older than the claim')).length
    ).toBeLessThanOrEqual(1);
  });

  it('an ACK that never answers keeps the page silent - its row is pushed, the extension announces it', async () => {
    inFront(false);
    const s = session();
    await arrives(s, 'm-lost', 'q-lost');
    await settle();
    await settle();
    expect(s.sendSystemNotification).not.toHaveBeenCalled();
  });

  it('A RETRY settles the wait: the answer to a later ACK covers the ids a failed one persisted', async () => {
    inFront(false);
    const s = session();
    await arrives(s, 'm-old', 'q-old');
    // The first ACK of `q-old` failed and was persisted; the next ACK carries it.
    sessionStorage.setItem(
      'canari_pending_message_acks',
      JSON.stringify({ userId: ME, deviceId: 'd', messageIds: ['q-old'] })
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ status: 'deleted', count: 2, pushed: ['q-old'], unresolved: [] }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }
          )
      )
    );
    await ackMessagesWithRetry(
      'https://history.test',
      {},
      { userId: ME, deviceId: 'd', messageIds: ['q-new'] }
    );
    await settle();
    await settle();
    expect(s.sendSystemNotification).not.toHaveBeenCalled();
    expect(unnotifiedOf(ME, ['m-old'])).toEqual([]);
    clearPersistedPendingAcks();
  });
});
