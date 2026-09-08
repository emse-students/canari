/**
 * A PHONE IN A POCKET WAS TOLD NOTHING, and the reason was one early return.
 *
 * `notifyInbound` returned immediately on native mobile, on the premise that "the background push
 * handler posts its own, so the user would get two". That holds only when there IS a push, and for
 * the ordinary backgrounded case there is none: the server pushes a message only when the device
 * has not ACKNOWLEDGED it after 10 s, and a backgrounded Android app keeps its WebSocket, receives
 * the frame and ACKs it. So no push was sent, the push handler never ran, and this early return
 * meant nobody notified at all.
 *
 * Measured on device 2026-09-05 with all three sources correlated on one message: the server logged
 * `[SEND] PUBLISHED recipient=...:tauri-...` with NO `[PUSH_DEFERRED]` after it, the shade held
 * nothing, and the app was holding the message the whole time. It also explains the pair the
 * campaign had backwards - LIFE-8 (`am kill`) measured a decrypted push in 4.7 s, because a killed
 * app cannot ACK so the push does fire.
 *
 * These pin the new condition from both directions, because the risk runs both ways: too quiet and
 * the defect is back, too loud and a banner interrupts somebody reading the message.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';

// Same import-cycle cut as the sibling notification tests - see `useMessaging.bulkIngest`.
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  appendLog: () => {},
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: {},
  globalNotifs: {},
}));

// MUTABLE, because the whole subject is the difference between the two runtimes. A file-level
// constant would need two files to ask one question, and the web case has to be asserted HERE:
// "mobile is quiet when unfocused" only means something beside "web is not".
let MOBILE = true;
vi.mock('$lib/utils/appVersion', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  isMobileTauriRuntime: () => MOBILE,
}));

const { useMessaging } = await import('./useMessaging.svelte');
type MessagingContext = import('./useMessaging.svelte').MessagingContext;
import type { Conversation } from '$lib/types';
import { EXAMPLE_MENTION_USER_ID, formatMentionToken } from '$lib/utils/mentions';

const ME = 'me-user-id';
const PEER = 'peer-user-id';
const CONVO = 'conversation-key';
const LIVE_DRAIN = { bufferUi: true, showOverlay: false };

/**
 * `lookingAt` IS A FIXTURE PARAMETER SINCE 2026-09-07, because "the app is on screen" stopped being
 * the whole question. A phone in the foreground still shows exactly ONE conversation, so a message
 * for any other one is visible nowhere - see `arrivalVisibility.ts`, which owns the rule and asserts
 * every cell of it. The default stays `something-else`, the state most of these cases are about.
 */
function makeContext(lookingAt = 'something-else') {
  const sendSystemNotification = vi.fn().mockResolvedValue(undefined);
  const conversations = new SvelteMap<string, Conversation>([
    [CONVO, { id: CONVO, name: CONVO, messages: [], unreadCount: 0, lastMessageAt: 0 } as never],
  ]);
  const ctx = {
    conversations,
    userId: ME,
    deviceKeyB64: 'device-key',
    authToken: 'token',
    selectedContact: lookingAt,
    // BOTH writers, because the two inbound paths use different ones: the live path saves one
    // message and the bulk flush saves the batch. A fixture with only the first made
    // `batchAddMessages` log a real TypeError into every drain case - harmless to the assertion,
    // and exactly the kind of red herring a later reader spends an hour on.
    storage: {
      saveMessage: vi.fn().mockResolvedValue(undefined),
      saveMessages: vi.fn().mockResolvedValue(undefined),
    } as never,
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
    sendSystemNotification,
  } as unknown as MessagingContext;
  return { ctx, sendSystemNotification };
}

/**
 * The document's two facts AND the platform's one, set INDEPENDENTLY - which is the whole point.
 *
 * On a phone the first two are not merely unreliable, they are FIXED: a backgrounded Tauri app
 * reports `visible` / `hasFocus: true`, exactly its foreground answer (measured on device
 * 2026-09-05). So every mobile case here pins `visible, focused` and moves only
 * `window.__canariForeground` - a fixture that let the document say `hidden` on mobile would be
 * testing a state that hardware never produces, and would have passed an inert fix.
 */
function screen(visibility: 'hidden' | 'visible', focused: boolean, foreground?: boolean) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
  vi.spyOn(document, 'hasFocus').mockReturnValue(focused);
  if (foreground === undefined)
    delete (window as unknown as Record<string, unknown>).__canariForeground;
  else (window as unknown as Record<string, unknown>).__canariForeground = foreground;
}

describe('native mobile notifies for the message no push will ever carry', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    MOBILE = true;
  });

  it('THE DEFECT: a backgrounded phone is told about an inbound message', async () => {
    const messaging = useMessaging();
    const { ctx, sendSystemNotification } = makeContext();
    // What hardware really reports while backgrounded: the document sees nothing wrong.
    screen('visible', true, false);

    await messaging.addMessageToChat(PEER, 'their message', CONVO, ctx, { messageId: 'm-1' });

    expect(sendSystemNotification).toHaveBeenCalledTimes(1);
    // The conversation key travels, because both the 800 ms throttle and the per-conversation
    // notification id are derived from it - a notification with no key stacks for ever.
    expect(sendSystemNotification.mock.calls[0][2]).toBe(CONVO);
  });

  it('and so is one that arrived inside a catch-up drain, which is what a phone coming back does', async () => {
    const messaging = useMessaging();
    const { ctx, sendSystemNotification } = makeContext();
    screen('visible', true, false);

    messaging.beginBulkMessageIngest(LIVE_DRAIN);
    await messaging.addMessageToChat(PEER, 'buffered', CONVO, ctx, { messageId: 'm-2' });
    expect(sendSystemNotification).not.toHaveBeenCalled();

    await messaging.endBulkMessageIngest(ctx, LIVE_DRAIN);
    expect(sendSystemNotification).toHaveBeenCalledTimes(1);
  });

  it('THE OTHER DIRECTION: an activity showing THAT conversation is not interrupted', async () => {
    const messaging = useMessaging();
    // ON SCREEN IS NOT ENOUGH, AND SAYING SO WAS THE DEFECT. This case is quiet because the reader
    // is inside the conversation the message landed in and watched it arrive.
    const { ctx, sendSystemNotification } = makeContext(CONVO);
    screen('visible', true, true);

    await messaging.addMessageToChat(PEER, 'their message', CONVO, ctx, { messageId: 'm-3' });

    expect(sendSystemNotification).not.toHaveBeenCalled();
  });

  it('THE DEFECT THE USER REPORTED: on screen, but looking somewhere else, and told', async () => {
    const messaging = useMessaging();
    const { ctx, sendSystemNotification } = makeContext('another-conversation');
    screen('visible', true, true);

    await messaging.addMessageToChat(PEER, 'their message', CONVO, ctx, { messageId: 'm-3b' });

    // "Si je discute avec A et que B m'envoie un message, la notif de B devrait apparaitre." Until
    // this, a foregrounded app returned before ever asking, so the only signal was a tone and an
    // unread badge in a conversation list a narrow layout does not render.
    expect(sendSystemNotification).toHaveBeenCalledTimes(1);
    expect(sendSystemNotification.mock.calls[0][2]).toBe(CONVO);
  });

  it('which is NOT what the web client does with the same two facts', async () => {
    MOBILE = false;
    const messaging = useMessaging();
    const { ctx, sendSystemNotification } = makeContext();
    screen('visible', false); // visible but unfocused: a desktop window behind another

    await messaging.addMessageToChat(PEER, 'their message', CONVO, ctx, { messageId: 'm-4' });

    // A desktop tab that is visible but behind another window is a real "away", and it always
    // notified. Asserting it here is what keeps the mobile rule from being applied to both.
    expect(sendSystemNotification).toHaveBeenCalledTimes(1);
  });

  it('a runtime that never states the fact is treated as on screen, and stays quiet', async () => {
    const messaging = useMessaging();
    // Reading the conversation the message lands in, so the assertion is about the missing flag
    // rather than about where the reader is looking.
    const { ctx, sendSystemNotification } = makeContext(CONVO);
    screen('visible', true, undefined);

    await messaging.addMessageToChat(PEER, 'their message', CONVO, ctx, { messageId: 'm-6' });

    // The default is the quiet one deliberately: an older APK that does not push the flag keeps the
    // behaviour it has rather than notifying over the user's shoulder while they read.
    expect(sendSystemNotification).not.toHaveBeenCalled();
  });

  it('a phone still says nothing about the user own message', async () => {
    const messaging = useMessaging();
    const { ctx, sendSystemNotification } = makeContext();
    screen('visible', true, false);

    await messaging.addMessageToChat(ME, 'my own message', CONVO, ctx, { messageId: 'm-5' });

    expect(sendSystemNotification).not.toHaveBeenCalled();
  });
});

/**
 * A MENTION IS FILED ON THE READER'S OWN SWITCH, AND THE WEBSOCKET HALF DID NOT KNOW IT EXISTED.
 *
 * `canari_mentions` is a separate Android channel with its own importance, sound, vibration and DND
 * standing, and the user can toggle it independently - it is what lets someone mute the chatter and
 * still hear their own name. `CanariFirebaseMessagingService` picked it by reading the decrypted
 * text for `@[myUserId]`; this path passed `canari_messages` for everything, because it had no
 * mentions branch at all.
 *
 * Since the builder follows the message's ROUTE and not the app's state, the consequence was not
 * "mentions are never special" but something worse: measured as NOTIF-16 on 2026-09-08, one
 * backgrounded phone filed a mention that arrived over the WebSocket on `canari_messages` and the
 * same mention arriving as a push on `canari_mentions`. Which of the reader's switches applied was
 * decided by the transport, which the reader cannot see and nothing makes stable.
 *
 * The flag is asserted in BOTH directions. Sending it always-true would be the same defect wearing
 * the other mask: every message would bypass a mute the user set deliberately.
 */
describe('a message that names the reader is filed on the mentions channel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    MOBILE = true;
  });

  /** The fixture's `ME` is not mention-shaped - a token only carries a 64-hex OIDC sub. */
  const mentionable = (ctx: MessagingContext) => {
    (ctx as { userId: string }).userId = EXAMPLE_MENTION_USER_ID;
    return ctx;
  };

  it('passes the mention flag when the text carries this user token', async () => {
    const messaging = useMessaging();
    const { ctx, sendSystemNotification } = makeContext();
    screen('visible', true, false);

    await messaging.addMessageToChat(
      PEER,
      `${formatMentionToken(EXAMPLE_MENTION_USER_ID)} look at this`,
      CONVO,
      mentionable(ctx),
      { messageId: 'm-mention' }
    );

    expect(sendSystemNotification).toHaveBeenCalledTimes(1);
    expect(sendSystemNotification.mock.calls[0][3]).toBe(true);
  });

  it('does not, for a mention of somebody else in the same conversation', async () => {
    const messaging = useMessaging();
    const { ctx, sendSystemNotification } = makeContext();
    screen('visible', true, false);

    // A real 64-hex id that is NOT the reader's: the token is present and must not count. A check
    // written against "does the text contain a mention" rather than "does it name ME" passes on
    // the defect, and every busy salon message would then arrive on the mentions channel.
    const somebodyElse = EXAMPLE_MENTION_USER_ID.replace(/^d8/, 'a1');
    await messaging.addMessageToChat(
      PEER,
      `${formatMentionToken(somebodyElse)} look at this`,
      CONVO,
      mentionable(ctx),
      { messageId: 'm-other-mention' }
    );

    expect(sendSystemNotification).toHaveBeenCalledTimes(1);
    expect(sendSystemNotification.mock.calls[0][3]).toBe(false);
  });

  it('does not, for an ordinary message', async () => {
    const messaging = useMessaging();
    const { ctx, sendSystemNotification } = makeContext();
    screen('visible', true, false);

    await messaging.addMessageToChat(PEER, 'their message', CONVO, mentionable(ctx), {
      messageId: 'm-plain',
    });

    expect(sendSystemNotification).toHaveBeenCalledTimes(1);
    expect(sendSystemNotification.mock.calls[0][3]).toBe(false);
  });
});
