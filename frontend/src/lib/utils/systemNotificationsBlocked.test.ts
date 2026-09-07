import {
  resetSystemNotificationsAnnouncementForTests,
  systemNotificationsBlocked,
  systemNotificationsBlockedAnnounceOnce,
} from './systemNotificationsBlocked';

const isTauriRuntime = vi.hoisted(() => vi.fn());
vi.mock('$lib/utils/openExternal', () => ({ isTauriRuntime }));

/** Replaces `window.Notification` with a stub reporting `permission`, or removes it entirely. */
function withPermission(permission: NotificationPermission | null) {
  if (permission === null) {
    Reflect.deleteProperty(window, 'Notification');
    return;
  }
  Object.defineProperty(window, 'Notification', {
    value: { permission },
    configurable: true,
    writable: true,
  });
}

describe('systemNotificationsBlocked', () => {
  beforeEach(() => {
    isTauriRuntime.mockReset();
    isTauriRuntime.mockReturnValue(false);
  });

  it('is true only for a web session the browser has permanently refused', () => {
    withPermission('denied');
    expect(systemNotificationsBlocked()).toBe(true);
  });

  it('is FALSE for "default", because asking has not happened and can still succeed', () => {
    // The distinction this predicate exists for. Collapsing the two is what would silence the
    // permission prompt entirely, which is a worse defect than the noise it was written to remove.
    withPermission('default');
    expect(systemNotificationsBlocked()).toBe(false);
  });

  it('is false once granted', () => {
    withPermission('granted');
    expect(systemNotificationsBlocked()).toBe(false);
  });

  it('is false under Tauri EVEN WHEN the web permission says denied', () => {
    // Under Tauri the plugin owns permission and the web value says nothing about it, so a native
    // run must fall through to the plugin path. Returning true here would silence notifications on
    // both mobile platforms for any WebView that happens to report `denied`.
    isTauriRuntime.mockReturnValue(true);
    withPermission('denied');
    expect(systemNotificationsBlocked()).toBe(false);
  });

  it('is false where the engine exposes no Notification API at all', () => {
    // Absent is not refused: that case has its own line further down the real path, and answering
    // "blocked" here would take it away.
    withPermission(null);
    expect(systemNotificationsBlocked()).toBe(false);
  });
});

describe('systemNotificationsBlockedAnnounceOnce', () => {
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    isTauriRuntime.mockReset();
    isTauriRuntime.mockReturnValue(false);
    resetSystemNotificationsAnnouncementForTests();
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => log.mockRestore());

  it('SAYS IT ONCE and then stays silent, however many messages arrive', () => {
    // The whole point. Before this seam a denied device printed three lines PER MESSAGE - 33 for 12
    // messages, measured on HEAL-REVOKE-9.
    withPermission('denied');
    for (let i = 0; i < 12; i++) expect(systemNotificationsBlockedAnnounceOnce()).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toContain('denied');
  });

  it('SAYS IT AT ALL - silence would make "refused" and "never ran" the same observation', () => {
    // The regression this file exists to prevent, and it was really made: the first version of the
    // fix returned early in `useMessaging` before anything could announce, so the run went from 33
    // lines to ZERO and nothing attributed the silence. Zero is not the target; one is.
    withPermission('denied');
    systemNotificationsBlockedAnnounceOnce();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('says nothing at all when notifications are not blocked', () => {
    withPermission('granted');
    expect(systemNotificationsBlockedAnnounceOnce()).toBe(false);
    withPermission('default');
    expect(systemNotificationsBlockedAnnounceOnce()).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });

  it('agrees with the pure predicate, so the two can never drift', () => {
    for (const p of ['denied', 'granted', 'default'] as NotificationPermission[]) {
      resetSystemNotificationsAnnouncementForTests();
      withPermission(p);
      expect(systemNotificationsBlockedAnnounceOnce()).toBe(systemNotificationsBlocked());
    }
  });
});
