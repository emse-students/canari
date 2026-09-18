const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const isAndroidTauriRuntime = vi.fn();
vi.mock('$lib/utils/appVersion', () => ({
  isAndroidTauriRuntime: () => isAndroidTauriRuntime(),
}));

import {
  notificationGroupName,
  postNativeMessageNotification,
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
    expect(invoke).toHaveBeenCalledWith('notifier_message_natif', {
      groupId: 'grp-aaaa-bbbb',
      senderId: 'peer-1',
      senderName: 'Alice',
      groupName: '',
      body: 'Hello',
      mentionsMe: true,
      // THE SENDER'S OWN INSTANT, and it is load-bearing rather than cosmetic: it is the only
      // thing by which the builder recognises that the push and this frame are one message.
      sentAt: 1_700_000_000_000,
    });
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

describe('notificationGroupName', () => {
  it('is EMPTY for a direct message', () => {
    // The server's own contract for `groupName` in a push payload, mirrored here so that neither
    // trigger has to be told which of the two it is.
    expect(notificationGroupName('direct', 'peer-1', 'me::peer-1')).toBe('');
  });

  it('is the group title for a group', () => {
    expect(notificationGroupName('group', 'Les gourmands', 'grp-1')).toBe('Les gourmands');
  });

  it('titles a channel like a group', () => {
    expect(notificationGroupName('channel', 'general', 'channel_1')).toBe('general');
  });

  it('falls back to the stored name when there is no auxiliary label', () => {
    expect(notificationGroupName('group', '', 'grp-1')).toBe('grp-1');
  });
});
