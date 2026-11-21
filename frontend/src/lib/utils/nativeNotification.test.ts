const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const isAndroidTauriRuntime = vi.fn();
const isIosTauriRuntime = vi.fn(() => false);
vi.mock('$lib/utils/appVersion', () => ({
  isAndroidTauriRuntime: () => isAndroidTauriRuntime(),
  isIosTauriRuntime: () => isIosTauriRuntime(),
}));

import {
  composePlainNotificationText,
  recordNativeReadElsewhere,
  handOverConversationEvent,
  cancelNativeConversationNotifications,
  ENDED_CONVERSATION_MARK,
  notificationGroupName,
  notificationIsGroup,
  postNativeMessageNotification,
  postNativeReactionNotification,
  type NativeMessageNotification,
} from './nativeNotification';

/**
 * ONE BUILDER ON ANDROID, AND THE WEBVIEW ASKS IT RATHER THAN POSTING ITS OWN.
 *
 * Until 2026-09-18 a message that arrived over the WebSocket AND was pushed produced two
 * notifications side by side: a plain one from `tauri-plugin-notification` and a rich one from
 * `CanariFirebaseMessagingService`. Their suppression predicates are disjoint and their id
 * namespaces cannot collide, so nothing merged them. Reported by the user with a capture of the
 * pair.
 *
 * What is pinned here is the SEAM: that the WebView hands the native builder exactly what a push
 * payload carries, so the two triggers render one notification, and that a refusal is reported
 * rather than replaced by a second path.
 */
const NOTIF: NativeMessageNotification = {
  conversationId: 'grp-aaaa-bbbb',
  senderId: 'peer-1',
  senderName: 'Alice',
  groupName: '',
  body: 'Hello',
  mentionsMe: false,
  sentAt: 1_700_000_000_000,
  serverAt: 1_700_000_000_400,
  covers: 1,
  authorProven: false,
  isGroup: false,
};

describe('postNativeMessageNotification', () => {
  beforeEach(() => {
    invoke.mockReset();
    isAndroidTauriRuntime.mockReset();
  });

  it('does not reach the native builder off Android', async () => {
    isAndroidTauriRuntime.mockReturnValue(false);

    expect(await postNativeMessageNotification(NOTIF)).toBe(false);
    // Web and desktop keep the plugin path: it is the only builder they have, and calling a
    // command that does not exist there would be an error narrated as a missing notification.
    expect(invoke).not.toHaveBeenCalled();
  });

  it('hands the native builder the push payload shape', async () => {
    isAndroidTauriRuntime.mockReturnValue(true);
    invoke.mockResolvedValue(true);

    expect(await postNativeMessageNotification({ ...NOTIF, mentionsMe: true })).toBe(true);
    expect(invoke).toHaveBeenCalledWith('notify_native_message', {
      groupId: 'grp-aaaa-bbbb',
      senderId: 'peer-1',
      senderName: 'Alice',
      groupName: '',
      body: 'Hello',
      mentionsMe: true,
      // THE SENDER'S OWN INSTANT, and it is load-bearing rather than cosmetic: it is the only
      // thing by which the builder recognises that the push and this frame are one message.
      sentAt: 1_700_000_000_000,
      // The server's instant of the same message: what the shade's read mark is stated on.
      serverAt: 1_700_000_000_400,
      // One real banner answers up to this many refused pushes (the batched flush).
      covers: 1,
      authorProven: false,
      // The push's `isGroup`: the name cannot answer it for an unnamed group (review of #3344, M1).
      isGroup: false,
      // A message, not a reaction: the builder picks the messages or mentions channel.
      reaction: false,
    });
  });

  it('carries "not said" as null rather than as a direct message', async () => {
    isAndroidTauriRuntime.mockReturnValue(true);
    invoke.mockResolvedValue(true);

    await postNativeMessageNotification({ ...NOTIF, isGroup: null });
    expect(invoke).toHaveBeenCalledWith(
      'notify_native_message',
      expect.objectContaining({ isGroup: null })
    );
  });

  it("carries the open's proof of the author, which names a salon banner's speaker", async () => {
    // The push trigger names the speaker only when its native open PROVED the author (a v2
    // session); this trigger must carry the same fact or the two would draw two speakers for one
    // message, whichever arrived second winning (review of #2881, HIGH-1).
    isAndroidTauriRuntime.mockReturnValue(true);
    invoke.mockResolvedValue(true);

    await postNativeMessageNotification({
      ...NOTIF,
      conversationId: 'channel_0001',
      groupName: 'general',
      authorProven: true,
    });
    expect(invoke).toHaveBeenCalledWith(
      'notify_native_message',
      expect.objectContaining({ groupId: 'channel_0001', authorProven: true })
    );
  });

  it('reports a refusal instead of raising something else', async () => {
    isAndroidTauriRuntime.mockReturnValue(true);
    invoke.mockResolvedValue(false);

    expect(await postNativeMessageNotification(NOTIF)).toBe(false);
  });

  it('reports a throw instead of falling back to the plain builder', async () => {
    isAndroidTauriRuntime.mockReturnValue(true);
    invoke.mockRejectedValue(new Error('no JavaVM'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await postNativeMessageNotification(NOTIF)).toBe(false);
    // A FALLBACK IS A SIGNAL, NEVER A PATH: reaching here means the one builder failed, and the
    // only thing this layer owes is to say so where it accuses.
    expect(error).toHaveBeenCalledWith(expect.stringContaining('no JavaVM'));
    error.mockRestore();
  });
});

describe('postNativeReactionNotification', () => {
  beforeEach(() => {
    invoke.mockReset();
    isAndroidTauriRuntime.mockReset();
  });

  const REACTION = {
    conversationId: 'grp-aaaa-bbbb',
    messageId: 'msg-1',
    actorId: 'peer-1',
    actorName: 'Alice',
    emoji: '❤️',
    at: 1_700_000_000_123,
  };

  it('does not reach the native builder off Android', async () => {
    isAndroidTauriRuntime.mockReturnValue(false);
    expect(await postNativeReactionNotification(REACTION)).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('asks the ONE builder with the reaction flag, the emoji as the body and the push shape', async () => {
    // The frame trigger of a reaction (2026-11-17): the same command a message takes, so Kotlin
    // composes the push's own sentence (`notif_reaction_body`) on the reactions channel under
    // `reaction:<groupId>` - the key the push posts under too.
    isAndroidTauriRuntime.mockReturnValue(true);
    invoke.mockResolvedValue(true);

    expect(await postNativeReactionNotification(REACTION)).toBe(true);
    expect(invoke).toHaveBeenCalledWith('notify_native_message', {
      groupId: 'grp-aaaa-bbbb',
      senderId: 'peer-1',
      senderName: 'Alice',
      groupName: '',
      body: '❤️',
      mentionsMe: false,
      // The reaction's own instant, which the push carries too: one reaction, one line.
      sentAt: 1_700_000_000_123,
      serverAt: 0,
      covers: 1,
      authorProven: false,
      isGroup: null,
      reaction: true,
    });
  });

  it('reports a throw where it accuses, and raises nothing else', async () => {
    isAndroidTauriRuntime.mockReturnValue(true);
    invoke.mockRejectedValue(new Error('no JavaVM'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await postNativeReactionNotification(REACTION)).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('no JavaVM'));
    error.mockRestore();
  });
});

describe('notificationIsGroup', () => {
  it('reads the type, never the name: a group and a salon are groups, a DM is not', () => {
    expect(notificationIsGroup('group')).toBe(true);
    expect(notificationIsGroup('channel')).toBe(true);
    expect(notificationIsGroup('direct')).toBe(false);
  });

  it('is null for a row with no type - unknown, as the push says it', () => {
    expect(notificationIsGroup(undefined)).toBeNull();
  });
});

describe('notificationGroupName', () => {
  it('is EMPTY for a direct message', () => {
    // The server's own contract for `groupName` in a push payload, mirrored here so that neither
    // trigger has to be told which of the two it is.
    expect(notificationGroupName('direct', 'peer-1', 'me::peer-1')).toBe('');
  });

  it('is the group title for a group', () => {
    expect(notificationGroupName('group', 'Les gourmands', 'grp-1')).toBe('Les gourmands');
  });

  it('titles a channel with the channel name, not the raw conversation id', () => {
    // Every channel row builder in `useChannelWorkspaces.svelte.ts` keeps `contactName` as the
    // raw `channel_<uuid>` id (the key seed routing reads) and puts the real name in `name` - the
    // reverse of a plain group. A notification titled with `contactName` here read as
    // "channel_<uuid>" on screen instead of the channel's name.
    expect(notificationGroupName('channel', 'channel_1', 'general')).toBe('general');
  });

  it('falls back to the raw id when a channel has no name yet', () => {
    expect(notificationGroupName('channel', 'channel_1', '')).toBe('channel_1');
  });

  it('falls back to the stored name when there is no auxiliary label', () => {
    expect(notificationGroupName('group', '', 'grp-1')).toBe('grp-1');
  });

  it("titles a group as the list draws it - an unnamed group by its members' first names", () => {
    // The row of an unnamed group holds only its id; the list names it "Alice et Bob".
    expect(notificationGroupName('group', 'grp-1', 'grp-1', 'Alice et Bob')).toBe('Alice et Bob');
  });

  it('never lets a group title rename a channel or title a direct message', () => {
    expect(notificationGroupName('channel', 'channel_1', 'general', 'X')).toBe('general');
    expect(notificationGroupName('direct', 'peer-1', 'me::peer-1', 'X')).toBe('');
  });
});

describe('composePlainNotificationText', () => {
  // The preview is a Paraglide string (`previewForMedia`), so both locales reach here as a plain string.
  it.each([
    ['fr', '📷 Photo'],
    ['en', '📷 Photo'],
  ])('titles a group by its name and leads the body with the speaker (%s)', (_locale, preview) => {
    expect(
      composePlainNotificationText('Alice', preview, { groupName: 'Les Canaris', isGroup: true })
    ).toEqual({ title: 'Les Canaris', body: `Alice: ${preview}` });
  });

  it('keeps the sender as the title of a direct message', () => {
    expect(
      composePlainNotificationText('Alice', '[Media]', { groupName: '', isGroup: false })
    ).toEqual({ title: 'Alice', body: '[Media]' });
  });

  it('keeps the sender as the title when a group has no name to show', () => {
    expect(
      composePlainNotificationText('Alice', '[Media]', { groupName: '  ', isGroup: true })
    ).toEqual({ title: 'Alice', body: '[Media]' });
  });

  it('never titles a conversation typed direct by a stale name', () => {
    expect(
      composePlainNotificationText('Alice', 'hi', { groupName: 'Alice', isGroup: false })
    ).toEqual({ title: 'Alice', body: 'hi' });
  });

  it('is the input untouched when the call carries nothing native (a call site without a row)', () => {
    expect(composePlainNotificationText('Alice', 'hi')).toEqual({ title: 'Alice', body: 'hi' });
  });
});

/**
 * THE SECOND TRIGGER OF THE CANCEL (owner's report, 2026-11-20): a read this WebView learned over its
 * socket was never pushed (the server pushes only an un-ACKed frame), so the banner it had posted
 * stayed. The seam is pinned: the conversation id the post used, the mark and the event reach the command.
 */
describe('recordNativeReadElsewhere', () => {
  beforeEach(() => {
    invoke.mockReset();
    isAndroidTauriRuntime.mockReset();
  });

  it('asks the native side to remove the banner, under the key the post used', async () => {
    isAndroidTauriRuntime.mockReturnValue(true);
    invoke.mockResolvedValue(true);

    expect(await recordNativeReadElsewhere('channel_c1', 'channel.read', 200, 'stamped')).toBe(
      true
    );
    expect(invoke).toHaveBeenCalledExactlyOnceWith('record_read_elsewhere', {
      groupId: 'channel_c1',
      at: 200,
      serverClock: false,
      reason: 'channel.read',
    });
  });

  // The mark travels with the cancel: Kotlin records it and refuses a post still on its way.
  it('hands the mark over on the clock it is on', async () => {
    isAndroidTauriRuntime.mockReturnValue(true);
    invoke.mockResolvedValue(true);

    await recordNativeReadElsewhere('g1', 'read_watermark', 1234.7, 'server');
    expect(invoke).toHaveBeenCalledExactlyOnceWith('record_read_elsewhere', {
      groupId: 'g1',
      at: 1234,
      serverClock: true,
      reason: 'read_watermark',
    });
  });

  // This device's own reader opening the conversation is the cancel's third trigger.
  it('hands over the reading of THIS device, under the same command', async () => {
    isAndroidTauriRuntime.mockReturnValue(true);
    invoke.mockResolvedValue(true);

    await recordNativeReadElsewhere('g1', 'read_here', 50, 'server');
    expect(invoke).toHaveBeenCalledExactlyOnceWith('record_read_elsewhere', {
      groupId: 'g1',
      at: 50,
      serverClock: true,
      reason: 'read_here',
    });
  });

  // An ended conversation (deleted, left, excluded) takes its banner and reaction with it: the mark
  // covers every line a banner can hold.
  it('hands over an ended conversation with a mark that covers every line', async () => {
    isAndroidTauriRuntime.mockReturnValue(true);
    invoke.mockResolvedValue(true);

    expect(
      await handOverConversationEvent(
        'channel_c1',
        'conversation_ended',
        ENDED_CONVERSATION_MARK,
        'server'
      )
    ).toBe(true);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('record_read_elsewhere', {
      groupId: 'channel_c1',
      at: Number.MAX_SAFE_INTEGER,
      serverClock: true,
      reason: 'conversation_ended',
    });
  });

  // iOS keeps no mark: the native side removes the conversation's delivered notifications by thread.
  it('hands an opened or ended conversation to the iOS notification centre', async () => {
    isAndroidTauriRuntime.mockReturnValue(false);
    isIosTauriRuntime.mockReturnValue(true);
    invoke.mockResolvedValue(true);

    expect(await handOverConversationEvent('g1', 'read_here', 10, 'server')).toBe(true);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('cancel_conversation_notifications', {
      groupId: 'g1',
      reason: 'read_here',
    });
    isIosTauriRuntime.mockReturnValue(false);
  });

  it('accuses a refusal or a throw of the iOS hand-over, and says it failed', async () => {
    isIosTauriRuntime.mockReturnValue(true);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    invoke.mockResolvedValueOnce(false);
    expect(await cancelNativeConversationNotifications('g1', 'conversation_ended')).toBe(false);
    invoke.mockRejectedValueOnce(new Error('no class'));
    expect(await cancelNativeConversationNotifications('g1', 'conversation_ended')).toBe(false);
    expect(error).toHaveBeenCalledTimes(2);
    isIosTauriRuntime.mockReturnValue(false);
    error.mockRestore();
  });

  it('invokes nothing on iOS commands off iOS', async () => {
    isIosTauriRuntime.mockReturnValue(false);
    expect(await cancelNativeConversationNotifications('g1', 'read_here')).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('has nothing to hand over off Android, and nothing failed', async () => {
    isAndroidTauriRuntime.mockReturnValue(false);
    expect(await handOverConversationEvent('g1', 'read_here', 10, 'server')).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('invokes nothing off Android, where there is no native banner', async () => {
    isAndroidTauriRuntime.mockReturnValue(false);

    expect(await recordNativeReadElsewhere('g1', 'read_watermark', 1, 'server')).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('says so, at a level that accuses, when the native side refuses or throws', async () => {
    isAndroidTauriRuntime.mockReturnValue(true);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    invoke.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('no JavaVM'));

    expect(await recordNativeReadElsewhere('g1', 'read_watermark', 1, 'server')).toBe(false);
    expect(await recordNativeReadElsewhere('g1', 'read_watermark', 1, 'server')).toBe(false);
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });
});
