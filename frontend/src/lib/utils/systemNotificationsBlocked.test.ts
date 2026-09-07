import { systemNotificationsBlocked } from './systemNotificationsBlocked';

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
